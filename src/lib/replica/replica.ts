import { PwsClient } from '@interop/pws-client'
import type { SyncStatus } from '@interop/pws-client/sync'
import { spaceUrlById } from '@interop/pws-client/paths/layout'
import { encryptedWalletCollectionIds } from '@interop/wallet-core/space/collections'
import { walletSpaceProvisioner } from '@interop/wallet-core/keys'
import { ceremonyAuthority } from '../identity/authority'
import { sessionAgents, sessionEncryption, subscribeSession, type RememberedSession, type Session } from '../identity/session'
import { serviceDescriptionFor } from '../identity/service'
import { buildCiphers, type ReplicaCiphers } from './ciphers'
import { openReplica, removeReplica, REPLICA_COLLECTIONS, type ReplicaDatabase, type ReplicaKey, type ReplicaStorage } from './database'

// The replica a remembered session keeps: this tab's one running replica
// of the account Space's synced collections, pulled from the Space's
// changes feed and pushed back by pws-sync's RxDB replication, FreeWallet's
// way. A password session reads and writes the Space directly, as does the
// CHAPI popup (a window of its own, open for one exchange), so neither
// starts one.
//
// Lifecycle: `ensureReplica` opens the database, builds the ciphers, makes
// sure the Space's collections are provisioned, and starts replication; a
// sign-out stops it (the rows stay for the next sign-in); forgetting the
// browser deletes the database and the writer id with the client key
// record.

// How often the replica asks the Space for changes, the rate FreeWallet
// polls at
const POLL_MS = 30_000
// How long the first read after a start waits for the first pull to settle
const FIRST_SYNC_MS = 20_000
const WRITER_ID_PREFIX = 'lcw:'

export interface Replica {
  session: RememberedSession
  db: ReplicaDatabase
  ciphers: ReplicaCiphers
  spaceUrl: string
  // Resolves once the first pull has settled (or given up), so a read right
  // after a sign-in sees what the Space holds
  ready: Promise<void>
  status: Record<ReplicaKey, SyncStatus>
  // Listeners for a change that reached the replica from the Space, or a
  // row this tab wrote (the pages reload their view)
  subscribe(listener: () => void): () => void
  reSync(): void
  stop(): Promise<void>
}

let current: Replica | null = null
let starting: Promise<Replica | null> | null = null
let storageOverride: ReplicaStorage | undefined

// A storage for the replica other than the browser's IndexedDB (the
// scripts run the replica in memory)
export function setReplicaStorage(storage: ReplicaStorage | undefined): void {
  storageOverride = storage
}

// This tab's running replica for the session, or null
export function replicaFor(session: Session): Replica | null {
  return current && current.session.spaceId === session.spaceId ? current : null
}

const inPopup = () => typeof location !== 'undefined' && /chapi\.html$/.test(location.pathname)

// Whether the session reads through a replica: a remembered session in the
// wallet proper
export const replicaApplies = (session: Session): session is RememberedSession => session.kind === 'remembered' && !inPopup()

function writerIdStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage
    }
  } catch {
    // no storage: a per-session id below
  }
  const memory = new Map<string, string>()
  return { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) }
}

// Starts the session's replica, or hands back the one running. Resolves
// null, and the pages fall back to direct access, when the replica cannot
// start (the failure is logged).
export async function ensureReplica(session: Session): Promise<Replica | null> {
  if (!replicaApplies(session)) {
    return null
  }
  const running = replicaFor(session)
  if (running) {
    return running
  }
  if (starting) {
    return starting
  }
  starting = start(session)
    .catch((err) => {
      console.error('Wallet: the local replica could not start; the Space is read directly:', err)
      return null
    })
    .finally(() => {
      starting = null
    })
  return starting
}

