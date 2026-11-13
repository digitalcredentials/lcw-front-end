import type { RxCollection, RxDatabase, RxJsonSchema, RxStorage } from 'rxdb/plugins/core'
import type { SyncedDoc } from '@interop/pws-sync'

// The local replica's database: one RxDB database per account Space, in
// this browser's IndexedDB (Dexie storage), holding one collection per
// synced PWS collection. Each row is the server's stored body, unchanged:
// on an encrypted collection that is the EDV envelope (`data`) and the
// encrypted metadata envelope (`custom`), so the replica holds no plaintext
// and no key material; the store decrypts on read. The schema is
// pws-sync's synced-document schema, shared with FreeWallet.
//
// RxDB is loaded on demand, so the eager bundle stays free of it: only a
// remembered session opens a replica.

// The replica's collections, keyed as RxDB names them (lower camel case),
// each mapped to the PWS collection it mirrors
export const REPLICA_COLLECTIONS = {
  privateCredentials: 'private-credentials',
  publicCredentials: 'public-credentials',
  walletActivity: 'wallet-activity',
} as const

export type ReplicaKey = keyof typeof REPLICA_COLLECTIONS
export type ReplicaCollections = Record<ReplicaKey, RxCollection<SyncedDoc>>
export type ReplicaDatabase = RxDatabase<ReplicaCollections>
export type ReplicaStorage = RxStorage<unknown, unknown>

// The database's name: RxDB takes lower-case names, and a Space id is not
// one, so the id is hashed
export async function replicaName(spaceId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(spaceId))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `lcw-replica-${hex.slice(0, 32)}`
}

// Whether an error is RxDB's refusal to open a collection whose stored
// schema differs from the one asked for (a replica written by an earlier
// version of the schema)
const isSchemaMismatch = (err: unknown) => (err as { code?: string })?.code === 'DB6'

async function defaultStorage(): Promise<ReplicaStorage> {
  const { getRxStorageDexie } = await import('rxdb/plugins/storage-dexie')
  return getRxStorageDexie() as ReplicaStorage
}

// Opens the Space's replica, creating it on first use. A replica whose
// stored schema no longer matches is forgotten and re-created: its rows
// are re-pulled from the Space at the next sync (pws-sync ships its schema
// without a migration path).
export async function openReplica({ spaceId, storage }: { spaceId: string; storage?: ReplicaStorage }): Promise<ReplicaDatabase> {
  const { createRxDatabase } = await import('rxdb/plugins/core')
  const { syncedDocSchema } = await import('@interop/pws-sync')
  const rxStorage = storage ?? (await defaultStorage())
  const name = await replicaName(spaceId)
  const create = () => createRxDatabase<ReplicaCollections>({ name, storage: rxStorage, multiInstance: false, closeDuplicates: true })
  const schema = syncedDocSchema() as unknown as RxJsonSchema<SyncedDoc>
  const collections = Object.fromEntries(Object.keys(REPLICA_COLLECTIONS).map((key) => [key, { schema }])) as Record<ReplicaKey, { schema: RxJsonSchema<SyncedDoc> }>
  let db = await create()
  try {
    await db.addCollections(collections)
  } catch (err) {
    if (!isSchemaMismatch(err)) {
      await db.close().catch(() => undefined)
      throw err
    }
    console.warn('Wallet: the local replica was written under an earlier schema and is re-created; it fills again from the account.')
    await db.remove()
    db = await create()
    await db.addCollections(collections)
  }
  return db
}

// Deletes the Space's replica from this browser.
export async function removeReplica({ spaceId, storage }: { spaceId: string; storage?: ReplicaStorage }): Promise<void> {
  const { removeRxDatabase } = await import('rxdb/plugins/core')
  await removeRxDatabase(await replicaName(spaceId), storage ?? (await defaultStorage()))
}
