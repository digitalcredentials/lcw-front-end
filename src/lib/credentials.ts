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
// This wallet's own records live beside them, encrypted, in collections
// FreeWallet leaves alone:
//
//   lcw-groups  the groups the user files credentials under (what the
//               space browser shows as folders): one record per group,
//               naming its members by cid
//   Trash       a deleted credential's body and group, until it is
//               restored (as a new resource) or deleted for good
//   dids        the holder keys of credentials claimed with a did:key

export const GROUPS_COLLECTION = 'lcw-groups'
export const TRASH_COLLECTION = 'Trash'
export const DIDS_COLLECTION = 'dids'

export type CredentialBody = Record<string, unknown>

export interface Group {
  id: string
  name: string
  description?: string
  // The cids of the credentials filed under the group
  members: string[]
}

// What Trash stores for a deleted credential
interface TrashRecord {
  cid: string
  groupId: string | null
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

// --- credentials -------------------------------------------------------------

// The cids of every stored credential
export async function listCredentialIds(space: Space): Promise<string[]> {
  const listing = await privateCredentials(space).list()
  return (listing?.items ?? []).map((item) => item.id)
}

// A stored credential's body (a presentation envelope or a bare
// credential), or null when there is none under the cid
export const readCredential = (space: Space, cid: string): Promise<CredentialBody | null> =>
  readBody(space, PRIVATE_CREDENTIALS_COLLECTION, cid)

// Stores a credential and files it under a group (none: left ungrouped).
// Resolves to its cid.
export async function addCredential({ space, body, groupId }: { space: Space; body: CredentialBody; groupId?: string | null }): Promise<{ cid: string }> {
  const { id: cid } = await privateCredentials(space).add(body as unknown as ResourceData)
  if (groupId) {
    await addMember(space, groupId, cid)
  }
  await recordActivity(space, addHistoryCredentialCreated({ cid, title: titleOf(body), user: user() }))
  return { cid }
}

// Moves a credential to Trash: its body and group are kept there, its
// public copy is taken down, and the credential itself is deleted.
export async function deleteCredential({ space, cid, groupId }: { space: Space; cid: string; groupId: string | null }): Promise<void> {
  const body = await readCredential(space, cid)
  if (body) {
    await ensureCollection(space, TRASH_COLLECTION, 'Trash')
    const record: TrashRecord = { cid, groupId, body }
    await space.collection(TRASH_COLLECTION).add(record as unknown as ResourceData)
  }
  if (await findPublicCopy(space, cid)) {
    await removePublicCopy(space, cid)
  }
  await privateCredentials(space).resource(cid).delete()
  if (groupId) {
    await removeMember(space, groupId, cid)
  }
  await recordActivity(space, addHistoryCredentialDeleted({ cid, title: body ? titleOf(body) : undefined, user: user() }))
}

// Puts a trashed credential back, as a new resource (a new cid), under the
// chosen group, and drops the Trash record.
export async function restoreCredential({ space, item, groupId }: { space: Space; item: TrashItem; groupId: string | null }): Promise<{ cid: string }> {
  const { cid } = await addCredential({ space, body: item.body, groupId })
  await space.collection(TRASH_COLLECTION).resource(item.id).delete()
  return { cid }
}

// Deletes a trashed credential for good
export async function discardTrashItem(space: Space, item: TrashItem): Promise<void> {
  await space.collection(TRASH_COLLECTION).resource(item.id).delete()
}

// Files a credential under another group
export async function moveCredential({ space, cid, fromGroupId, toGroupId }: { space: Space; cid: string; fromGroupId: string | null; toGroupId: string | null }): Promise<void> {
  if (fromGroupId === toGroupId) {
    return
  }
  if (fromGroupId) {
    await removeMember(space, fromGroupId, cid)
  }
  if (toGroupId) {
    await addMember(space, toGroupId, cid)
  }
}

// --- groups ------------------------------------------------------------------

const ensured = new Set<string>()
async function ensureCollection(space: Space, id: string, name: string): Promise<void> {
  const key = `${space.collection(id).spaceUrl}${id}`
  if (ensured.has(key)) {
    return
  }
  await ensureEncryptedCollection({ space, id, name })
  ensured.add(key)
}

function groupFrom(id: string, record: CredentialBody | null): Group | null {
  if (!record || typeof record.name !== 'string') {
    return null
  }
  const members = Array.isArray(record.members) ? record.members.filter((m): m is string => typeof m === 'string') : []
  return { id, name: record.name, ...(typeof record.description === 'string' && record.description && { description: record.description }), members }
}

// Every group, in the order the collection lists them
export async function listGroups(space: Space): Promise<Group[]> {
  const listing = await space.collection(GROUPS_COLLECTION).list().catch(() => null)
  const groups = await Promise.all((listing?.items ?? []).map(async (item) => groupFrom(item.id, await readBody(space, GROUPS_COLLECTION, item.id).catch(() => null))))
  return groups.filter((g): g is Group => g !== null)
}

export async function readGroup(space: Space, id: string): Promise<Group | null> {
  return groupFrom(id, await readBody(space, GROUPS_COLLECTION, id).catch(() => null))
}

export async function createGroup({ space, name, description }: { space: Space; name: string; description?: string }): Promise<Group> {
  await ensureCollection(space, GROUPS_COLLECTION, 'Groups')
  const record = { name, ...(description && { description }), members: [] as string[] }
  const { id } = await space.collection(GROUPS_COLLECTION).add(record as unknown as ResourceData)
  return { id, ...record }
}

// Rewrites a group's record (name, description, members) in place
export async function updateGroup(space: Space, group: Group): Promise<void> {
  const { id, ...record } = group
  await space.collection(GROUPS_COLLECTION).put(id, record as unknown as ResourceData)
}

export async function deleteGroup(space: Space, id: string): Promise<void> {
  await space.collection(GROUPS_COLLECTION).resource(id).delete()
}

async function addMember(space: Space, groupId: string, cid: string): Promise<void> {
  const group = await readGroup(space, groupId)
  if (group && !group.members.includes(cid)) {
    await updateGroup(space, { ...group, members: [...group.members, cid] })
  }
}

async function removeMember(space: Space, groupId: string, cid: string): Promise<void> {
  const group = await readGroup(space, groupId)
  if (group?.members.includes(cid)) {
    await updateGroup(space, { ...group, members: group.members.filter((m) => m !== cid) })
  }
}

// The group a credential is filed under, if any
export const groupOf = (groups: Group[], cid: string): Group | null => groups.find((g) => g.members.includes(cid)) ?? null

// --- trash -------------------------------------------------------------------

export async function listTrash(space: Space): Promise<TrashItem[]> {
  const listing = await space.collection(TRASH_COLLECTION).list().catch(() => null)
  const items = await Promise.all(
    (listing?.items ?? []).map(async (item): Promise<TrashItem | null> => {
      const record = await readBody(space, TRASH_COLLECTION, item.id).catch(() => null)
      if (!record || typeof record.cid !== 'string' || !record.body || typeof record.body !== 'object') {
        return null
      }
      return { id: item.id, cid: record.cid, groupId: typeof record.groupId === 'string' ? record.groupId : null, body: record.body as CredentialBody }
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
