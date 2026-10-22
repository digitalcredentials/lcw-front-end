import { WasClient } from '@interop/was-client'
import type { DocCipher } from '@interop/was-client/edv/cipher'
import { resolveDIDFromLog, readLogFromString } from '@interop/did-method-webvh'
import { webvhSigner } from '@interop/wallet-core/webvh'
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
import { signingAgents, type CredentialKeys, type UserKey } from './keys'
import { readRoster, unwrapUserKey } from './roster'

// A credential's unlock space, the FreeWallet way: the passphrase derives an
// unlock identity (wallet-core's derivation, byte for byte, so FreeWallet
// derives the same identity from the same passphrase), which addresses a
// small space of its own on the PWS server. The space holds FreeWallet's
// signed pointer record, `keyring/keyring.json` (the account controller, the
// email, and where the account lives), and one record FreeWallet does not
// have: `keyring/lcw-keys.json`, the credential's own seeds (signing,
// update, staged), sealed to the unlock identity's key-agreement key and
// signed by the unlock identity with wallet-core's record envelope. The
// account's user key is not here: the credential is a recipient of the
// account's user-key roster (roster.ts), which it reads once its signing
// key lets it sign as the account.

const KEYRING = 'keyring'
const POINTER_RESOURCE = 'keyring.json'
export const KEYS_RESOURCE = 'lcw-keys.json'
const KEYS_LABEL = 'lcw-keys'
const KEYS_VERSION = 2
// How long the management capability an unlock identity delegates to the
// account stays valid. The account uses it to retire the credential's
// records when the credential is removed.
const MANAGEMENT_YEARS = 10

export type { IZcap }

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

// Binds a credential to the account: provisions its unlock space (the
// server accepts a space whose id is derived from the signing unlock
// did:key without a coupon), writes the pointer record and the sealed keys
// record, and delegates the management capability to the account DID the
// pointer names. The caller then adds the credential to the user-key
// roster. Idempotent: re-binding overwrites the records.
export async function bindCredential({
  unlock,
  serverUrl,
  controller,
  email,
  pointer,
  credential,
}: {
  unlock: UnlockIdentity
  serverUrl: string
  // The credential's signing did:key, the controller the pointer record names
  controller: string
  email: string
  pointer: AccountPointer
  credential: CredentialKeys
}): Promise<{ capability: IZcap }> {
  if (!pointer.did) {
    throw new Error('The account pointer names no DID.')
  }
  await ensureUnlockSpace({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId, controller: unlock.agent.id })
  const record = await wrapKeyringRecord({ controller, email, pointer, keyAgreementKey: unlock.keyAgreementKey, signer: unlock.recordSigner })
  await putUnlockKeyring({ storageServerUrl: serverUrl, zcapClient: unlock.zcapClient, spaceId: unlock.spaceId, record })

  const encryption = await mintRecordEncryption({ keyAgreementKey: unlock.keyAgreementKey })
  const cipher = await recordSealCipher({ encryption, collectionId: KEYS_LABEL })
  const { envelope } = await cipher.encrypt({
    data: { signingSeed: toBase64url(credential.signingSeed), updateSeed: toBase64url(credential.updateSeed), stagedSeed: toBase64url(credential.stagedSeed) } as unknown as Json,
  })
  const signed = await signRecordFrame({ version: KEYS_VERSION, encryption, wrapped: envelope, signer: unlock.recordSigner })
  await keyringOf(unlockClient(unlock, serverUrl), unlock.spaceId).resource(KEYS_RESOURCE).put(bytes(signed), { contentType: 'application/json' })
  return { capability: await delegateManagement({ unlock, serverUrl, did: pointer.did }) }
}

// The key-agreement keys the account document lists right now, read from
// the log the Main Space serves publicly: what the roster's user key must be.
async function accountKeyAgreementKeys(pointer: AccountPointer): Promise<string[]> {
  const response = await fetch(`${pointer.host}/space/${pointer.spaceId}/id/did.jsonl`)
  if (!response.ok) {
    throw new Error(`The account log could not be read (${response.status}).`)
  }
  const current = await resolveDIDFromLog(readLogFromString(await response.text()))
  if (current.did !== pointer.did || !current.doc) {
    throw new Error('The account log does not resolve to the account the credential names.')
  }
  const doc = current.doc as { verificationMethod?: { id?: string; publicKeyMultibase?: string }[]; keyAgreement?: unknown[] }
  const listed = new Set(
    (doc.keyAgreement ?? [])
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
// exist, and a removed credential's records are gone). Both records are
// verified against the unlock identity's own key before anything is
// decrypted; the user key, unwrapped from the account's roster, is checked
// against the account document.
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
  const stored = await keyringOf(unlockClient(unlock, serverUrl), unlock.spaceId).resource(KEYS_RESOURCE).get()
  if (stored === null) {
    // The pointer stands but the keys record was retired: the credential was removed
    return null
  }
  if (stored instanceof Blob) {
    throw new Error('The credential has no keys record.')
  }
  const pointer = contents.pointer
  if (!pointer?.did) {
    throw new Error('The credential names no account.')
  }
  const frame = parseRecordFrame({ record: stored, label: KEYS_LABEL, version: KEYS_VERSION })
  await verifyRecordProof({ record: stored, allowedKeyMultibases: unlock.recordSigner.keyMultibase, label: KEYS_LABEL })
  const cipher = await recordCipher({ keyAgreementKey: unlock.keyAgreementKey, keyResolver: unlock.keyResolver, encryption: frame.encryption, collectionId: KEYS_LABEL })
  const credential = decodeKeys(await cipher.decrypt({ id: recordEnvelopeId({ wrapped: frame.wrapped, label: KEYS_LABEL }), envelope: frame.wrapped as Json }))

  // The user key, from the account's roster, read as the account
  const agents = await signingAgents(credential.signingSeed)
  const was = await WasClient.fromSigner({ serverUrl: `${pointer.host}/spaces/`, signer: webvhSigner({ keyAgent: agents.keyAgent, did: pointer.did }) })
  const roster = await readRoster({ was, spaceId: pointer.spaceId })
  if (!roster) {
    throw new Error('The account has no user-key roster.')
  }
  const userKey = await unwrapUserKey({
    roster: roster.roster,
    keyAgreementKey: unlock.keyAgreementKey,
    expectedPublicKeyMultibases: await accountKeyAgreementKeys(pointer),
  })
  return { contents, keys: { credential, userKey } }
}

// Retires a credential's records under the management capability its unlock
// identity delegated: the keys and pointer records are deleted, so the
// credential's secret no longer opens the account. Resolves to whether the
// records were there to delete: the server answers a refused capability
// with the same 404 as an absent record, and a delete is idempotent, so the
// pointer record is read first to tell the two apart.
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
  await keyring.resource(POINTER_RESOURCE).delete()
  return { retired: true }
}
