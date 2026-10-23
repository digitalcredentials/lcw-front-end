import { WasClient, type Resource } from '@interop/was-client'
import type { DocCipher } from '@interop/was-client/edv/cipher'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import {
  mintRecordEncryption,
  recordSealCipher,
  recordCipher,
  recordEnvelopeId,
  parseRecordFrame,
  signRecordFrame,
  verifyRecordProof,
  type SignedRecord,
} from '@interop/wallet-core/keyring'
import { userKeyRecordSigner, userKeySigningKeyMultibase, userKeyVaultKeys } from '@interop/wallet-core/keys'
import { sessionAgents, type Session } from './session'

// The account's credential catalogue: what the account document cannot say
// about its keys. The document lists one signing key per credential and
// nothing else; the catalogue records, per signing key, what kind of
// credential it is (a password, a passkey, the recovery code), when it was
// added, the keys that remove it, where its unlock space is, and the
// management capability its unlock identity delegated to the account. It is
// one record, `account/credentials.json` in the Main Space, sealed to the
// user key and signed by the user key's record signer with wallet-core's
// record envelope (the same envelope the unlock spaces use), so any session
// reads it and the server sees nothing. A credential the catalogue does not
// know (added before the catalogue existed) is listed from the document
// alone and catalogued the next time it signs in.

export type CredentialKind = 'passphrase' | 'passkey' | 'recovery'

export interface CatalogueEntry {
  kind: CredentialKind
  label?: string
  createdAt: string
  updateMultibase: string
  stagedMultibase: string
  // The credential's unlock identity (its did:key) and space, and the
  // management capability it delegated to the account at binding
  unlockDid: string
  unlockSpaceId: string
  capability: IZcap
}

export interface Catalogue {
  version: 1
  // By the credential's signing key multibase
  credentials: Record<string, CatalogueEntry>
}

const COLLECTION = 'account'
const RESOURCE = 'credentials.json'
const LABEL = 'lcw-credentials'
const VERSION = 1

// The JSON value type the record cipher seals and opens
type Json = Parameters<DocCipher['encrypt']>[0]['data']

const empty = (): Catalogue => ({ version: 1, credentials: {} })

async function catalogueResource(session: Session): Promise<Resource> {
  const { asAccount } = await sessionAgents(session)
  const was = await WasClient.fromSigner({ serverUrl: `${session.serverUrl}/spaces/`, signer: asAccount.signer })
  return was.space(session.spaceId).collection(COLLECTION, { encryption: 'plaintext' }).resource(RESOURCE)
}

function parse(data: unknown): Catalogue {
  const stored = data as Partial<Catalogue> | null
  if (!stored || stored.version !== 1 || typeof stored.credentials !== 'object' || stored.credentials === null) {
    return empty()
  }
  return { version: 1, credentials: { ...stored.credentials } }
}

async function seal(session: Session, catalogue: Catalogue): Promise<SignedRecord> {
  const { keyAgreementKey } = userKeyVaultKeys({ userKey: session.userKey })
  const encryption = await mintRecordEncryption({ keyAgreementKey })
  const cipher = await recordSealCipher({ encryption, collectionId: LABEL })
  const { envelope } = await cipher.encrypt({ data: catalogue as unknown as Json })
  return signRecordFrame({ version: VERSION, encryption, wrapped: envelope, signer: await userKeyRecordSigner({ userKey: session.userKey }) })
}

async function open(session: Session, stored: unknown): Promise<Catalogue> {
  const record = typeof stored === 'string' ? JSON.parse(stored) : stored
  const frame = parseRecordFrame({ record, label: LABEL, version: VERSION })
  await verifyRecordProof({ record, allowedKeyMultibases: await userKeySigningKeyMultibase({ userKey: session.userKey }), label: LABEL })
  const { keyAgreementKey, keyResolver } = userKeyVaultKeys({ userKey: session.userKey })
  const cipher = await recordCipher({ keyAgreementKey, keyResolver, encryption: frame.encryption, collectionId: LABEL })
  const data = await cipher.decrypt({ id: recordEnvelopeId({ wrapped: frame.wrapped, label: LABEL }), envelope: frame.wrapped as Json })
  return parse(data)
}

async function readWithEtag(session: Session, resource: Resource): Promise<{ catalogue: Catalogue; etag?: string }> {
  const read = await resource.getWithEtag()
  if (!read || read.data instanceof Blob) {
    return { catalogue: empty() }
  }
  return { catalogue: await open(session, read.data), etag: read.etag }
}

export async function readCatalogue(session: Session): Promise<Catalogue> {
  return (await readWithEtag(session, await catalogueResource(session))).catalogue
}

// Applies `mutate` to the stored catalogue and writes it back, conditional
// on the version read; one retry on a concurrent write. The record is read
// with `session`'s user key and sealed with `sealWith`'s (the same session,
// except across a user-key rotation).
export async function updateCatalogue(session: Session, mutate: (catalogue: Catalogue) => void, { sealWith = session }: { sealWith?: Session } = {}): Promise<Catalogue> {
  const resource = await catalogueResource(session)
  for (let attempt = 0; ; attempt++) {
    const { catalogue, etag } = await readWithEtag(session, resource)
    mutate(catalogue)
    try {
      await resource.put(new TextEncoder().encode(JSON.stringify(await seal(sealWith, catalogue))), {
        contentType: 'application/json',
        ...(etag && { ifMatch: etag }),
      })
      return catalogue
    } catch (err) {
      if (attempt > 0 || (err as { status?: number }).status !== 412) {
        throw err
      }
    }
  }
}
