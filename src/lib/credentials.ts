import type { ResourceData, Space } from '@interop/pws-client'
import { resourceUrl } from '@interop/pws-client/paths'
import { cidFrom } from '@interop/pws-client/sync'
import { PRIVATE_CREDENTIALS_COLLECTION, PUBLIC_CREDENTIALS_COLLECTION, WALLET_ACTIVITY_COLLECTION } from '@interop/wallet-core/space'

// The account Space's credentials in FreeWallet's layout, so a credential
// stored by either wallet is seen by both:
//
//   private-credentials  every credential, as the bare Verifiable
//                        Credential, one encrypted resource each. The
//                        resource id derives from the ciphertext, so the
//                        same credential stored twice sits in two
//                        resources; the credential itself is known by its
//                        content cid, the hash of the canonicalized
//                        credential, the same in every wallet
//   public-credentials   a plaintext copy of each shared credential, under
//                        its content cid, in a collection readable by
//                        anyone: the public link
//   wallet-activity      one entry per claim, share, unshare and delete,
//                        naming the credential by its content cid
//
// The holder's tags on a credential are the keys of its resource's own
// metadata `custom.tags` map (the PWS resource metadata object, encrypted
// with the credential on an encrypted collection), so they travel with it
// and no other wallet overwrites them. This wallet's own records live
// beside the credentials, encrypted, in collections FreeWallet leaves
// alone:
//
//   Trash  a deleted credential's body and tags, until it is restored (as
//          a new resource) or deleted for good
//   dids   the holder keys of credentials claimed with a did:key
//
// These are the direct primitives over the Space, by resource id; the
// credential store (src/lib/credentialStore.ts) keys them by content cid.

export const TRASH_COLLECTION = 'Trash'
export const DIDS_COLLECTION = 'dids'

// A credential as stored: the Verifiable Credential object itself
export type CredentialBody = Record<string, unknown>

export interface StoredCredential {
  // The content cid: the hash of the canonicalized credential, the same
  // wherever it is stored
  cid: string
  // The resource holding this copy of it
  rid: string
  body: CredentialBody
  tags: string[]
}

// What Trash stores for a deleted credential
export interface TrashRecord {
  cid: string
  tags: string[]
  body: CredentialBody
}

export interface TrashItem extends TrashRecord {
  // The Trash resource's own id
  id: string
}

// The content cid of a credential: pws-client's `cidFrom`, which FreeWallet
// keys its public copies and activity entries by
export const contentCid = (body: CredentialBody): string => cidFrom({ doc: body })

// Whether a stored body is a credential: typed as one, or carrying a subject
export function isCredential(data: unknown): data is CredentialBody {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false
  }
  const { type, credentialSubject } = data as { type?: unknown; credentialSubject?: unknown }
  return [type ?? []].flat().includes('VerifiableCredential') || (typeof credentialSubject === 'object' && credentialSubject !== null)
}

const privateCredentials = (space: Space) => space.collection(PRIVATE_CREDENTIALS_COLLECTION)
const publicCredentials = (space: Space) => space.collection(PUBLIC_CREDENTIALS_COLLECTION, { encryption: 'plaintext' })

async function readJson(space: Space, collectionId: string, id: string): Promise<unknown> {
  const data = await space.collection(collectionId).resource(id).get()
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text())
    } catch {
      return null
    }
  }
  return data
}

// Appends an entry to the activity log. Best effort: the log is a record
// of what happened, never a condition for it.
export async function recordActivity(space: Space, entry: object): Promise<void> {
  try {
    await space.collection(WALLET_ACTIVITY_COLLECTION).add(entry as unknown as ResourceData)
  } catch (err) {
    console.warn('The activity entry could not be written:', err)
  }
}

// --- tags --------------------------------------------------------------------

// Tags as the holder typed them, trimmed, without blanks or repeats
export function normalizeTags(tags: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}

function tagsOf(custom: unknown): string[] {
  const tags = (custom as { tags?: unknown } | null | undefined)?.tags
  return tags && typeof tags === 'object' ? normalizeTags(Object.keys(tags as object)) : []
}

export async function readTags(space: Space, rid: string): Promise<string[]> {
  const meta = await privateCredentials(space).resource(rid).meta()
  return tagsOf(meta?.custom)
}

