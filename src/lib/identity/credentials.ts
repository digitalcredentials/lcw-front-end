import { readLogFromString, resolveDIDFromLog, updateDID, deriveNextKeyHash, logToJsonlString, type DIDLog } from '@interop/did-method-webvh'
import type { WasClient } from '@interop/was-client'
import { multibaseOf, multibaseOfSeed, signingAgents, updateKeyFromSeed, type CredentialKeys } from './keys'
import { publishProjection } from './account'

// Adding a credential to the account: its signing key joins the account
// document, and its update key joins the log's update keys, in two entries,
// as prerotation requires (a new update key must hash into the PREVIOUS
// entry's nextKeyHashes):
//
//   1. Commit: an entry that changes nothing but nextKeyHashes, which gains
//      the new credential's update-key and staged-key hashes.
//   2. Add: an entry adding the new signing key under the four signing
//      relationships and the new update key to updateKeys.
//
// Both are signed by the acting credential's update key, which the session
// does not hold: the caller unwrapped it for this operation alone. Every
// entry carries the carry-over commitments (each authorized key's own hash
// beside its staged hash), so a later non-rotating entry can follow. The
// publish is a compare-and-swap on the log read it was built on.

const ID_COLLECTION = 'id'
const LOG_RESOURCE = 'did.jsonl'
const SIGNING_RELATIONS = ['authentication', 'assertionMethod', 'capabilityInvocation', 'capabilityDelegation'] as const

export interface NewCredentialPublicKeys {
  signingMultibase: string
  updateMultibase: string
  stagedMultibase: string
}

// The public halves of a freshly minted credential.
export async function publicKeysOf(keys: CredentialKeys): Promise<NewCredentialPublicKeys> {
  const agents = await signingAgents(keys.signingSeed)
  const update = await updateKeyFromSeed(keys.updateSeed)
  return {
    signingMultibase: multibaseOf(agents.controllerDid),
    updateMultibase: update.multibase,
    stagedMultibase: await multibaseOfSeed(keys.stagedSeed),
  }
}

type Doc = {
  verificationMethod?: { type?: string; publicKeyMultibase?: string }[]
  keyAgreement?: unknown[]
} & Record<string, unknown>

// A relationship's entries as the driver takes them back: relative ids.
function relativeIds(doc: Doc, relation: string): string[] {
  return ((doc[relation] as unknown[] | undefined) ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { id?: string })?.id))
    .filter((id): id is string => typeof id === 'string')
    .map((id) => (id.includes('#') ? `#${id.split('#')[1]}` : id))
}

// The log lists update keys as bare multikeys; a did:key form may precede
// the multibase when one is stated, so comparisons are made bare.
const bare = (key: string) => key.replace(/^did:key:/, '')

// The account log, read with its validator for a compare-and-swap write.
export async function readAccountLog({ was, spaceId }: { was: WasClient; spaceId: string }): Promise<{ log: DIDLog; etag?: string }> {
  const resource = was.space(spaceId).collection(ID_COLLECTION, { encryption: 'plaintext' }).resource(LOG_RESOURCE)
  const read = await resource.getWithEtag()
  if (!read) {
    throw new Error('The account log could not be read.')
  }
  const text = typeof read.data === 'string' ? read.data : read.data instanceof Blob ? await read.data.text() : JSON.stringify(read.data)
  return { log: readLogFromString(text), etag: read.etag }
}

// A credential as the log records it: the signing key the current document
// lists, the update key that joined the log in the same entry, the staged
// key's commitment, and when that entry was made. The document does not say
// what kind of credential a key belongs to; the account's catalogue
// (catalogue.ts) does, and the two are joined by signing key.
export interface LoggedCredential {
  signingMultibase: string
  // Null when the entry that added the signing key did not add exactly one
  // update key, in which case the credential cannot be removed by this code.
  updateMultibase: string | null
  stagedHash: string | null
  addedAt: string
}

