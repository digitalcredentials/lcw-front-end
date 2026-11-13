import type { ResourceData, Space } from '@interop/pws-client'
import { addHistoryCredentialCreated, addHistoryCredentialDeleted, addHistoryCredentialShared, addHistoryCredentialUnshared } from '@interop/wallet-core/space'
import {
  TRASH_COLLECTION,
  addCredential as addDirect,
  contentCid,
  createPublicCopy as createPublicCopyDirect,
  deleteResource,
  discardTrashItem,
  findPublicCopy as findPublicCopyDirect,
  listTrash,
  loadCredentials as loadDirect,
  normalizeTags,
  publicCopyUrl as publicCopyUrlDirect,
  readResource,
  readTags as readTagsDirect,
  recordActivity as recordActivityDirect,
  removePublicCopy as removePublicCopyDirect,
  setTags as setTagsDirect,
  type CredentialBody,
  type StoredCredential,
  type TrashItem,
} from './credentials'
import { getSession } from './identity/session'
import { credentialName, type CredentialLike } from './linkedin'
import { ensureEncryptedCollection } from './edv'
import { ensureReplica } from './replica/replica'
import { replicaRows } from './replica/store'
import { getSessionWASClient } from './was'

// The account's credentials as the signed-in pages use them: keyed by
// content cid, the hash of the canonicalized credential, which is the same
// in every wallet, over one of two row stores: a remembered session's local
// replica (the synced collections pulled into this browser and pushed
// back), or direct access to the Space for a password session and the
// CHAPI popup. Trash and the holder keys (`dids`) are this wallet's own
// collections, read and written directly whichever store the credentials
// use.

// The rows a store holds: one resource per stored copy of a credential
export interface CredentialRows {
  kind: 'replica' | 'direct'
  // Every resource holding a credential
  all(): Promise<StoredCredential[]>
  read(rid: string): Promise<CredentialBody | null>
  readTags(rid: string): Promise<string[]>
  setTags(rid: string, tags: Iterable<string>): Promise<void>
  insert(input: { body: CredentialBody; tags: Iterable<string> }): Promise<{ cid: string; rid: string }>
  remove(rid: string): Promise<void>
  findPublicCopy(cid: string): Promise<boolean>
  createPublicCopy(cid: string, body: CredentialBody): Promise<string>
  removePublicCopy(cid: string): Promise<void>
  publicCopyUrl(cid: string): string
  recordActivity(entry: object): Promise<void>
  // Called when a change reached the rows from elsewhere (a replica's
  // pull); the direct rows never call it
  subscribe(listener: () => void): () => void
}

export interface CredentialStore {
  kind: 'replica' | 'direct'
  // One entry per credential: the first resource holding it
  loadCredentials(): Promise<StoredCredential[]>
  readCredential(cid: string): Promise<CredentialBody | null>
  readTags(cid: string): Promise<string[]>
  // Stores a credential unless it is stored already (the same credential
  // again is the one already there, with the tags it has)
  addCredential(input: { body: CredentialBody; tags?: Iterable<string> }): Promise<{ cid: string; rid: string; created: boolean }>
  setTags(cid: string, tags: Iterable<string>): Promise<void>
  // Deletes every resource holding the credential
  deleteCredential(cid: string): Promise<void>
  findPublicCopy(cid: string): Promise<boolean>
  createPublicCopy(cid: string, body: CredentialBody): Promise<string>
  removePublicCopy(cid: string): Promise<void>
  publicCopyUrl(cid: string): string
  subscribe(listener: () => void): () => void
}

const user = () => ({ email: getSession()?.email ?? '' })
const titleOf = (body: CredentialBody) => credentialName(body as CredentialLike)