// Replaces a resource's tags (its metadata's `name`, if any, is kept)
export async function setTags(space: Space, rid: string, tags: Iterable<string>): Promise<void> {
  await privateCredentials(space).resource(rid).setTags(Object.fromEntries(normalizeTags(tags).map((tag) => [tag, ''])))
}

// Every tag in use, with the number of credentials carrying it
export function tagCounts(credentials: { tags: string[] }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const { tags } of credentials) {
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return counts
}

// --- resources ---------------------------------------------------------------

// The ids of every resource in private-credentials
export async function listResourceIds(space: Space): Promise<string[]> {
  const listing = await privateCredentials(space).list()
  return (listing?.items ?? []).map((item) => item.id)
}

// The credential a resource holds, or null when there is no such resource
// or what it holds is not a credential
export async function readResource(space: Space, rid: string): Promise<CredentialBody | null> {
  const data = await readJson(space, PRIVATE_CREDENTIALS_COLLECTION, rid)
  return isCredential(data) ? data : null
}

// Every resource holding a credential, with its content cid and tags. One
// that cannot be read (not JSON, not decryptable, not a credential) is left
// out.
export async function loadCredentials(space: Space): Promise<StoredCredential[]> {
  const ids = await listResourceIds(space)
  const loaded = await Promise.all(
    ids.map(async (rid): Promise<StoredCredential | null> => {
      try {
        const [body, tags] = await Promise.all([readResource(space, rid), readTags(space, rid).catch(() => [] as string[])])
        return body ? { cid: contentCid(body), rid, body, tags } : null
      } catch {
        return null
      }
    })
  )
  return loaded.filter((c): c is StoredCredential => c !== null)
}

// Stores a credential in a resource of its own, with its tags
export async function addCredential({ space, body, tags = [] }: { space: Space; body: CredentialBody; tags?: Iterable<string> }): Promise<{ cid: string; rid: string }> {
  const { id: rid } = await privateCredentials(space).add(body as unknown as ResourceData)
  const normalized = normalizeTags(tags)
  if (normalized.length) {
    await setTags(space, rid, normalized)
  }
  return { cid: contentCid(body), rid }
}

export async function deleteResource(space: Space, rid: string): Promise<void> {
  await privateCredentials(space).resource(rid).delete()
}

// --- trash -------------------------------------------------------------------

export async function listTrash(space: Space): Promise<TrashItem[]> {
  const listing = await space.collection(TRASH_COLLECTION).list().catch(() => null)
  const items = await Promise.all(
    (listing?.items ?? []).map(async (item): Promise<TrashItem | null> => {
      const record = (await readJson(space, TRASH_COLLECTION, item.id).catch(() => null)) as Partial<TrashRecord> | null
      if (!record || typeof record.cid !== 'string' || !isCredential(record.body)) {
        return null
      }
      const tags = Array.isArray(record.tags) ? normalizeTags(record.tags.filter((t): t is string => typeof t === 'string')) : []
      return { id: item.id, cid: record.cid, tags, body: record.body }
    })
  )
  return items.filter((i): i is TrashItem => i !== null)
}

// Deletes a trashed credential for good
export async function discardTrashItem(space: Space, item: TrashItem): Promise<void> {
  await space.collection(TRASH_COLLECTION).resource(item.id).delete()
}

// --- public copies (the public link) -----------------------------------------

// The URL anyone can read a shared credential at
export function publicCopyUrl(space: Space, cid: string): string {
  return resourceUrl({ spaceUrl: publicCredentials(space).spaceUrl, collectionId: PUBLIC_CREDENTIALS_COLLECTION, resourceId: cid })
}

// Whether the credential has a public copy
export async function findPublicCopy(space: Space, cid: string): Promise<boolean> {
  return (await publicCredentials(space).resource(cid).get()) !== null
}

// Publishes the credential as its public copy. Resolves to its URL, the
// same each time the credential is shared.
export async function createPublicCopy(space: Space, cid: string, body: CredentialBody): Promise<string> {
  await publicCredentials(space).put(cid, body as unknown as ResourceData)
  return publicCopyUrl(space, cid)
}

// Takes the public copy down, so the link stops working until the
// credential is shared again
export async function removePublicCopy(space: Space, cid: string): Promise<void> {
  await publicCredentials(space).resource(cid).delete()
}
