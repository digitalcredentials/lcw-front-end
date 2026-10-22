import { readLogFromString, resolveDIDFromLog, updateDID, deriveNextKeyHash, logToJsonlString } from '@interop/did-method-webvh'
import type { WasClient } from '@interop/was-client'
import { multibaseOf, multibaseOfSeed, signingAgents, updateKeyFromSeed, type CredentialKeys } from './keys'

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
}

// Removing a credential: one entry that drops its signing key from the
// document and its update key (and the staged key's commitment) from the
// log, signed by an acting credential's update key, which must be another
// credential's or at least still authorized by the entry's predecessor. The
// removed credential's keys stop being listed; whoever held them can no
// longer sign for the account once the servers' caches expire.
export async function removeCredentialFromLog({
  was,
  spaceId,
  did,
  acting,
  removed,
}: {
  was: WasClient
  spaceId: string
  did: string
  acting: Pick<CredentialKeys, 'updateSeed'>
  removed: NewCredentialPublicKeys
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
  // The log lists update keys as bare multikeys; a did:key form may precede
  // the multibase when one is stated, so both sides are compared bare.
  const bare = (key: string) => key.replace(/^did:key:/, '')
  const remainingUpdateKeys = current.meta.updateKeys.filter((key: string) => bare(key) !== removed.updateMultibase)
  if (remainingUpdateKeys.length === current.meta.updateKeys.length) {
    throw new Error('That credential is not part of the account.')
  }
  const actingMultibase = (await updateKeyFromSeed(acting.updateSeed)).multibase
  if (actingMultibase === removed.updateMultibase || !remainingUpdateKeys.some((key: string) => bare(key) === actingMultibase)) {
    throw new Error('A credential cannot be removed by itself.')
  }
  const dropped = new Set([await deriveNextKeyHash(removed.updateMultibase), await deriveNextKeyHash(removed.stagedMultibase)])
  const nextKeyHashes = (current.meta.nextKeyHashes ?? []).filter((hash: string) => !dropped.has(hash))
  const signer = (await updateKeyFromSeed(acting.updateSeed)).logSigner

  const verificationMethods = (doc.verificationMethod ?? [])
    .filter((method) => method.publicKeyMultibase !== removed.signingMultibase)
    .map((method) => ({ type: 'Multikey', publicKeyMultibase: method.publicKeyMultibase ?? '' }))
  const relations = Object.fromEntries(
    SIGNING_RELATIONS.map((relation) => [relation, relativeIds(doc, relation).filter((id) => id !== `#${removed.signingMultibase}`)])
  )
  const next = await updateDID({
    log,
    signer,
    updateKeys: remainingUpdateKeys,
    nextKeyHashes,
    verificationMethods,
    vmIdFragment: 'multibase',
    keyAgreement: relativeIds(doc, 'keyAgreement'),
    ...relations,
  })
  await resource.put(new TextEncoder().encode(logToJsonlString(next.log)), { contentType: 'text/jsonl', ifMatch: read.etag })
}
