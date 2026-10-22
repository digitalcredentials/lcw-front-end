import { WasClient } from '@interop/was-client'
import type { DocCipher } from '@interop/was-client/edv/cipher'
import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import { resolveDIDFromLog, readLogFromString } from '@interop/did-method-webvh'
import {
  KEYRING_KDF,
  deriveUnlockIdentity,
  ensureUnlockSpace,
  getUnlockKeyring,
  putUnlockKeyring,
  wrapKeyringRecord,
  unwrapKeyringRecord,
  mintRecordEncryption,
  recordSealCipher,
  recordCipher,
  recordEnvelopeId,
  parseRecordFrame,
  signRecordFrame,
  verifyRecordProof,
  type AccountPointer,
  type KeyringRecordContents,
  type RecordSigner,
  type UnlockIdentity,
} from '@interop/wallet-core/keyring'
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { IKeyAgreementKey, IKeyResolver } from '@interop/data-integrity-core'
import { fromBase64url, toBase64url } from './bytes'
import type { CredentialKeys, UserKey } from './keys'

// A credential's unlock space, the FreeWallet way: the passphrase derives an
// unlock identity (wallet-core's derivation, byte for byte, so FreeWallet
// derives the same identity from the same passphrase), which addresses a
// small space of its own on the PWS server. The space holds FreeWallet's
// signed pointer record, `keyring/keyring.json` (the account controller, the
// email, and where the account lives), and two records FreeWallet does not
// have, both sealed to the unlock identity's key-agreement key with
// wallet-core's record envelope:
//
//   - `keyring/lcw-keys.json`: the credential's own seeds (signing, update,
//     staged), signed by the unlock identity. Written once, at binding.
//   - `keyring/lcw-user-key.json`: the account's user key, the one key every
//     credential shares. Signed by the unlock identity at binding, and by
//     an account key whenever the user key rotates (a credential's removal):
//     the account cannot sign as the unlock identity, so the reader accepts
//     either its own unlock key or a key the account document lists now.
//     The seal needs only the unlock identity's public key-agreement key,
//     which its did:key yields, so the account rewrites it without the
//     credential's secret, under the management capability the identity
//     delegated at binding.

const KEYRING = 'keyring'
const POINTER_RESOURCE = 'keyring.json'
export const KEYS_RESOURCE = 'lcw-keys.json'
const KEYS_LABEL = 'lcw-keys'
const KEYS_VERSION = 2
export const USER_KEY_RESOURCE = 'lcw-user-key.json'
const USER_KEY_LABEL = 'lcw-user-key'
const USER_KEY_VERSION = 1
// How long the management capability an unlock identity delegates to the
// account stays valid. The account uses it to rewrite the user-key record on
// rotation and to retire the credential's records when it is removed.
const MANAGEMENT_YEARS = 10

export type { IZcap, RecordSigner }

export interface UnlockedKeys {
  credential: CredentialKeys
  userKey: UserKey
}

export type { UnlockIdentity, AccountPointer, KeyringRecordContents }

// The JSON value type the record cipher seals and opens
type Json = Parameters<DocCipher['encrypt']>[0]['data']

// The unlock identity a passphrase derives. The expensive step (Argon2id
// over 64 MiB) runs here, once per typed passphrase.
export function openPassphrase(passphrase: string): Promise<UnlockIdentity> {
  return deriveUnlockIdentity({ secret: passphrase, kdf: KEYRING_KDF })
}

// The URL of an unlock space on its server, the capability's target.
export const unlockSpaceUrl = (serverUrl: string, spaceId: string) => `${serverUrl}/space/${spaceId}/`

function unlockClient(unlock: UnlockIdentity, serverUrl: string): WasClient {
  return WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: unlock.agent.getSigner() })
}

const keyringOf = (was: WasClient, spaceId: string, capability?: IZcap) =>
  was.space(spaceId, capability ? { capability } : undefined).collection(KEYRING, { encryption: 'plaintext' })

