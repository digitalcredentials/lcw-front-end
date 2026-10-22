import { createDID, deriveNextKeyHash, generateParallelDidWeb, logToJsonlString, readLogFromString, resolveDIDFromLog, type DIDLog } from '@interop/did-method-webvh'
import { ensurePromotedSpaceController } from '@interop/wallet-core/genesis'
import type { WasClient } from '@interop/was-client'
import type { UpdateKey } from './keys'

// The account's did:webvh: its log lives in the Main Space's world-readable
// `id` collection and is served through the identity domain, so the DID is
// did:webvh:{scid}:{idDomain}:{spaceId}. The document lists one signing key
// per credential under every signing relationship and the account's user
// key under keyAgreement; the log's update keys are the credentials'.
// Beside the log sits its did:web projection, `did.json`: the same document
// under did:web:{idDomain}:{spaceId} (alsoKnownAs the did:webvh), which the
// identity domain serves at /{spaceId}/did.json, so the account can also be
// a holder for issuers and verifiers that resolve did:web but not did:webvh.

const ID_COLLECTION = 'id'
const LOG_RESOURCE = 'did.jsonl'
const PROJECTION_RESOURCE = 'did.json'

const RELATIONS = ['authentication', 'assertionMethod', 'keyAgreement', 'capabilityInvocation', 'capabilityDelegation']

// A did:webvh document writes relationship entries and method ids as
// `#fragment`, relative to its own id. Generic did:web consumers (the
// issuers' proof-purpose checks among them) compare them to a proof's
// absolute verification method id, so the projection carries absolute ids.
function absoluteIds(doc: Record<string, unknown>): Record<string, unknown> {
  const id = doc.id as string
  const absolute = (value: unknown) => (typeof value === 'string' && value.startsWith('#') ? `${id}${value}` : value)
  const out: Record<string, unknown> = { ...doc }
  for (const relation of RELATIONS) {
    const entries = doc[relation]
    if (Array.isArray(entries)) {
      out[relation] = entries.map((entry) =>
        typeof entry === 'string' ? absolute(entry) : { ...(entry as Record<string, unknown>), id: absolute((entry as { id?: unknown }).id) }
      )
    }
  }
  if (Array.isArray(doc.verificationMethod)) {
    out.verificationMethod = doc.verificationMethod.map((method) => ({
      ...(method as Record<string, unknown>),
      id: absolute((method as { id?: unknown }).id),
    }))
  }
  return out
}

// The did:web projection of the log's current document.
export async function projectionOf(log: DIDLog): Promise<Record<string, unknown>> {
  const current = await resolveDIDFromLog(log)
  if (!current.doc) {
    throw new Error('The account log does not resolve to a document.')
  }
  return absoluteIds(generateParallelDidWeb(current.did, current.doc) as Record<string, unknown>)
}

// Writes the projection of `log` into the Space's `id` collection, beside
// the log. Called after every log write; a projection older than the log
// only lacks the latest keys until the next write, so it is best effort.
export async function publishProjection({ was, spaceId, log }: { was: WasClient; spaceId: string; log: DIDLog }): Promise<void> {
  const doc = await projectionOf(log)
  await was
    .space(spaceId)
    .collection(ID_COLLECTION, { encryption: 'plaintext' })
    .resource(PROJECTION_RESOURCE)
    .put(new TextEncoder().encode(JSON.stringify(doc)), { contentType: 'application/did+json' })
}

// Writes the projection when the Space's differs from the log's current
// document (an account created before projections were published, or a
// projection a failed write left behind). Resolves to whether one was written.
export async function ensureProjection({ was, spaceId }: { was: WasClient; spaceId: string }): Promise<boolean> {
  const id = was.space(spaceId).collection(ID_COLLECTION, { encryption: 'plaintext' })
  const read = await id.resource(LOG_RESOURCE).getWithEtag()
  if (!read) {
    throw new Error('The account log could not be read.')
  }
  const text = typeof read.data === 'string' ? read.data : read.data instanceof Blob ? await read.data.text() : JSON.stringify(read.data)
  const log = readLogFromString(text)
  const wanted = await projectionOf(log)
  const served = await id.resource(PROJECTION_RESOURCE).getWithEtag()
  const servedDoc = served && !(served.data instanceof Blob) ? (typeof served.data === 'string' ? JSON.parse(served.data) : served.data) : null
  if (servedDoc && JSON.stringify(servedDoc) === JSON.stringify(wanted)) {
    return false
  }
  await publishProjection({ was, spaceId, log })
  return true
}

export async function createAccountLog({
  idDomain,
  spaceId,
  signingMultibase,
  userKeyMultibase,
  updateKey,
  stagedMultibase,
}: {
  idDomain: string
  spaceId: string
  signingMultibase: string
  userKeyMultibase: string
  updateKey: UpdateKey
  stagedMultibase: string
}): Promise<{ did: string; jsonl: string }> {
  const signing = [`#${signingMultibase}`]
  const { did, log } = await createDID({
    address: idDomain,
    paths: [spaceId],
    signer: updateKey.logSigner,
    updateKeys: [updateKey.didKey],
    // The carry-over convention: the active key's own hash beside the staged
    // key's, so a later entry may re-state the active key (an addition
    // commit) as well as rotate to the staged one.
    nextKeyHashes: [await deriveNextKeyHash(updateKey.multibase), await deriveNextKeyHash(stagedMultibase)],
    verificationMethods: [
      { type: 'Multikey', publicKeyMultibase: signingMultibase },
      { type: 'Multikey', publicKeyMultibase: userKeyMultibase },
    ],
    vmIdFragment: 'multibase',
    portable: true,
    authentication: signing,
    assertionMethod: signing,
    capabilityInvocation: signing,
    capabilityDelegation: signing,
    keyAgreement: [`#${userKeyMultibase}`],
  })
  return { did, jsonl: logToJsonlString(log) }
}

// Publishes the log and its did:web projection into the Space's `id`
// collection and makes that collection world-readable, which is what lets
// the identity domain serve them to resolvers. `was` signs as the Space's
// current controller.
export async function publishAccountLog({ was, spaceId, jsonl }: { was: WasClient; spaceId: string; jsonl: string }): Promise<void> {
  const id = was.space(spaceId).collection(ID_COLLECTION, { encryption: 'plaintext' })
  await id.resource(LOG_RESOURCE).put(new TextEncoder().encode(jsonl), { contentType: 'text/jsonl' })
  await publishProjection({ was, spaceId, log: readLogFromString(jsonl) })
  await id.setPublic()
}

// Moves the Space's controller from the signing did:key to the did:webvh.
// Signed by the did:key, which the server accepts because the document
// lists that key. From then on requests to the Space sign as the account.
export function promoteSpace({ was, spaceId, did, name }: { was: WasClient; spaceId: string; did: string; name: string }) {
  return ensurePromotedSpaceController({ was, wasAsClient: was, spaceId, did, name })
}
