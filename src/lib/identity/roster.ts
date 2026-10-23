import { WasClient, type CollectionEncryptionRecipient } from '@interop/was-client'
import { wrapEpochSecret, unwrapEpochSecret, type RecipientPublicKey } from '@interop/was-client/edv'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import type { IKeyAgreementKey } from '@interop/data-integrity-core'
import { multibaseOf, type UserKey } from './keys'

// The user-key roster: the account's one user key, wrapped to every
// credential. One JWE-style record in the Main Space's `account` collection
// whose `recipients` array holds one entry per credential (the key-agreement
// form of its unlock identity), the way an encrypted collection's epoch key
// is wrapped to its readers. A credential signing in unwraps the entry whose
// `kid` is its own unlock key-agreement key. Adding a credential appends an
// entry; a rotation writes a fresh roster for the new key with the remaining
// credentials as recipients, in one compare-and-swap, so a removed
// credential's unlock key is never a recipient of the key that replaces the
// one it held.
//
// The roster carries no signature. A reader trusts what it unwraps only if
// the secret's public key is the one the account document names under
// keyAgreement (read from the Space's public log), which nothing but the
// account's update keys can change.

const COLLECTION = 'account'
const RESOURCE = 'user-key.json'
const VERSION = 1

export interface UserKeyRoster {
  version: 1
  // The user key's id (its X25519 did:key), the public half of what the
  // recipients unwrap
  userKey: string
  recipients: CollectionEncryptionRecipient[]
}

// The unlock identity's public key-agreement key, from its did:key alone:
// the Montgomery form of its Ed25519 key, named the way the identity names
// it for itself, so an entry wrapped to it opens with the identity's own key.
export function unlockKeyAgreementKeyOf(unlockDid: string): IKeyAgreementKey {
  const publicKeyMultibase = unlockDid.slice('did:key:'.length)
  return X25519KeyAgreementKey2020.fromEd25519({ controller: unlockDid, publicKeyMultibase }) as unknown as IKeyAgreementKey
}

// A key-agreement key as a roster recipient: its id is the entry's `kid`.
export function recipientOf(keyAgreementKey: IKeyAgreementKey): RecipientPublicKey {
  const { id, publicKeyMultibase, type } = keyAgreementKey as { id?: string; publicKeyMultibase?: string; type?: string }
  if (typeof id !== 'string' || typeof publicKeyMultibase !== 'string') {
    throw new Error('The key-agreement key lacks an id or a public key.')
  }
  return { id, publicKeyMultibase, ...(type && { type }) }
}

function rosterResource(was: WasClient, spaceId: string) {
  return was.space(spaceId).collection(COLLECTION, { encryption: 'plaintext' }).resource(RESOURCE)
}

function parse(data: unknown): UserKeyRoster {
  const roster = (typeof data === 'string' ? JSON.parse(data) : data) as Partial<UserKeyRoster> | null
  if (!roster || roster.version !== VERSION || typeof roster.userKey !== 'string' || !Array.isArray(roster.recipients)) {
    throw new Error('The user-key roster is malformed.')
  }
  return { version: VERSION, userKey: roster.userKey, recipients: roster.recipients }
}

// The stored roster with its validator, or null when the account has none.
export async function readRoster({ was, spaceId }: { was: WasClient; spaceId: string }): Promise<{ roster: UserKeyRoster; etag?: string } | null> {
  const read = await rosterResource(was, spaceId).getWithEtag()
  if (!read || read.data instanceof Blob) {
    return null
  }
  return { roster: parse(read.data), etag: read.etag }
}

export async function writeRoster({ was, spaceId, roster, ifMatch }: { was: WasClient; spaceId: string; roster: UserKeyRoster; ifMatch?: string }): Promise<void> {
  await rosterResource(was, spaceId).put(new TextEncoder().encode(JSON.stringify(roster)), { contentType: 'application/json', ...(ifMatch && { ifMatch }) })
}

// A roster for `userKey` wrapped to `recipients`.
export async function wrapUserKey({ userKey, recipients }: { userKey: UserKey; recipients: RecipientPublicKey[] }): Promise<UserKeyRoster> {
  return {
    version: VERSION,
    userKey: userKey.id,
    recipients: await Promise.all(recipients.map((recipient) => wrapEpochSecret({ epochSecret: userKey.secret, recipient }))),
  }
}

// Adds a credential as a recipient of the account's current user key,
// creating the roster when the account has none yet. `userKey` is the
// session's; it must be the key the roster carries. Idempotent for a
// recipient already listed.
export async function addRosterRecipient({ was, spaceId, userKey, recipient }: { was: WasClient; spaceId: string; userKey: UserKey; recipient: RecipientPublicKey }): Promise<void> {
  const current = await readRoster({ was, spaceId })
  if (current && current.roster.userKey !== userKey.id) {
    throw new Error('The user-key roster carries a different user key than this session.')
  }
  if (current?.roster.recipients.some((entry) => entry.header.kid === recipient.id)) {
    return
  }
  const entry = await wrapEpochSecret({ epochSecret: userKey.secret, recipient })
  const roster: UserKeyRoster = { version: VERSION, userKey: userKey.id, recipients: [...(current?.roster.recipients ?? []), entry] }
  await writeRoster({ was, spaceId, roster, ifMatch: current?.etag })
}

// Unwraps the user key for one recipient and checks it is the key the
// account document names: the public key derived from the unwrapped secret
// must be the roster's id and one of `expectedPublicKeyMultibases`.
export async function unwrapUserKey({
  roster,
  keyAgreementKey,
  expectedPublicKeyMultibases,
}: {
  roster: UserKeyRoster
  keyAgreementKey: IKeyAgreementKey
  expectedPublicKeyMultibases: string[]
}): Promise<UserKey> {
  const entry = roster.recipients.find((candidate) => candidate.header.kid === keyAgreementKey.id)
  if (!entry) {
    throw new Error('This credential is not a recipient of the account user key.')
  }
  const secret = await unwrapEpochSecret({ entry, keyAgreementKey })
  if (!secret) {
    throw new Error('The user key could not be unwrapped.')
  }
  const derived = X25519KeyAgreementKey2020.fromRawSecret({ secret }).publicKeyMultibase
  if (derived !== multibaseOf(roster.userKey) || !expectedPublicKeyMultibases.includes(derived)) {
    throw new Error('The unwrapped user key is not the one the account document names.')
  }
  return { id: roster.userKey, secret }
}