// The unlock identity's public key-agreement key, from its did:key alone:
// the Montgomery form of its Ed25519 key, named the way the identity names
// it for itself, so a record sealed to it opens with the identity's own key.
export function unlockKeyAgreementKeyOf(unlockDid: string): IKeyAgreementKey {
  const publicKeyMultibase = unlockDid.slice('did:key:'.length)
  return X25519KeyAgreementKey2020.fromEd25519({ controller: unlockDid, publicKeyMultibase }) as unknown as IKeyAgreementKey
}

// ---- sealed records -----------------------------------------------------------

async function sealRecord({
  data,
  keyAgreementKey,
  signer,
  label,
  version,
}: {
  data: unknown
  keyAgreementKey: IKeyAgreementKey
  signer: RecordSigner
  label: string
  version: number
}): Promise<unknown> {
  const encryption = await mintRecordEncryption({ keyAgreementKey })
  const cipher = await recordSealCipher({ encryption, collectionId: label })
  const { envelope } = await cipher.encrypt({ data: data as Json })
  return signRecordFrame({ version, encryption, wrapped: envelope, signer })
}

async function openRecord({
  stored,
  keyAgreementKey,
  keyResolver,
  allowedKeyMultibases,
  label,
  version,
}: {
  stored: unknown
  keyAgreementKey: IKeyAgreementKey
  keyResolver: IKeyResolver
  allowedKeyMultibases: string | string[]
  label: string
  version: number
}): Promise<unknown> {
  const record = typeof stored === 'string' ? JSON.parse(stored) : stored
  const frame = parseRecordFrame({ record, label, version })
  await verifyRecordProof({ record, allowedKeyMultibases, label })
  const cipher = await recordCipher({ keyAgreementKey, keyResolver, encryption: frame.encryption, collectionId: label })
  return cipher.decrypt({ id: recordEnvelopeId({ wrapped: frame.wrapped, label }), envelope: frame.wrapped as Json })
}

const bytes = (record: unknown) => new TextEncoder().encode(JSON.stringify(record))

interface StoredKeys {
  signingSeed: string
  updateSeed: string
  stagedSeed: string
}

function decodeKeys(data: unknown): CredentialKeys {
  const stored = data as Partial<StoredKeys>
  if (typeof stored?.signingSeed !== 'string' || typeof stored.updateSeed !== 'string' || typeof stored.stagedSeed !== 'string') {
    throw new Error('The stored keys record is malformed.')
  }
  return { signingSeed: fromBase64url(stored.signingSeed), updateSeed: fromBase64url(stored.updateSeed), stagedSeed: fromBase64url(stored.stagedSeed) }
}

interface StoredUserKey {
  id: string
  secret: string
}

function decodeUserKey(data: unknown): UserKey {
  const stored = data as Partial<StoredUserKey>
  if (typeof stored?.id !== 'string' || typeof stored.secret !== 'string') {
    throw new Error('The stored user-key record is malformed.')
  }
  return { id: stored.id, secret: fromBase64url(stored.secret) }
}

// Delegates a management capability on the unlock space from the unlock
// identity (the space's controller) to the account DID: GET, PUT and DELETE
// below the space, so a session signed as the account can rewrite the
// user-key record and retire the credential's records later without its
// secret. Deleting the space itself is a root-only operation on the server,
// so the space stays; emptied, it opens nothing. Signed with eddsa-jcs-2022,
// which the server verifies.
export async function delegateManagement({ unlock, serverUrl, did }: { unlock: UnlockIdentity; serverUrl: string; did: string }): Promise<IZcap> {
  const expires = new Date()
  expires.setUTCFullYear(expires.getUTCFullYear() + MANAGEMENT_YEARS)
  return unlock.zcapClient.delegate({
    invocationTarget: unlockSpaceUrl(serverUrl, unlock.spaceId),
    controller: did,
    allowedActions: ['GET', 'PUT', 'DELETE'],
    expires,
  })
}

