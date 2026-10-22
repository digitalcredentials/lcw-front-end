import { WasClient } from '@interop/was-client'
import type { DocCipher } from '@interop/was-client/edv/cipher'
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
  type UnlockIdentity,
} from '@interop/wallet-core/keyring'
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import { fromBase64url, toBase64url } from './bytes'
import type { CredentialKeys, UserKey } from './keys'

// A credential's unlock space, the FreeWallet way: the passphrase derives an
// unlock identity (wallet-core's derivation, byte for byte, so FreeWallet
// derives the same identity from the same passphrase), which addresses a
// small space of its own on the PWS server. The space holds FreeWallet's
// signed pointer record, `keyring/keyring.json` (the account controller, the
// email, and where the account lives), and one record FreeWallet does not
// have: `keyring/lcw-keys.json`, the credential's keys and the account's user
// key, sealed to the unlock key and signed by the unlock identity, so any
// browser holding the credential can open the account.

const KEYRING = 'keyring'
const POINTER_RESOURCE = 'keyring.json'
export const KEYS_RESOURCE = 'lcw-keys.json'
const KEYS_LABEL = 'lcw-keys'
const KEYS_VERSION = 1
// How long the management capability an unlock identity delegates to the
// account stays valid. The account uses it to retire the credential's
// records when the credential is removed; past this, a removal leaves the
// unlock space in place (reported, not fatal).
const MANAGEMENT_YEARS = 10

export type { IZcap }

// The URL of an unlock space on its server, the capability's target.
export const unlockSpaceUrl = (serverUrl: string, spaceId: string) => `${serverUrl}/space/${spaceId}/`

// Delegates a management capability on the unlock space from the unlock
// identity (the space's controller) to the account DID: GET, PUT and DELETE
// below the space, so a session signed as the account can retire the
// credential's records later without its secret. Deleting the space itself
// is a root-only operation on the server, so the space stays; emptied, it
// opens nothing. Signed with eddsa-jcs-2022, which the server verifies.
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

// Retires a credential's records under the management capability its unlock
// identity delegated: the pointer record and the keys record are deleted,
// so the credential's secret no longer opens the account or yields the user
// key. `zcapClient` signs as the account (the capability's controller).
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
  const keyring = was.space(spaceId, { capability }).collection(KEYRING, { encryption: 'plaintext' })
  const pointer = await keyring.resource(POINTER_RESOURCE).getWithEtag()
  if (!pointer) {
    return { retired: false }
  }
  await keyring.resource(KEYS_RESOURCE).delete()
  await keyring.resource(POINTER_RESOURCE).delete()
  return { retired: true }
}

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

function unlockClient(unlock: UnlockIdentity, serverUrl: string): WasClient {
  return WasClient.fromSigner({ serverUrl: `${serverUrl}/spaces/`, signer: unlock.agent.getSigner() })
}

function keysResource(was: WasClient, unlock: UnlockIdentity) {
  return was.space(unlock.spaceId).collection(KEYRING, { encryption: 'plaintext' }).resource(KEYS_RESOURCE)
}

interface StoredKeys {
  signingSeed: string
  updateSeed: string
  stagedSeed: string
  userKey: { id: string; secret: string }
}

function encodeKeys(keys: UnlockedKeys): StoredKeys {
  return {
    signingSeed: toBase64url(keys.credential.signingSeed),
    updateSeed: toBase64url(keys.credential.updateSeed),
    stagedSeed: toBase64url(keys.credential.stagedSeed),
    userKey: { id: keys.userKey.id, secret: toBase64url(keys.userKey.secret) },
  }
}

function decodeKeys(data: unknown): UnlockedKeys {
  const stored = data as Partial<StoredKeys>
  if (
    typeof stored?.signingSeed !== 'string' ||
    typeof stored.updateSeed !== 'string' ||
    typeof stored.stagedSeed !== 'string' ||
    typeof stored.userKey?.id !== 'string' ||
    typeof stored.userKey?.secret !== 'string'
  ) {
    throw new Error('The stored keys record is malformed.')
  }
  return {
    credential: {
      signingSeed: fromBase64url(stored.signingSeed),
      updateSeed: fromBase64url(stored.updateSeed),
      stagedSeed: fromBase64url(stored.stagedSeed),
    },
    userKey: { id: stored.userKey.id, secret: fromBase64url(stored.userKey.secret) },
  }
}

// Binds a credential to the account: provisions its unlock space (the
// server accepts a space whose id is derived from the signing unlock
// did:key without a coupon), writes the pointer record, and writes the
// sealed keys record. Idempotent: re-binding overwrites both records.
// Resolves to the management capability delegated to the account DID the
// pointer names, for the account's catalogue.
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
  await ensureUnlockSpace({
    storageServerUrl: serverUrl,
    zcapClient: unlock.zcapClient,
    spaceId: unlock.spaceId,
    controller: unlock.agent.id,
  })
  const record = await wrapKeyringRecord({
    controller,
    email,
    pointer,
    keyAgreementKey: unlock.keyAgreementKey,
    signer: unlock.recordSigner,
  })
  await putUnlockKeyring({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId, record })

  const encryption = await mintRecordEncryption({ keyAgreementKey: unlock.keyAgreementKey })
  const cipher = await recordSealCipher({ encryption, collectionId: KEYS_LABEL })
  const { envelope } = await cipher.encrypt({ data: encodeKeys(keys) as unknown as Json })
  const signed = await signRecordFrame({ version: KEYS_VERSION, encryption, wrapped: envelope, signer: unlock.recordSigner })
  const was = unlockClient(unlock, serverUrl)
  await keysResource(was, unlock).put(new TextEncoder().encode(JSON.stringify(signed)), { contentType: 'application/json' })
  if (!pointer.did) {
    throw new Error('The account pointer names no DID.')
  }
  return { capability: await delegateManagement({ unlock, serverUrl, did: pointer.did }) }
}

// Opens the account a credential is bound to: the pointer record's contents
// and the unwrapped keys, or null when no account is bound to this
// credential (a wrong passphrase derives an identity whose space does not
// exist). Both records are verified against the unlock identity's own
// signing key before anything is decrypted, so a storage host cannot hand
// the wallet keys it did not bind.
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
  const was = unlockClient(unlock, serverUrl)
  const stored = await keysResource(was, unlock).get()
  if (stored === null || stored instanceof Blob) {
    throw new Error('The credential has no keys record.')
  }
  const frame = parseRecordFrame({ record: stored, label: KEYS_LABEL, version: KEYS_VERSION })
  await verifyRecordProof({ record: stored, allowedKeyMultibases: unlock.recordSigner.keyMultibase, label: KEYS_LABEL })
  const cipher = await recordCipher({
    keyAgreementKey: unlock.keyAgreementKey,
    keyResolver: unlock.keyResolver,
    encryption: frame.encryption,
    collectionId: KEYS_LABEL,
  })
  const data = await cipher.decrypt({
    id: recordEnvelopeId({ wrapped: frame.wrapped, label: KEYS_LABEL }),
    envelope: frame.wrapped as Json,
  })
  return { contents, keys: decodeKeys(data) }
}
