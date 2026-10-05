import { X25519KeyAgreementKey2020 } from '@interop/x25519-key-agreement-key'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { createEdvEncryption, ensureFirstEpoch, ownerRecipient } from '@interop/was-client/edv'
import type { Collection, ResourceData, Space } from '@interop/was-client'

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
// epoch, wrapped to the session key. A missing collection is created through
// the server's create-collection route (the was-client's recommended path);
// an existing one that predates the descriptor is re-declared once with
// configure. Safe to call repeatedly: an existing descriptor is left alone,
// and ensureFirstEpoch adopts a roster another provisioner already installed.
export async function ensureEncryptedCollection({
  space,
  id,
  storedKeyPair,
  name,
}: {
  space: Space
  id: string
  storedKeyPair: StoredKeyPair
  name: string
}): Promise<void> {
  const collection = space.collection(id)
  const described = (await collection.describe().catch(() => null)) as
    | { encryption?: unknown }
    | null
  if (!described) {
    await space.createCollection({ id, name, encryption: { scheme: 'edv' } })
  } else if (!described.encryption) {
    await collection.configure({
      name,
      encryption: { scheme: 'edv' },
      force: true,
    } as Parameters<typeof collection.configure>[0])
  }
  const keyAgreementKey = await keyAgreementFromSession(storedKeyPair)
  await ensureFirstEpoch({
    collection,
    recipients: [ownerRecipient({ keyAgreementKey })],
  })
  encryptedState.set(`${collection.spaceId}/${collection.id}`, true)
}

// Whether a collection's description declares client-side encryption, memoized
// per space/collection for the session (only this wallet ever declares it, so
// the answer cannot change under us except through ensureEncryptedCollection,
// which updates the memo).
const encryptedState = new Map<string, boolean>()

export async function isEncryptedCollection(collection: Collection): Promise<boolean> {
  const key = `${collection.spaceId}/${collection.id}`
  const cached = encryptedState.get(key)
  if (cached !== undefined) {
    return cached
  }
  const described = (await collection.describe().catch(() => null)) as
    | { encryption?: unknown }
    | null
  const encrypted = Boolean(described?.encryption)
  encryptedState.set(key, encrypted)
  return encrypted
}

// Writes a resource with the operation the collection requires: an encrypted
// collection mints an opaque EDV id via add() (a named put would leak the
// name onto the URL); a plaintext collection keeps the caller-chosen id.
// Returns the id the resource landed under.
export async function writeResource({
  collection,
  name,
  body,
}: {
  collection: Collection
  name: string
  body: ResourceData
}): Promise<{ id: string }> {
  if (await isEncryptedCollection(collection)) {
    const { id } = await collection.add(body)
    return { id }
  }
  await collection.put(name, body)
  return { id: name }
}