// The store over a set of rows: an index from content cid to the resources
// holding the credential, built from a listing and rebuilt when a cid is
// not found (a resource another wallet wrote since), and the activity
// entries every write records.
export function credentialStore(rows: CredentialRows): CredentialStore {
  let index = new Map<string, string[]>()
  let indexed = false

  async function refresh(): Promise<StoredCredential[]> {
    const all = await rows.all()
    const next = new Map<string, string[]>()
    for (const { cid, rid } of all) {
      next.set(cid, [...(next.get(cid) ?? []), rid])
    }
    index = next
    indexed = true
    return all
  }

  // The resources holding the credential, with the first one's body: from
  // the index, re-listed once when the index does not know the cid or the
  // resource it names is gone (deleted elsewhere since, and the credential
  // may be back in another resource)
  async function locate(cid: string): Promise<{ rids: string[]; body: CredentialBody | null }> {
    if (!indexed || !index.has(cid)) {
      await refresh()
    }
    let rids = index.get(cid) ?? []
    let body = rids[0] ? await rows.read(rids[0]) : null
    if (rids.length && !body) {
      await refresh()
      rids = index.get(cid) ?? []
      body = rids[0] ? await rows.read(rids[0]) : null
    }
    return { rids, body }
  }

  return {
    kind: rows.kind,
    async loadCredentials() {
      const seen = new Set<string>()
      return (await refresh()).filter(({ cid }) => !seen.has(cid) && seen.add(cid))
    },
    async readCredential(cid) {
      return (await locate(cid)).body
    },
    async readTags(cid) {
      const [rid] = (await locate(cid)).rids
      return rid ? rows.readTags(rid) : []
    },
    async addCredential({ body, tags = [] }) {
      const cid = contentCid(body)
      const existing = await locate(cid)
      if (existing.body) {
        return { cid, rid: existing.rids[0], created: false }
      }
      const { rid } = await rows.insert({ body, tags: normalizeTags(tags) })
      index.set(cid, [rid])
      await rows.recordActivity(addHistoryCredentialCreated({ cid, title: titleOf(body), user: user() }))
      return { cid, rid, created: true }
    },
    async setTags(cid, tags) {
      const { rids, body } = await locate(cid)
      if (!body) {
        throw new Error('The credential is no longer stored.')
      }
      for (const rid of rids) {
        await rows.setTags(rid, tags)
      }
    },
    async deleteCredential(cid) {
      const { rids, body } = await locate(cid)
      for (const rid of rids) {
        await rows.remove(rid)
      }
      index.delete(cid)
      await rows.recordActivity(addHistoryCredentialDeleted({ cid, title: body ? titleOf(body) : undefined, user: user() }))
    },
    findPublicCopy: (cid) => rows.findPublicCopy(cid),
    async createPublicCopy(cid, body) {
      const url = await rows.createPublicCopy(cid, body)
      await rows.recordActivity(addHistoryCredentialShared({ cid, title: titleOf(body), user: user() }))
      return url
    },
    async removePublicCopy(cid) {
      await rows.removePublicCopy(cid)
      await rows.recordActivity(addHistoryCredentialUnshared({ cid, user: user() }))
    },
    publicCopyUrl: (cid) => rows.publicCopyUrl(cid),
    subscribe: (listener) => rows.subscribe(listener),
  }
}

// The Space's rows through the session's handles
export function directRows(space: Space): CredentialRows {
  return {
    kind: 'direct',
    all: () => loadDirect(space),
    read: (rid) => readResource(space, rid),
    readTags: (rid) => readTagsDirect(space, rid),
    setTags: (rid, tags) => setTagsDirect(space, rid, tags),
    insert: ({ body, tags }) => addDirect({ space, body, tags }),
    remove: (rid) => deleteResource(space, rid),
    findPublicCopy: (cid) => findPublicCopyDirect(space, cid),
    createPublicCopy: (cid, body) => createPublicCopyDirect(space, cid, body),
    removePublicCopy: (cid) => removePublicCopyDirect(space, cid),
    publicCopyUrl: (cid) => publicCopyUrlDirect(space, cid),
    recordActivity: (entry) => recordActivityDirect(space, entry),
    subscribe: () => () => undefined,
  }
}

// The store over direct access to a Space (the scripts' store too)
export const directCredentialStore = (space: Space): CredentialStore => credentialStore(directRows(space))

export interface SessionStores {
  store: CredentialStore
  // The account Space's handle, for Trash and the holder keys
  space: Space
}

// The stores for the signed-in session: the replica when the session is a
// remembered one and the replica could start, direct access otherwise.
export async function sessionStores(): Promise<SessionStores | null> {
  const session = getSession()
  const client = await getSessionWASClient()
  if (!session || !client) {
    return null
  }
  const replica = await ensureReplica(session)
  const store = replica ? credentialStore(replicaRows({ replica })) : directCredentialStore(client.space)
  return { store, space: client.space }
}

// --- Trash, over whichever store holds the credentials --------------------

// Moves a credential to Trash: its body and tags are kept there (a record
// in this wallet's own encrypted collection), its public copy is taken
// down, and the credential is deleted from the store.
export async function trashCredential({ store, space, cid }: SessionStores & { cid: string }): Promise<void> {
  const body = await store.readCredential(cid)
  if (body) {
    const tags = await store.readTags(cid).catch(() => [] as string[])
    await ensureEncryptedCollection({ space, id: TRASH_COLLECTION, name: 'Trash' })
    await space.collection(TRASH_COLLECTION).add({ cid, tags, body } as unknown as ResourceData)
  }
  if (await store.findPublicCopy(cid)) {
    await store.removePublicCopy(cid)
  }
  await store.deleteCredential(cid)
}

// Puts a trashed credential back, in a new resource (the same content cid)
// with its tags, and drops the Trash record.
export async function restoreFromTrash({ store, space, item }: SessionStores & { item: TrashItem }): Promise<{ cid: string; rid: string }> {
  const { cid, rid } = await store.addCredential({ body: item.body, tags: item.tags })
  await space.collection(TRASH_COLLECTION).resource(item.id).delete()
  return { cid, rid }
}

export { listTrash, discardTrashItem, normalizeTags }
export type { CredentialBody, StoredCredential, TrashItem }
