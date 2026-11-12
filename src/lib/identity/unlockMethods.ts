import type { PwsClient } from '@interop/pws-client'
import { mintRecordEncryption, parseRecordFrame, recordCipher, recordEnvelopeId, signRecordFrame, verifyRecordProof } from '@interop/wallet-core/keyring'
import { userKeyRecordSigner, userKeySigningKeyMultibase, userKeyVaultKeys, type UserKey } from '@interop/wallet-core/keys'
import { KEYRING_KDF } from '@interop/wallet-core/keyring'
import { UNLOCK_METHODS_COLLECTION, UNLOCK_METHODS_RESOURCE, plaintextCollection } from '@interop/wallet-core/space'
import type { CredentialAnchoredStandingFields } from '@interop/wallet-core/clientAnnex'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import type { DocCipher } from '@interop/pws-client/edv/cipher'
import { randomBytes, toBase64url } from './bytes'

// The unlock-methods registry: `unlock-methods/methods.json` in the account
// Space, the account's own list of its sign-in methods (passphrases,
// passkeys, recovery codes) with the public inventory of each, sealed to
// the user key's vault key and signed by the user key. The record's shape
// is FreeWallet's, member for member, so "Sign-in credentials" lists the
// same methods in both wallets; the code here is this wallet's own.

export interface StandingUnlockFields {
  rosterKid?: string
  keyAgreementKeyMultibase?: string
  updateKeyMultibase?: string
  delegationKeyId?: string
  delegationExpires?: string
  delegatedClientsKeyId?: string
  delegatedClientsExpires?: string
  unlockClientDid?: string
  unlockKeyAgreementKeyId?: string
  unlockKeyAgreementKeyMultibase?: string
}

export interface PassphraseUnlockMethod extends StandingUnlockFields {
  type: 'passphrase'
  createdAt: string
  unlockSpaceId: string
  kdfVersion: number
  manageCapability?: IZcap
  pendingEstablishment?: { unlockSpaceId: string; keyAgreementKeyMultibase: string }
}

export interface PasskeyUnlockMethod extends StandingUnlockFields {
  type: 'passkey'
  label: string
  createdAt: string
  // base64url
  credentialId: string
  transports: string[]
  backupEligibility: boolean
  backupState: boolean
  unlockSpaceId: string
  manageCapability?: IZcap
}

export interface RecoveryCodeUnlockMethod {
  type: 'recovery-code'
  label: string
  createdAt: string
  unlockSpaceId: string
  manageCapability?: IZcap
  recoveryKid: string
  keyAgreementKeyMultibase: string
  updateKeyMultibase: string
  delegationKeyId?: string
  delegationExpires?: string
  recoveryClientDid?: string
  unlockKeyAgreementKeyId?: string
  unlockKeyAgreementKeyMultibase?: string
}

export interface BackupCredentialUnlockMethod extends StandingUnlockFields {
  type: 'backup-credential'
  label: string
  createdAt: string
  unlockSpaceId: string
  manageCapability?: IZcap
}

export type UnlockMethod = PassphraseUnlockMethod | PasskeyUnlockMethod | RecoveryCodeUnlockMethod | BackupCredentialUnlockMethod

export interface UnlockMethodsRecord {
  version: 1
  // The wallet-wide WebAuthn user id (16 bytes, base64url), the `user.id`
  // every passkey of the account is registered under
  webAuthnUserId: string
  methods: UnlockMethod[]
}

// The stored frame's version (the `{ version, encryption, wrapped, proof }`
// envelope FreeWallet stamps).
const STORED_RECORD_VERSION = 2
const LABEL = 'unlock-methods'

type Json = Parameters<DocCipher['encrypt']>[0]['data']

export function emptyRegistry(): UnlockMethodsRecord {
  return { version: 1, webAuthnUserId: toBase64url(randomBytes(16)), methods: [] }
}