// Binds a credential to the account: provisions its unlock space (the
// server accepts a space whose id is derived from the signing unlock
// did:key without a coupon), writes the pointer record, the sealed keys
// record and the sealed user-key record, and delegates the management
// capability to the account DID the pointer names. Idempotent: re-binding
// overwrites the records.
export async function bindCredential({
  unlock,
  serverUrl,
  controller,
  email,
  pointer,
  keys,
}: {
  unlock: UnlockIdentity
  serverUrl: string
  // The credential's signing did:key, the controller the pointer record names
  controller: string
  email: string
  pointer: AccountPointer
  keys: UnlockedKeys
}): Promise<{ capability: IZcap }> {
  if (!pointer.did) {
    throw new Error('The account pointer names no DID.')
  }
  await ensureUnlockSpace({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId, controller: unlock.agent.id })
  const record = await wrapKeyringRecord({ controller, email, pointer, keyAgreementKey: unlock.keyAgreementKey, signer: unlock.recordSigner })
  await putUnlockKeyring({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId, record })

  const keyring = keyringOf(unlockClient(unlock, serverUrl), unlock.spaceId)
  const sealed = {
    keyAgreementKey: unlock.keyAgreementKey,
    signer: unlock.recordSigner,
  }
  const keysRecord = await sealRecord({
    ...sealed,
    data: { signingSeed: toBase64url(keys.credential.signingSeed), updateSeed: toBase64url(keys.credential.updateSeed), stagedSeed: toBase64url(keys.credential.stagedSeed) },
    label: KEYS_LABEL,
    version: KEYS_VERSION,
  })
  await keyring.resource(KEYS_RESOURCE).put(bytes(keysRecord), { contentType: 'application/json' })
  const userKeyRecord = await sealRecord({
    ...sealed,
    data: { id: keys.userKey.id, secret: toBase64url(keys.userKey.secret) },
    label: USER_KEY_LABEL,
    version: USER_KEY_VERSION,
  })
  await keyring.resource(USER_KEY_RESOURCE).put(bytes(userKeyRecord), { contentType: 'application/json' })
  return { capability: await delegateManagement({ unlock, serverUrl, did: pointer.did }) }
}

// The signing keys the account document lists right now, read from the
// log the Main Space serves publicly: what a user-key record rewritten by
// the account may be signed with.
async function accountSigningKeys(pointer: AccountPointer): Promise<string[]> {
  const response = await fetch(`${pointer.host}/space/${pointer.spaceId}/id/did.jsonl`)
  if (!response.ok) {
    throw new Error(`The account log could not be read (${response.status}).`)
  }
  const current = await resolveDIDFromLog(readLogFromString(await response.text()))
  if (current.did !== pointer.did || !current.doc) {
    throw new Error('The account log does not resolve to the account the credential names.')
  }
  const doc = current.doc as { verificationMethod?: { id?: string; publicKeyMultibase?: string }[]; capabilityInvocation?: unknown[] }
  const listed = new Set(
    (doc.capabilityInvocation ?? [])
      .map((entry) => (typeof entry === 'string' ? entry : (entry as { id?: string })?.id))
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.split('#')[1] ?? id)
  )
  return (doc.verificationMethod ?? [])
    .filter((method) => typeof method.publicKeyMultibase === 'string' && listed.has(method.id?.split('#')[1] ?? ''))
    .map((method) => method.publicKeyMultibase as string)
}

