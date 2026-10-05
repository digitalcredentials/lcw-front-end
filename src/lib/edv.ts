import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { createEdvEncryption, ensureFirstEpoch, ownerRecipient } from '@interop/was-client/edv'
import type { Collection } from '@interop/was-client'

// EDV-over-WAS (end-to-end encryption) support: collections declared with an
// `encryption: { scheme: 'edv' }` descriptor store JWE envelopes the server
// cannot read, and the ordinary collection handles encrypt on write and
// decrypt on read (the was-client pass-through model).
//
// The key-agreement key is the standard X25519 conversion of the session's
// passphrase-derived Ed25519 key, so no new credential or key store is
// involved: whoever can sign for the space can decrypt its envelopes.

// The exported session key pair, as stored by login
type StoredKeyPair = object

export async function keyAgreementFromSession(storedKeyPair: StoredKeyPair) {
  const edKey = await Ed25519VerificationKey.from(storedKeyPair)
  const controller = `did:key:${edKey.fingerprint()}`
  const exported = (await edKey.export({ secretKey: true })) as {
    publicKeyMultibase: string
    secretKeyMultibase?: string
  }
  // The converter's field name differs from our key library's export
  // (privateKeyMultibase vs secretKeyMultibase); mapped explicitly so the
  // private half is actually converted.
  const keyAgreementKey = X25519KeyAgreementKey2020.fromEd25519({
    controller,
    publicKeyMultibase: exported.publicKeyMultibase,
    privateKeyMultibase: exported.secretKeyMultibase,
  })
  if (!keyAgreementKey.privateKeyMultibase) {
    throw new Error('The session key could not be converted for decryption.')
  }
  keyAgreementKey.id ??= `${controller}#${keyAgreementKey.fingerprint()}`
  return keyAgreementKey as typeof keyAgreementKey & { id: string }
}

// The encryption provider handed to WasClient: a pure keystore returning the
// session's key-agreement key for any collection that declares the edv
// scheme. Plaintext collections are untouched. The keyResolver member is
// required by the type but never invoked: the codec resolves epoch-key
// recipients through its own built-in did:key resolver.
export async function sessionEncryption(storedKeyPair: StoredKeyPair) {
  const keyAgreementKey = await keyAgreementFromSession(storedKeyPair)
  return createEdvEncryption({
    resolveKeys: async () => ({
      keyAgreementKey,
      keyResolver: async ({ id }: { id?: string }) => {
        throw new Error(`Unexpected keystore resolver call for ${id ?? 'unknown key'}.`)
      },
    }),
  })
}

// Declares a collection encrypted (set-once) and installs its first key
// epoch, wrapped to the session key. Safe to call repeatedly: an existing
// descriptor is left alone, and ensureFirstEpoch adopts a roster another
// provisioner already installed.
export async function ensureEncryptedCollection({
  collection,
  storedKeyPair,
  name,
}: {
  collection: Collection
  storedKeyPair: StoredKeyPair
  name: string
}): Promise<void> {
  const described = (await collection.describe().catch(() => null)) as
    | { encryption?: unknown }
    | null
  if (!described?.encryption) {
    await collection.configure({
      name,
      encryption: { scheme: 'edv' },
      force: true,
    } as Parameters<Collection['configure']>[0])
  }
  const keyAgreementKey = await keyAgreementFromSession(storedKeyPair)
  await ensureFirstEpoch({
    collection,
    recipients: [ownerRecipient({ keyAgreementKey })],
  })
}