// The standing fields of an entry, from the establishment's standing fields
// (every member present only when its input is: the object is serialized).
export function standingFieldsOf(fields: Partial<CredentialAnchoredStandingFields>): StandingUnlockFields {
  const out: StandingUnlockFields = {}
  for (const key of [
    'rosterKid',
    'keyAgreementKeyMultibase',
    'updateKeyMultibase',
    'delegationKeyId',
    'delegationExpires',
    'delegatedClientsKeyId',
    'delegatedClientsExpires',
    'unlockClientDid',
    'unlockKeyAgreementKeyId',
    'unlockKeyAgreementKeyMultibase',
  ] as const) {
    const value = fields[key]
    if (typeof value === 'string' && value) {
      out[key] = value
    }
  }
  return out
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

const registryResource = (pws: PwsClient, spaceId: string, capability?: IZcap) =>
  plaintextCollection({ pws, spaceId, collectionId: UNLOCK_METHODS_COLLECTION.id, ...(capability && { capability }) }).resource(UNLOCK_METHODS_RESOURCE)

async function unwrapRegistry({ record, userKey }: { record: unknown; userKey: UserKey }): Promise<UnlockMethodsRecord> {
  const { keyAgreementKey, keyResolver } = userKeyVaultKeys({ userKey })
  const frame = parseRecordFrame({ record, label: LABEL, version: STORED_RECORD_VERSION })
  // The proof is checked before anything is decrypted: only a record the
  // account's own user key signed is read
  await verifyRecordProof({ record, allowedKeyMultibases: await userKeySigningKeyMultibase({ userKey }), label: LABEL })
  const cipher = await recordCipher({ keyAgreementKey, keyResolver, encryption: frame.encryption, collectionId: UNLOCK_METHODS_COLLECTION.id })
  const plaintext = (await cipher.decrypt({ id: recordEnvelopeId({ wrapped: frame.wrapped, label: LABEL }), envelope: frame.wrapped as Json })) as Partial<UnlockMethodsRecord>
  if (plaintext.version !== 1 || typeof plaintext.webAuthnUserId !== 'string' || !Array.isArray(plaintext.methods)) {
    throw new Error('The unlock-methods registry record is malformed.')
  }
  return { version: 1, webAuthnUserId: plaintext.webAuthnUserId, methods: plaintext.methods }
}

async function wrapRegistry({ record, userKey }: { record: UnlockMethodsRecord; userKey: UserKey }): Promise<unknown> {
  const { keyAgreementKey, keyResolver } = userKeyVaultKeys({ userKey })
  const encryption = await mintRecordEncryption({ keyAgreementKey })
  const cipher = await recordCipher({ keyAgreementKey, keyResolver, encryption, collectionId: UNLOCK_METHODS_COLLECTION.id })
  const { envelope } = await cipher.encrypt({ data: record as unknown as Json })
  return signRecordFrame({ version: STORED_RECORD_VERSION, encryption, wrapped: envelope, signer: await userKeyRecordSigner({ userKey }) })
}

// Reads the registry, or null when the account has none yet.
export async function readUnlockMethods({
  pws,
  spaceId,
  userKey,
  capability,
}: {
  pws: PwsClient
  spaceId: string
  userKey: UserKey
  capability?: IZcap
}): Promise<{ record: UnlockMethodsRecord; etag?: string } | null> {
  const read = await registryResource(pws, spaceId, capability).getWithEtag()
  if (!read) {
    return null
  }
  return { record: await unwrapRegistry({ record: read.data, userKey }), ...(read.etag && { etag: read.etag }) }
}

// Rewrites the registry through `mutate`, with compare-and-swap against
// the version read (retried when another writer got there first). The
// record is read under `userKey` and written under `writeUserKey` when one
// is given (a re-seal under a rotated user key), else under the same key.
export async function updateUnlockMethods({
  pws,
  spaceId,
  userKey,
  writeUserKey,
  capability,
  mutate,
}: {
  pws: PwsClient
  spaceId: string
  userKey: UserKey
  writeUserKey?: UserKey
  capability?: IZcap
  mutate: (existing: UnlockMethodsRecord | null) => UnlockMethodsRecord
}): Promise<UnlockMethodsRecord> {
  const resource = registryResource(pws, spaceId, capability)
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readUnlockMethods({ pws, spaceId, userKey, capability })
    const next = mutate(existing?.record ?? null)
    const sealed = await wrapRegistry({ record: next, userKey: writeUserKey ?? userKey })
    try {
      await resource.put(bytesOf(sealed), { contentType: 'application/json', ...(existing ? (existing.etag ? { ifMatch: existing.etag } : {}) : { ifNoneMatch: true }) })
      return next
    } catch (err) {
      if ((err as { name?: string }).name !== 'PreconditionFailedError' || attempt === 2) {
        throw err
      }
    }
  }
  throw new Error('unreachable')
}

// Adds or replaces the account's one passphrase entry. A passphrase change
// writes a new unlock Space id; an entry for the same Space keeps its
// creation stamp.
export function upsertPassphraseMethod({
  record,
  unlockSpaceId,
  manageCapability,
  standing,
}: {
  record: UnlockMethodsRecord
  unlockSpaceId: string
  manageCapability?: IZcap
  standing?: StandingUnlockFields
}): UnlockMethodsRecord {
  const existing = record.methods.find((method): method is PassphraseUnlockMethod => method.type === 'passphrase')
  const same = existing !== undefined && existing.unlockSpaceId === unlockSpaceId ? existing : undefined
  const capability = manageCapability ?? same?.manageCapability
  const entry: PassphraseUnlockMethod = {
    type: 'passphrase',
    createdAt: same?.createdAt ?? new Date().toISOString(),
    unlockSpaceId,
    kdfVersion: KEYRING_KDF.version,
    ...(capability && { manageCapability: capability }),
    ...(standing ?? (same ? standingOf(same) : {})),
  }
  const methods = existing ? record.methods.map((method) => (method.type === 'passphrase' ? entry : method)) : [...record.methods, entry]
  return { ...record, methods }
}

function standingOf(entry: PassphraseUnlockMethod): StandingUnlockFields {
  const { type: _type, createdAt: _createdAt, unlockSpaceId: _space, kdfVersion: _kdf, manageCapability: _manage, pendingEstablishment: _pending, ...standing } = entry
  return standing
}

// Adds or replaces an entry other than the passphrase one, keyed by its
// unlock Space.
export function upsertMethod({ record, entry }: { record: UnlockMethodsRecord; entry: UnlockMethod }): UnlockMethodsRecord {
  const same = (method: UnlockMethod) => method.type === entry.type && method.unlockSpaceId === entry.unlockSpaceId
  const methods = record.methods.some(same) ? record.methods.map((method) => (same(method) ? entry : method)) : [...record.methods, entry]
  return { ...record, methods }
}

export function removeMethod({ record, unlockSpaceId }: { record: UnlockMethodsRecord; unlockSpaceId: string }): UnlockMethodsRecord {
  return { ...record, methods: record.methods.filter((method) => method.unlockSpaceId !== unlockSpaceId) }
}