// The credentials the log's current document lists, each paired with the
// update key and the staged-key commitment that joined the log with it.
// Parameters are inherited along the log when an entry omits them, so the
// effective update keys and commitments are tracked entry by entry.
export async function credentialsInLog(log: DIDLog): Promise<LoggedCredential[]> {
  const signingKeysOf = (state: Doc | undefined) => (state ? relativeIds(state, 'capabilityInvocation').map((id) => id.replace(/^#/, '')) : [])
  let updateKeys: string[] = []
  let nextKeyHashes: string[] = []
  const history: { signing: string[]; updateKeys: string[]; nextKeyHashes: string[] }[] = []
  for (const entry of log) {
    if (entry.parameters?.updateKeys !== undefined) {
      updateKeys = entry.parameters.updateKeys.map(bare)
    }
    if (entry.parameters?.nextKeyHashes !== undefined) {
      nextKeyHashes = entry.parameters.nextKeyHashes
    }
    history.push({ signing: signingKeysOf(entry.state as Doc | undefined), updateKeys, nextKeyHashes })
  }
  const last = history[history.length - 1]
  if (!last) {
    return []
  }
  const found: LoggedCredential[] = []
  for (const signingMultibase of last.signing) {
    const at = history.findIndex((step) => step.signing.includes(signingMultibase))
    const before = history[at - 1] ?? { signing: [], updateKeys: [], nextKeyHashes: [] }
    const addedUpdate = history[at].updateKeys.filter((key) => !before.updateKeys.includes(key) && last.updateKeys.includes(key))
    const updateMultibase = addedUpdate.length === 1 ? addedUpdate[0] : null
    let stagedHash: string | null = null
    if (updateMultibase) {
      // The commitments that arrived with this credential (its commit entry,
      // when one preceded, and its add entry), less its update key's own hash
      // and every current update key's hash: the one left is its staged key's.
      const earlier = history[at - 2] ?? { nextKeyHashes: [] as string[] }
      const arrived = new Set([...history[at].nextKeyHashes, ...before.nextKeyHashes].filter((hash) => !earlier.nextKeyHashes.includes(hash)))
      for (const key of last.updateKeys) {
        arrived.delete(await deriveNextKeyHash(key))
      }
      const staged = [...arrived].filter((hash) => last.nextKeyHashes.includes(hash))
      stagedHash = staged.length === 1 ? staged[0] : null
    }
    found.push({ signingMultibase, updateMultibase, stagedHash, addedAt: log[at]?.versionTime ?? '' })
  }
  return found
}

// What removing a credential needs: its signing and update keys, and the
// staged key's commitment (as a hash, or as the key it was derived from).
export interface RemovableCredential {
  signingMultibase: string
  updateMultibase: string
  stagedMultibase?: string
  stagedHash?: string | null
}

export async function addCredentialToLog({
  was,
  spaceId,
  did,
  acting,
  added,
}: {
  // A client that may write the Space's id collection (signed as the account)
  was: WasClient
  spaceId: string
  did: string
  // The acting credential's keys; only its update seed is used
  acting: Pick<CredentialKeys, 'updateSeed'>
  added: NewCredentialPublicKeys
}): Promise<void> {
  const resource = was.space(spaceId).collection(ID_COLLECTION, { encryption: 'plaintext' }).resource(LOG_RESOURCE)
  const read = await resource.getWithEtag()
  if (!read) {
    throw new Error('The account log could not be read.')
  }
  const text = typeof read.data === 'string' ? read.data : read.data instanceof Blob ? await read.data.text() : JSON.stringify(read.data)
  const log = readLogFromString(text)
  const current = await resolveDIDFromLog(log)
  if (current.did !== did || !current.doc) {
    throw new Error('The account log does not resolve to the account.')
  }
  const doc = current.doc as Doc
  const signer = (await updateKeyFromSeed(acting.updateSeed)).logSigner

  const hashes = new Set<string>(current.meta.nextKeyHashes ?? [])
  hashes.add(await deriveNextKeyHash(added.updateMultibase))
  hashes.add(await deriveNextKeyHash(added.stagedMultibase))
  const nextKeyHashes = [...hashes]

  const commit = await updateDID({ log, signer, updateKeys: current.meta.updateKeys, nextKeyHashes })

  const verificationMethods = [
    ...(doc.verificationMethod ?? []).map((method) => ({ type: 'Multikey', publicKeyMultibase: method.publicKeyMultibase ?? '' })),
    { type: 'Multikey', publicKeyMultibase: added.signingMultibase },
  ]
  const relations = Object.fromEntries(
    SIGNING_RELATIONS.map((relation) => [relation, [...relativeIds(doc, relation), `#${added.signingMultibase}`]])
  )
  const add = await updateDID({
    log: commit.log,
    signer,
    updateKeys: [...current.meta.updateKeys, `did:key:${added.updateMultibase}`],
    nextKeyHashes,
    verificationMethods,
    vmIdFragment: 'multibase',
    keyAgreement: relativeIds(doc, 'keyAgreement'),
    ...relations,
  })

  await resource.put(new TextEncoder().encode(logToJsonlString(add.log)), { contentType: 'text/jsonl', ifMatch: read.etag })
  await publishProjection({ was, spaceId, log: add.log })
}

// Removing a credential: one entry that drops its signing key from the
// document and its update key (and the staged key's commitment) from the
// log, signed by an acting credential's update key, which must be another
// credential's or at least still authorized by the entry's predecessor. The
// removed credential's keys stop being listed; whoever held them can no
// longer sign for the account once the servers' caches expire. The same
// entry replaces the account's user key under keyAgreement (`userKey`:
// the retiring and the new X25519 multibase), since the removed credential
// held the old one.
export async function removeCredentialFromLog({
  was,
  spaceId,
  did,
  acting,
  removed,
  userKey,
}: {
  was: WasClient
  spaceId: string
  did: string
  acting: Pick<CredentialKeys, 'updateSeed'>
  removed: RemovableCredential
  userKey?: { retire: string; add: string }
}): Promise<void> {
  const resource = was.space(spaceId).collection(ID_COLLECTION, { encryption: 'plaintext' }).resource(LOG_RESOURCE)
  const { log, etag } = await readAccountLog({ was, spaceId })
  const current = await resolveDIDFromLog(log)
  if (current.did !== did || !current.doc) {
    throw new Error('The account log does not resolve to the account.')
  }
  const doc = current.doc as Doc
  const remainingUpdateKeys = current.meta.updateKeys.filter((key: string) => bare(key) !== removed.updateMultibase)
  if (remainingUpdateKeys.length === current.meta.updateKeys.length) {
    throw new Error('That credential is not part of the account.')
  }
  const actingMultibase = (await updateKeyFromSeed(acting.updateSeed)).multibase
  if (actingMultibase === removed.updateMultibase || !remainingUpdateKeys.some((key: string) => bare(key) === actingMultibase)) {
    throw new Error('A credential cannot be removed by itself.')
  }
  const stagedHash = removed.stagedHash ?? (removed.stagedMultibase ? await deriveNextKeyHash(removed.stagedMultibase) : null)
  const dropped = new Set([await deriveNextKeyHash(removed.updateMultibase), ...(stagedHash ? [stagedHash] : [])])
  const nextKeyHashes = (current.meta.nextKeyHashes ?? []).filter((hash: string) => !dropped.has(hash))
  const signer = (await updateKeyFromSeed(acting.updateSeed)).logSigner

  const verificationMethods = (doc.verificationMethod ?? [])
    .filter((method) => method.publicKeyMultibase !== removed.signingMultibase && method.publicKeyMultibase !== userKey?.retire)
    .map((method) => ({ type: 'Multikey', publicKeyMultibase: method.publicKeyMultibase ?? '' }))
  if (userKey) {
    verificationMethods.push({ type: 'Multikey', publicKeyMultibase: userKey.add })
  }
  const relations = Object.fromEntries(
    SIGNING_RELATIONS.map((relation) => [relation, relativeIds(doc, relation).filter((id) => id !== `#${removed.signingMultibase}`)])
  )
  const keyAgreement = userKey
    ? [...relativeIds(doc, 'keyAgreement').filter((id) => id !== `#${userKey.retire}`), `#${userKey.add}`]
    : relativeIds(doc, 'keyAgreement')
  const next = await updateDID({
    log,
    signer,
    updateKeys: remainingUpdateKeys,
    nextKeyHashes,
    verificationMethods,
    vmIdFragment: 'multibase',
    keyAgreement,
    ...relations,
  })
  await resource.put(new TextEncoder().encode(logToJsonlString(next.log)), { contentType: 'text/jsonl', ifMatch: etag })
  await publishProjection({ was, spaceId, log: next.log })
}
