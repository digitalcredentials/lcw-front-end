import type { CollectionEncryption, PwsClient, ResourceCodec } from '@interop/pws-client'
import { createEdvDocCipher } from '@interop/pws-client/edv'
import type { DocCipher } from '@interop/pws-client/sync'
import { spaceUrlById } from '@interop/pws-client/paths/layout'
import { sessionEncryption, sessionVaultKeys, type Session } from '../identity/session'
import { REPLICA_COLLECTIONS, type ReplicaKey } from './database'

// What the replica store seals and opens rows with: for each encrypted
// collection, a document cipher over the content body (the row's `data`,
// an EDV envelope whose id derives from its content) and the collection's
// codec for the resource metadata's `custom` (the row's `custom`, an
// envelope of its own, where a credential's tags live). Both are built
// from the collection's encryption descriptor, as the server serves it,
// and the session's user key, the recipient of every epoch.
//
// A rotation of the user key (a wallet disconnected, a sign-in method
// removed) appends an epoch the descriptor held here does not name, so a
// row sealed under it fails to open with an unknown epoch: the store then
// asks for the ciphers to be rebuilt from a fresh descriptor and reads
// again, once.

export interface CollectionCiphers {
  // Null on a plaintext collection (public-credentials)
  cipher: DocCipher | null
  codec: ResourceCodec | null
}

export interface ReplicaCiphers {
  for(key: ReplicaKey): CollectionCiphers
  // Rebuilds one collection's ciphers from a fresh descriptor
  refresh(key: ReplicaKey): Promise<void>
  // Rebuilds every collection's ciphers for a session whose user key changed
  rebuild(session: Session): Promise<void>
}

const isUnknownEpoch = (err: unknown) => (err as { name?: string })?.name === 'UnknownEpochError'

export { isUnknownEpoch }

export async function buildCiphers({ session, pws }: { session: Session; pws: PwsClient }): Promise<ReplicaCiphers> {
  const spaceUrl = spaceUrlById({ baseServerUrl: session.serverUrl, spaceId: session.spaceId })
  let current = session
  const built = new Map<ReplicaKey, CollectionCiphers>()

  async function build(key: ReplicaKey): Promise<CollectionCiphers> {
    const collectionId = REPLICA_COLLECTIONS[key]
    if (key === 'publicCredentials') {
      return { cipher: null, codec: null }
    }
    const described = await pws.space(current.spaceId).collection(collectionId).describe()
    const encryption = described?.encryption as CollectionEncryption | undefined
    if (!encryption) {
      throw new Error(`The collection "${collectionId}" declares no encryption; the replica refuses to read or write it in the clear.`)
    }
    const { keyAgreementKey, keyResolver } = sessionVaultKeys(current)
    const cipher = await createEdvDocCipher({ keyAgreementKey, keyResolver, collectionId, spaceUrl, idDerivation: 'content', encryption })
    const codec = await sessionEncryption(current).codecFor({ spaceUrl, collectionId, scheme: encryption.scheme, encryption })
    if (!codec) {
      throw new Error(`No codec for the collection "${collectionId}".`)
    }
    return { cipher, codec }
  }

  for (const key of Object.keys(REPLICA_COLLECTIONS) as ReplicaKey[]) {
    built.set(key, await build(key))
  }
  return {
    for: (key) => {
      const ciphers = built.get(key)
      if (!ciphers) {
        throw new Error(`No ciphers for "${key}".`)
      }
      return ciphers
    },
    refresh: async (key) => {
      built.set(key, await build(key))
    },
    rebuild: async (session) => {
      current = session
      for (const key of Object.keys(REPLICA_COLLECTIONS) as ReplicaKey[]) {
        built.set(key, await build(key))
      }
    },
  }
}
