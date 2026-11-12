import type { ResourceData, Space } from '@interop/pws-client'
import { resourceUrl } from '@interop/pws-client/paths'
import {
  PRIVATE_CREDENTIALS_COLLECTION,
  PUBLIC_CREDENTIALS_COLLECTION,
  WALLET_ACTIVITY_COLLECTION,
  addHistoryCredentialCreated,
  addHistoryCredentialDeleted,
  addHistoryCredentialShared,
  addHistoryCredentialUnshared,
} from '@interop/wallet-core/space'
import { ensureEncryptedCollection } from './edv'
import { getSession } from './identity/session'
import { credentialFrom, credentialName } from './linkedin'

// The account Space's credentials in FreeWallet's layout, so a credential
// stored by either wallet is seen by both:
//
//   private-credentials  every credential, one encrypted resource each,
//                        under the id the encrypting codec derives from
//                        its envelope (its "cid")
//   public-credentials   a plaintext copy of each shared credential, under
//                        the same cid, in a collection that is readable by
//                        anyone: the public link
//   wallet-activity      one entry per claim, share, unshare and delete
//
// The holder's tags on a credential are the keys of its own metadata's
// `custom.tags` map (the PWS resource metadata object, encrypted with the
// credential on an encrypted collection), so they travel with it and no
// other wallet overwrites them. This wallet's own records live beside the
// credentials, encrypted, in collections FreeWallet leaves alone:
//
//   Trash  a deleted credential's body and tags, until it is restored (as
//          a new resource) or deleted for good
//   dids   the holder keys of credentials claimed with a did:key

export const TRASH_COLLECTION = 'Trash'
export const DIDS_COLLECTION = 'dids'

export type CredentialBody = Record<string, unknown>

export interface StoredCredential {
  cid: string
  // The stored body: a presentation envelope or a bare credential
  body: CredentialBody
  tags: string[]
}

// What Trash stores for a deleted credential
interface TrashRecord {
  cid: string
  tags: string[]
  body: CredentialBody
}

export interface TrashItem extends TrashRecord {
  // The Trash resource's own id
  id: string
}

const privateCredentials = (space: Space) => space.collection(PRIVATE_CREDENTIALS_COLLECTION)
const publicCredentials = (space: Space) => space.collection(PUBLIC_CREDENTIALS_COLLECTION, { encryption: 'plaintext' })

const parsed = (data: unknown): CredentialBody | null =>
  data === null || data === undefined || data instanceof Blob || typeof data !== 'object' ? null : (data as CredentialBody)

async function readBody(space: Space, collectionId: string, id: string): Promise<CredentialBody | null> {
  const data = await space.collection(collectionId).resource(id).get()
  if (data instanceof Blob) {
    try {
      return parsed(JSON.parse(await data.text()))
    } catch {
      return null
    }
  }
  return parsed(data)
}

// The title an activity entry names a credential by
function titleOf(body: CredentialBody): string | undefined {
  const credential = credentialFrom(body)
  return credential ? credentialName(credential) : undefined
}

// Appends an entry to the activity log. Best effort: the log is a record
// of what happened, never a condition for it.
async function recordActivity(space: Space, entry: object): Promise<void> {
  try {
    await space.collection(WALLET_ACTIVITY_COLLECTION).add(entry as unknown as ResourceData)
  } catch (err) {
    console.warn('The activity entry could not be written:', err)
  }
}

const user = () => ({ email: getSession()?.email ?? '' })

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

export async function readTags(space: Space, cid: string): Promise<string[]> {
  const meta = await privateCredentials(space).resource(cid).meta()
  return tagsOf(meta?.custom)
}

