import { ensureFirstEpoch, ownerRecipient } from '@interop/was-client/edv'
import type { Collection, ResourceData, Space } from '@interop/was-client'
import { getSession, sessionKeyAgreementKey } from './identity/session'

// EDV-over-WAS (end-to-end encryption) support: collections declared with an
// `encryption: { scheme: 'edv' }` descriptor store JWE envelopes the server
// cannot read, and the ordinary collection handles encrypt on write and
// decrypt on read (the was-client pass-through model).
//
// The recipient of every encrypted collection is the account's user key,
// which whichever credential opened the session unwrapped
// (src/lib/identity): one key per account, shared by every credential, so a
// collection encrypted in one session decrypts in any other.

function currentKeyAgreementKey() {
  const session = getSession()
  if (!session) {
    throw new Error('UNAUTHORIZED')
  }
  return sessionKeyAgreementKey(session)
}

// Declares a collection encrypted and installs its first key epoch, wrapped
// to the user key. A missing collection is created through the server's
// create-collection route with the edv descriptor. Safe to call repeatedly:
// an existing encrypted collection is left alone, and ensureFirstEpoch
// adopts a roster another provisioner already installed. The display name
// (and optional description) of a newly created collection goes into the
// encrypted /meta custom, never a plaintext field.
export async function ensureEncryptedCollection({
  space,
  id,
  name,
  description,
}: {
  space: Space
  id: string
  name: string
  description?: string
}): Promise<void> {
  const collection = space.collection(id)
  const described = (await collection.describe().catch(() => null)) as
    | { encryption?: unknown }
    | null
  if (!described) {
    await space.createCollection({ id, encryption: { scheme: 'edv' } })
  } else if (!described.encryption) {
    throw new Error(`The collection "${id}" exists and is not encrypted.`)
  }
  const keyAgreementKey = currentKeyAgreementKey()
  await ensureFirstEpoch({
    collection,
    recipients: [ownerRecipient({ keyAgreementKey })],
  })
  encryptedState.set(`${collection.spaceId}/${collection.id}`, true)
  if (!described && name) {
    await collection.setMeta({
      custom: { name, ...(description && { tags: { description } }) },
    })
  }
}

// A collection's display fields: the /meta custom ({name, tags.description}),
// plaintext on a plaintext collection, an encrypted envelope on an encrypted
// one, decoded transparently either way. A collection with no custom (one
// created by another client, or an implicit one) shows its configuration
// name, which is a plaintext member of the metadata object.
export async function collectionDisplay(
  collection: Collection
): Promise<{ name?: string; description?: string } | null> {
  const meta = (await collection.meta().catch(() => null)) as {
    custom?: { name?: string; tags?: Record<string, string> }
  } | null
  if (meta?.custom && (meta.custom.name || meta.custom.tags?.description)) {
    return {
      ...(meta.custom.name && { name: meta.custom.name }),
      ...(meta.custom.tags?.description && { description: meta.custom.tags.description }),
    }
  }
  const desc = (await collection.describe().catch(() => null)) as
    | { name?: unknown; description?: unknown }
    | null
  const legacy = {
    ...(typeof desc?.name === 'string' && desc.name.trim() && { name: desc.name }),
    ...(typeof desc?.description === 'string' && desc.description.trim() && { description: desc.description }),
  }
  return Object.keys(legacy).length ? legacy : null
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