async function start(session: RememberedSession): Promise<Replica> {
  if (current) {
    await current.stop()
  }
  const serviceDescription = await serviceDescriptionFor(session.serverUrl)
  const { signer } = await sessionAgents(session)
  const pws = PwsClient.fromSigner({ baseServerUrl: session.serverUrl, signer, encryption: sessionEncryption(session), serviceDescription })
  const spaceUrl = spaceUrlById({ baseServerUrl: session.serverUrl, spaceId: session.spaceId })
  const db = await openReplica({ spaceId: session.spaceId, storage: storageOverride })
  let ciphers: ReplicaCiphers
  try {
    // The Space's collections and their first key epochs, ensured before
    // anything is pushed (a no-op on an account this wallet or FreeWallet
    // set up)
    const authority = await ceremonyAuthority(session)
    await walletSpaceProvisioner({ pws, spaceId: session.spaceId, controllerDid: session.did, userKey: session.userKey, storeFor: authority.collections.storeFor, collectionIds: encryptedWalletCollectionIds() })().catch((err) =>
      console.warn('Wallet: the Space could not be provisioned for the replica; its collections are taken as they are:', err)
    )
    ciphers = await buildCiphers({ session, pws })
  } catch (err) {
    await db.close().catch(() => undefined)
    throw err
  }
  const { createSyncController } = await import('@interop/pws-sync/rxdb')
  const { getWriterId } = await import('@interop/pws-sync')
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const status: Record<ReplicaKey, SyncStatus> = { privateCredentials: 'idle', publicCredentials: 'idle', walletActivity: 'idle' }
  let settleFirst: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    settleFirst = resolve
  })
  const controller = createSyncController({
    port: {
      pwsClient: pws,
      spaceUrl,
      collections: (Object.keys(REPLICA_COLLECTIONS) as ReplicaKey[]).map((key) => ({ key, id: REPLICA_COLLECTIONS[key] })),
      rxCollection: (key) => db[key as ReplicaKey],
    },
    onStatus: (key, _collectionId, next) => {
      const previous = status[key as ReplicaKey]
      status[key as ReplicaKey] = next
      if (key === 'privateCredentials' && (next === 'synced' || next === 'error')) {
        settleFirst()
      }
      if (previous === 'syncing' && next === 'synced') {
        notify()
      }
    },
    onRemoteChange: () => notify(),
    onlineSource:
      typeof navigator !== 'undefined' && typeof window !== 'undefined'
        ? {
            isOnline: () => navigator.onLine !== false,
            subscribe: (onOnline) => {
              window.addEventListener('online', onOnline)
              return () => window.removeEventListener('online', onOnline)
            },
          }
        : undefined,
    pollMs: POLL_MS,
    writerId: getWriterId({ storageKeyPrefix: WRITER_ID_PREFIX, storage: writerIdStorage() }),
  })
  await controller.start()
  setTimeout(settleFirst, FIRST_SYNC_MS)
  // A user key this tab adopts mid-session (a rotation it ran) re-keys the
  // ciphers; a session that ends stops the replica
  const unsubscribe = subscribeSession((next) => {
    if (!next || next.kind !== 'remembered' || next.spaceId !== session.spaceId) {
      return
    }
    if (next.userKey.id !== replica.session.userKey.id) {
      replica.session = next
      ciphers.rebuild(next).then(notify, (err) => console.warn('Wallet: the replica ciphers could not be rebuilt for the new user key:', err))
    }
  })
  const replica: Replica = {
    session,
    db,
    ciphers,
    spaceUrl,
    ready,
    status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reSync: () => controller.reSync(),
    stop: async () => {
      unsubscribe()
      listeners.clear()
      if (current === replica) {
        current = null
      }
      await controller.stop().catch((err) => console.warn('Wallet: the replica did not stop cleanly:', err))
      await db.close().catch(() => undefined)
    },
  }
  current = replica
  return replica
}

// Stops this tab's replica (a sign-out). The rows stay in this browser.
export async function stopReplica(): Promise<void> {
  if (starting) {
    await starting
  }
  if (current) {
    await current.stop()
  }
}

// Stops and deletes the Space's replica and this browser's writer id (the
// browser is forgotten).
export async function forgetReplica({ spaceId }: { spaceId: string }): Promise<void> {
  await stopReplica()
  await removeReplica({ spaceId, storage: storageOverride }).catch((err) => console.warn('Wallet: the local replica could not be deleted:', err))
  const { clearPersistedWriterId } = await import('@interop/pws-sync')
  clearPersistedWriterId({ storageKeyPrefix: WRITER_ID_PREFIX, storage: writerIdStorage() })
}
