import type { ResourceData, Space } from '@interop/pws-client'
import { addHistoryCredentialCreated, addHistoryCredentialDeleted, addHistoryCredentialShared, addHistoryCredentialUnshared } from '@interop/wallet-core/space'
import {
  TRASH_COLLECTION,
  addCredential as addDirect,
  createPublicCopy as createPublicCopyDirect,
  deleteCredential as deleteDirect,
  discardTrashItem,
  findPublicCopy as findPublicCopyDirect,
  listTrash,
  loadCredentials as loadDirect,
  normalizeTags,
  publicCopyUrl as publicCopyUrlDirect,
  readCredential as readDirect,
  readTags as readTagsDirect,
  removePublicCopy as removePublicCopyDirect,
  setTags as setTagsDirect,
  type CredentialBody,
  type StoredCredential,
  type TrashItem,
} from './credentials'
import { getSession } from './identity/session'
import { credentialFrom, credentialName } from './linkedin'
import { ensureEncryptedCollection } from './edv'
import { ensureReplica } from './replica/replica'
import { replicaStore } from './replica/store'
import { getSessionWASClient } from './was'

// The account's credentials as the signed-in pages use them, over one of
// two stores: a remembered session's local replica (the synced
// collections pulled into this browser and pushed back), or direct access
// to the Space for a password session and the CHAPI popup. Trash and the
// holder keys (`dids`) are this wallet's own collections, read and written
// directly whichever store the credentials use.

export interface CredentialStore {
  kind: 'replica' | 'direct'
  loadCredentials(): Promise<StoredCredential[]>
  readCredential(cid: string): Promise<CredentialBody | null>
  readTags(cid: string): Promise<string[]>
  addCredential(input: { body: CredentialBody; tags?: Iterable<string> }): Promise<{ cid: string }>
  setTags(cid: string, tags: Iterable<string>): Promise<void>
  deleteCredential(cid: string): Promise<void>
  findPublicCopy(cid: string): Promise<boolean>
  createPublicCopy(cid: string, body: CredentialBody): Promise<string>
  removePublicCopy(cid: string): Promise<void>
  publicCopyUrl(cid: string): string
  recordActivity(entry: object): Promise<void>
  // Called when a change reached the store from elsewhere (a replica's
  // pull); the direct store never calls it
  subscribe(listener: () => void): () => void
}

const user = () => ({ email: getSession()?.email ?? '' })

function titleOf(body: CredentialBody): string | undefined {
  const credential = credentialFrom(body)
  return credential ? credentialName(credential) : undefined
}

// The direct store: the Space's collections through the session's handles
function directStore(space: Space): CredentialStore {
  return {
    kind: 'direct',
    loadCredentials: () => loadDirect(space),
    readCredential: (cid) => readDirect(space, cid),
    readTags: (cid) => readTagsDirect(space, cid),
    // The direct functions write the activity entries themselves
    addCredential: ({ body, tags }) => addDirect({ space, body, tags }),
    setTags: (cid, tags) => setTagsDirect(space, cid, tags),
    deleteCredential: (cid) => deleteDirect({ space, cid }),
    findPublicCopy: (cid) => findPublicCopyDirect(space, cid),
    createPublicCopy: (cid, body) => createPublicCopyDirect(space, cid, body),
    removePublicCopy: (cid) => removePublicCopyDirect(space, cid),
    publicCopyUrl: (cid) => publicCopyUrlDirect(space, cid),
    recordActivity: async () => undefined,
    subscribe: () => () => undefined,
  }
}

// The replica store writes the activity entries the direct functions write
// themselves, so the two stores record the same history
function withActivity(store: CredentialStore): CredentialStore {
  return {
    ...store,
    async addCredential(input) {
      const result = await store.addCredential(input)
      await store.recordActivity(addHistoryCredentialCreated({ cid: result.cid, title: titleOf(input.body), user: user() }))
      return result
    },
    async deleteCredential(cid) {
      const body = await store.readCredential(cid)
      await store.deleteCredential(cid)
      await store.recordActivity(addHistoryCredentialDeleted({ cid, title: body ? titleOf(body) : undefined, user: user() }))
    },
    async createPublicCopy(cid, body) {
      const url = await store.createPublicCopy(cid, body)
      await store.recordActivity(addHistoryCredentialShared({ cid, title: titleOf(body), user: user() }))
      return url
    },
    async removePublicCopy(cid) {
      await store.removePublicCopy(cid)
      await store.recordActivity(addHistoryCredentialUnshared({ cid, user: user() }))
    },
  }
}

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
  const store = replica ? withActivity(replicaStore({ replica, activity: (entry) => entry })) : directStore(client.space)
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

// Puts a trashed credential back, as a new credential (a new cid) with its
// tags, and drops the Trash record.
export async function restoreFromTrash({ store, space, item }: SessionStores & { item: TrashItem }): Promise<{ cid: string }> {
  const { cid } = await store.addCredential({ body: item.body, tags: item.tags })
  await space.collection(TRASH_COLLECTION).resource(item.id).delete()
  return { cid }
}

export { listTrash, discardTrashItem, normalizeTags }
export type { CredentialBody, StoredCredential, TrashItem }
