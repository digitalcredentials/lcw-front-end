import { ensureFirstEpoch, ownerRecipient } from '@interop/pws-client/edv'
import type { Space } from '@interop/pws-client'
import { getSession, sessionKeyAgreementKey } from './identity/session'
import { CollectionExistsError } from './errors'

// EDV-over-WAS (end-to-end encryption) support: collections declared with an
// `encryption: { scheme: 'edv' }` descriptor store JWE envelopes the server
// cannot read, and the ordinary collection handles encrypt on write and
// decrypt on read (the pws-client pass-through model).
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
    throw new CollectionExistsError(`The collection "${id}" exists and is not encrypted.`)
  }
  const keyAgreementKey = currentKeyAgreementKey()
  await ensureFirstEpoch({
    collection,
    recipients: [ownerRecipient({ keyAgreementKey })],
  })
  encryptedState.set(`${collection.spaceUrl}${collection.id}`, true)
  if (!described && name) {
    await collection.setMeta({
      custom: { name, ...(description && { tags: { description } }) },
    })
  }
}

// The collections this session has declared encrypted, so a repeated
// ensure costs nothing.
const encryptedState = new Map<string, boolean>()