// Opens the account a credential is bound to: the pointer record's contents
// and the unwrapped keys, or null when no account is bound to this
// credential (a wrong passphrase derives an identity whose space does not
// exist, and a removed credential's records are gone). The keys record is
// verified against the unlock identity's own key; the user-key record
// against that key or a key the account document lists now, so a storage
// host cannot hand the wallet keys nobody it trusts sealed.
export async function readCredential({
  unlock,
  serverUrl,
}: {
  unlock: UnlockIdentity
  serverUrl: string
}): Promise<{ contents: KeyringRecordContents; keys: UnlockedKeys } | null> {
  const record = await getUnlockKeyring({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId })
  if (record === null) {
    return null
  }
  const contents = await unwrapKeyringRecord({
    record,
    keyAgreementKey: unlock.keyAgreementKey,
    keyResolver: unlock.keyResolver,
    expectedKeyMultibase: unlock.recordSigner.keyMultibase,
  })
  const keyring = keyringOf(unlockClient(unlock, serverUrl), unlock.spaceId)
  const [storedKeys, storedUserKey] = await Promise.all([keyring.resource(KEYS_RESOURCE).get(), keyring.resource(USER_KEY_RESOURCE).get()])
  if (storedKeys === null || storedUserKey === null) {
    // The pointer stands but the records were retired: the credential was removed
    return null
  }
  if (storedKeys instanceof Blob || storedUserKey instanceof Blob) {
    throw new Error('The credential records are malformed.')
  }
  if (!contents.pointer?.did) {
    throw new Error('The credential names no account.')
  }
  const opening = { keyAgreementKey: unlock.keyAgreementKey, keyResolver: unlock.keyResolver }
  const credential = decodeKeys(
    await openRecord({ ...opening, stored: storedKeys, allowedKeyMultibases: unlock.recordSigner.keyMultibase, label: KEYS_LABEL, version: KEYS_VERSION })
  )
  const userKey = decodeUserKey(
    await openRecord({
      ...opening,
      stored: storedUserKey,
      allowedKeyMultibases: [unlock.recordSigner.keyMultibase, ...(await accountSigningKeys(contents.pointer))],
      label: USER_KEY_LABEL,
      version: USER_KEY_VERSION,
    })
  )
  return { contents, keys: { credential, userKey } }
}

// Rewrites a credential's user-key record with a rotated user key, as the
// account: sealed to the credential's unlock identity (its public key from
// its did:key), signed by an account key, written under the management
// capability. `zcapClient` signs as the account (the capability's controller).
export async function rewrapUserKey({
  serverUrl,
  zcapClient,
  spaceId,
  capability,
  unlockDid,
  userKey,
  signer,
}: {
  serverUrl: string
  zcapClient: ZcapClient
  spaceId: string
  capability: IZcap
  unlockDid: string
  userKey: UserKey
  signer: RecordSigner
}): Promise<void> {
  const record = await sealRecord({
    data: { id: userKey.id, secret: toBase64url(userKey.secret) },
    keyAgreementKey: unlockKeyAgreementKeyOf(unlockDid),
    signer,
    label: USER_KEY_LABEL,
    version: USER_KEY_VERSION,
  })
  const was = new WasClient({ serverUrl: `${serverUrl}/spaces/`, zcapClient })
  await keyringOf(was, spaceId, capability).resource(USER_KEY_RESOURCE).put(bytes(record), { contentType: 'application/json' })
}

// Retires a credential's records under the management capability its unlock
// identity delegated: the keys, user-key and pointer records are deleted,
// so the credential's secret no longer opens the account or yields any key.
// Resolves to whether the records were there to delete: the server answers
// a refused capability with the same 404 as an absent record, and a delete
// is idempotent, so the pointer record is read first to tell the two apart.
export async function retireCredentialRecords({
  serverUrl,
  zcapClient,
  spaceId,
  capability,
}: {
  serverUrl: string
  zcapClient: ZcapClient
  spaceId: string
  capability: IZcap
}): Promise<{ retired: boolean }> {
  const was = new WasClient({ serverUrl: `${serverUrl}/spaces/`, zcapClient })
  const keyring = keyringOf(was, spaceId, capability)
  if (!(await keyring.resource(POINTER_RESOURCE).getWithEtag())) {
    return { retired: false }
  }
  await keyring.resource(KEYS_RESOURCE).delete()
  await keyring.resource(USER_KEY_RESOURCE).delete()
  await keyring.resource(POINTER_RESOURCE).delete()
  return { retired: true }
}