// Replaces a credential's tags (its metadata's `name`, if any, is kept)
export async function setTags(space: Space, cid: string, tags: Iterable<string>): Promise<void> {
  await privateCredentials(space).resource(cid).setTags(Object.fromEntries(normalizeTags(tags).map((tag) => [tag, ''])))
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

// --- credentials -------------------------------------------------------------

// The cids of every stored credential
export async function listCredentialIds(space: Space): Promise<string[]> {
  const listing = await privateCredentials(space).list()
  return (listing?.items ?? []).map((item) => item.id)
}

// A stored credential's body, or null when there is none under the cid
export const readCredential = (space: Space, cid: string): Promise<CredentialBody | null> =>
  readBody(space, PRIVATE_CREDENTIALS_COLLECTION, cid)

// Every stored credential with its tags. One that cannot be read (not
// JSON, or not decryptable) is left out.
export async function loadCredentials(space: Space): Promise<StoredCredential[]> {
  const ids = await listCredentialIds(space)
  const loaded = await Promise.all(
    ids.map(async (cid): Promise<StoredCredential | null> => {
      try {
        const [body, tags] = await Promise.all([readCredential(space, cid), readTags(space, cid).catch(() => [] as string[])])
        return body ? { cid, body, tags } : null
      } catch {
        return null
      }
    })
  )
  return loaded.filter((c): c is StoredCredential => c !== null)
}

// Stores a credential with its tags. Resolves to its cid.
export async function addCredential({ space, body, tags = [] }: { space: Space; body: CredentialBody; tags?: Iterable<string> }): Promise<{ cid: string }> {
  const { id: cid } = await privateCredentials(space).add(body as unknown as ResourceData)
  const normalized = normalizeTags(tags)
  if (normalized.length) {
    await setTags(space, cid, normalized)
  }
  await recordActivity(space, addHistoryCredentialCreated({ cid, title: titleOf(body), user: user() }))
  return { cid }
}

// Moves a credential to Trash: its body and tags are kept there, its
// public copy is taken down, and the credential itself is deleted.
export async function deleteCredential({ space, cid }: { space: Space; cid: string }): Promise<void> {
  const body = await readCredential(space, cid)
  if (body) {
    const tags = await readTags(space, cid).catch(() => [] as string[])
    await ensureCollection(space, TRASH_COLLECTION, 'Trash')
    const record: TrashRecord = { cid, tags, body }
    await space.collection(TRASH_COLLECTION).add(record as unknown as ResourceData)
  }
  if (await findPublicCopy(space, cid)) {
    await removePublicCopy(space, cid)
  }
  await privateCredentials(space).resource(cid).delete()
  await recordActivity(space, addHistoryCredentialDeleted({ cid, title: body ? titleOf(body) : undefined, user: user() }))
}

// Puts a trashed credential back, as a new resource (a new cid) with its
// tags, and drops the Trash record.
export async function restoreCredential({ space, item }: { space: Space; item: TrashItem }): Promise<{ cid: string }> {
  const { cid } = await addCredential({ space, body: item.body, tags: item.tags })
  await space.collection(TRASH_COLLECTION).resource(item.id).delete()
  return { cid }
}

// Deletes a trashed credential for good
export async function discardTrashItem(space: Space, item: TrashItem): Promise<void> {
  await space.collection(TRASH_COLLECTION).resource(item.id).delete()
}

// --- trash -------------------------------------------------------------------

const ensured = new Set<string>()
async function ensureCollection(space: Space, id: string, name: string): Promise<void> {
  const key = `${space.collection(id).spaceUrl}${id}`
  if (ensured.has(key)) {
    return
  }
  await ensureEncryptedCollection({ space, id, name })
  ensured.add(key)
}

export async function listTrash(space: Space): Promise<TrashItem[]> {
  const listing = await space.collection(TRASH_COLLECTION).list().catch(() => null)
  const items = await Promise.all(
    (listing?.items ?? []).map(async (item): Promise<TrashItem | null> => {
      const record = await readBody(space, TRASH_COLLECTION, item.id).catch(() => null)
      if (!record || typeof record.cid !== 'string' || !record.body || typeof record.body !== 'object') {
        return null
      }
      const tags = Array.isArray(record.tags) ? normalizeTags(record.tags.filter((t): t is string => typeof t === 'string')) : []
      return { id: item.id, cid: record.cid, tags, body: record.body as CredentialBody }
    })
  )
  return items.filter((i): i is TrashItem => i !== null)
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

// Publishes the credential's body as its public copy. Resolves to its URL,
// the same each time the credential is shared.
export async function createPublicCopy(space: Space, cid: string, body: CredentialBody): Promise<string> {
  await publicCredentials(space).put(cid, body as unknown as ResourceData)
  await recordActivity(space, addHistoryCredentialShared({ cid, title: titleOf(body), user: user() }))
  return publicCopyUrl(space, cid)
}

// Takes the public copy down, so the link stops working until it is shared
// again
export async function removePublicCopy(space: Space, cid: string): Promise<void> {
  await publicCredentials(space).resource(cid).delete()
  await recordActivity(space, addHistoryCredentialUnshared({ cid, user: user() }))
}
