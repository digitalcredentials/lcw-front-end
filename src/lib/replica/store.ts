import type { SyncedDoc } from '@interop/pws-sync'
import type { RxCollection, RxDocument } from 'rxdb/plugins/core'
import { resourceUrl } from '@interop/pws-client/paths'
import { PUBLIC_CREDENTIALS_COLLECTION } from '@interop/wallet-core/space'
import type { CredentialBody, StoredCredential } from '../credentials'
import { contentCid, isCredential, normalizeTags } from '../credentials'
import type { CredentialRows } from '../credentialStore'
import { isUnknownEpoch } from './ciphers'
import type { Replica } from './replica'
import type { ReplicaKey } from './database'

// The credential rows over the replica: reads are local (a row's
// envelope decrypted once and remembered for the row's life), writes are
// local rows pws-sync pushes to the Space as conditional writes. The
// shapes are FreeWallet's: a credential is one content-addressed envelope
// in private-credentials holding the bare credential, its public copy a
// plaintext row under the credential's content cid in public-credentials,
// and an activity entry one envelope in wallet-activity.

type Json = Parameters<NonNullable<ReturnType<Replica['ciphers']['for']>['cipher']>['encrypt']>[0]['data']

export function replicaRows({ replica }: { replica: Replica }): CredentialRows {
  const rows = (key: ReplicaKey): RxCollection<SyncedDoc> => replica.db[key]
  // Decrypted credentials by row id: a content-addressed row never changes
  const opened = new Map<string, Promise<CredentialBody | null>>()

  // Runs a cipher operation, rebuilding the collection's ciphers once when
  // the row names an epoch they do not know (a rotation since they were built)
  async function withCiphers<T>(key: ReplicaKey, run: (ciphers: ReturnType<Replica['ciphers']['for']>) => Promise<T>): Promise<T> {
    try {
      return await run(replica.ciphers.for(key))
    } catch (err) {
      if (!isUnknownEpoch(err)) {
        throw err
      }
      await replica.ciphers.refresh(key)
      return run(replica.ciphers.for(key))
    }
  }

  // The credential a row holds, or null when it holds something else
  function decrypt(row: SyncedDoc): Promise<CredentialBody | null> {
    let pending = opened.get(row.id)
    if (!pending) {
      pending = withCiphers('privateCredentials', async ({ cipher }) => {
        if (!cipher) {
          throw new Error('The private-credentials collection has no cipher.')
        }
        const data = await cipher.decrypt({ id: row.id, envelope: row.data as Json })
        return isCredential(data) ? data : null
      }).catch((err) => {
        opened.delete(row.id)
        console.warn(`Wallet: the replica row ${row.id} could not be opened:`, err)
        return null
      })
      opened.set(row.id, pending)
    }
    return pending
  }

  async function readCustom(row: SyncedDoc): Promise<{ name?: string; tags?: Record<string, string> }> {
    if (row.custom === undefined || row.custom === null) {
      return {}
    }
    return withCiphers('privateCredentials', async ({ codec }) => (codec ? ((await codec.decodeMeta({ custom: row.custom }, { kind: 'resource', id: row.id })) as { name?: string; tags?: Record<string, string> }) : {}))
  }

  const tagsOf = (custom: { tags?: Record<string, string> }) => (custom.tags && typeof custom.tags === 'object' ? normalizeTags(Object.keys(custom.tags)) : [])

  async function encodeCustom(id: string, custom: { name?: string; tags: Record<string, string> }): Promise<unknown> {
    return withCiphers('privateCredentials', async ({ codec }) => {
      if (!codec) {
        throw new Error('The private-credentials collection has no codec.')
      }
      return (await codec.encodeMeta({ custom, slot: { kind: 'resource', id } })).custom
    })
  }

  async function row(key: ReplicaKey, id: string): Promise<RxDocument<SyncedDoc> | null> {
    return rows(key).findOne(id).exec()
  }

  // The row as stored (RxDB hands out a read-only view)
  const plain = (doc: RxDocument<SyncedDoc>): SyncedDoc => doc.toJSON() as unknown as SyncedDoc

  const now = () => new Date().toISOString()

  return {
    kind: 'replica',
    async all() {
      await replica.ready
      const docs = await rows('privateCredentials').find().exec()
      const loaded = await Promise.all(
        docs.map(async (doc): Promise<StoredCredential | null> => {
          const body = await decrypt(plain(doc))
          if (!body) {
            return null
          }
          const tags = await readCustom(plain(doc))
            .then(tagsOf)
            .catch(() => [] as string[])
          return { cid: contentCid(body), rid: doc.id, body, tags }
        })
      )
      return loaded.filter((c): c is StoredCredential => c !== null)
    },
    async read(rid) {
      await replica.ready
      const doc = await row('privateCredentials', rid)
      return doc ? decrypt(plain(doc)) : null
    },
    async readTags(rid) {
      const doc = await row('privateCredentials', rid)
      return doc ? tagsOf(await readCustom(plain(doc))) : []
    },
    async insert({ body, tags }) {
      const normalized = normalizeTags(tags)
      const { id, envelope, epoch } = await withCiphers('privateCredentials', async ({ cipher }) => {
        if (!cipher) {
          throw new Error('The private-credentials collection has no cipher.')
        }
        return cipher.encrypt({ data: body as Json })
      })
      const custom = normalized.length ? await encodeCustom(id, { tags: Object.fromEntries(normalized.map((tag) => [tag, ''])) }) : undefined
      await rows('privateCredentials').insertIfNotExists({ id, updatedAt: now(), data: envelope as Json, ...(epoch && { epoch }), ...(custom !== undefined && { custom: custom as Json }) })
      opened.set(id, Promise.resolve(body))
      return { cid: contentCid(body), rid: id }
    },
    async setTags(rid, tags) {
      const doc = await row('privateCredentials', rid)
      if (!doc) {
        throw new Error('The credential is no longer stored.')
      }
      const existing = await readCustom(plain(doc))
      const custom = await encodeCustom(rid, { ...(existing.name && { name: existing.name }), tags: Object.fromEntries(normalizeTags(tags).map((tag) => [tag, ''])) })
      await doc.incrementalPatch({ custom: custom as Json })
    },
    async remove(rid) {
      const doc = await row('privateCredentials', rid)
      if (doc) {
        await doc.remove()
      }
      opened.delete(rid)
    },
    async findPublicCopy(cid) {
      return (await row('publicCredentials', cid)) !== null
    },
    async createPublicCopy(cid, body) {
      await rows('publicCredentials').insertIfNotExists({ id: cid, updatedAt: now(), data: body as Json })
      return this.publicCopyUrl(cid)
    },
    async removePublicCopy(cid) {
      const doc = await row('publicCredentials', cid)
      if (doc) {
        await doc.remove()
      }
    },
    publicCopyUrl(cid) {
      return resourceUrl({ spaceUrl: replica.spaceUrl, collectionId: PUBLIC_CREDENTIALS_COLLECTION, resourceId: cid })
    },
    async recordActivity(entry) {
      try {
        await withCiphers('walletActivity', async ({ cipher }) => {
          if (!cipher) {
            throw new Error('The wallet-activity collection has no cipher.')
          }
          const { id, envelope, epoch } = await cipher.encrypt({ data: entry as Json })
          await rows('walletActivity').insertIfNotExists({ id, updatedAt: now(), data: envelope as Json, ...(epoch && { epoch }) })
        })
      } catch (err) {
        console.warn('The activity entry could not be written:', err)
      }
    },
    subscribe: (listener) => replica.subscribe(listener),
  }
}
