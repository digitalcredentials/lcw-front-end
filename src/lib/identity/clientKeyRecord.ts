import { mintRecordEncryption, recordCipher, recordEnvelopeId, parseRecordFrame, type UnlockIdentity } from '@interop/wallet-core/keyring'
import { decodeClientKeyRecord, encodeClientKeyRecord, type ClientKeyRecord } from '@interop/wallet-core/keys'
import type { DocCipher } from '@interop/pws-client/edv/cipher'

// A remembered browser's client-key record: the enrolled client's seed,
// its did:webvh update keys and the user key, kept in this browser's
// IndexedDB under the unlock Space id of the credential that gates it and
// sealed to that credential's unlock key-agreement key. Only a passkey
// gates one here (decision 1): its PRF output derives the unlock identity
// that opens the record, so a remembered browser still needs the passkey
// tap, and nothing in storage opens the account on its own.

const DB_NAME = 'lcw-session'
const STORE = 'client-keys'
const VERSION = 1
const LABEL = 'client-keys'
const FRAME_VERSION = 1

type Json = Parameters<DocCipher['encrypt']>[0]['data']

function available(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened.'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = run(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
    })
  } finally {
    db.close()
  }
}

// The record store the remembered login reads and writes: this browser's
// IndexedDB, or a memory for a test outside a browser.
export interface ClientKeyStore {
  load(unlock: UnlockIdentity): Promise<ClientKeyRecord | null>
  save(unlock: UnlockIdentity, record: ClientKeyRecord): Promise<void>
  remove(unlockSpaceId: string): Promise<void>
}

export const defaultClientKeyStore: ClientKeyStore = {
  load: (unlock) => loadClientKeyRecord({ unlock }),
  save: (unlock, record) => saveClientKeyRecord({ unlock, record }),
  remove: (unlockSpaceId) => deleteClientKeyRecord(unlockSpaceId),
}

export function memoryClientKeyStore(): ClientKeyStore {
  const records = new Map<string, ClientKeyRecord>()
  return {
    load: async (unlock) => records.get(unlock.spaceId) ?? null,
    save: async (unlock, record) => {
      records.set(unlock.spaceId, record)
    },
    remove: async (unlockSpaceId) => {
      records.delete(unlockSpaceId)
    },
  }
}

// Whether this browser holds any client-key record (a remembered browser).
export async function hasAnyClientKeyRecord(): Promise<boolean> {
  if (!available()) {
    return false
  }
  return (await withStore('readonly', (store) => store.count())) > 0
}

export async function hasClientKeyRecord(unlockSpaceId: string): Promise<boolean> {
  if (!available()) {
    return false
  }
  return (await withStore('readonly', (store) => store.getKey(unlockSpaceId))) !== undefined
}

export async function saveClientKeyRecord({ unlock, record }: { unlock: UnlockIdentity; record: ClientKeyRecord }): Promise<void> {
  if (!available()) {
    throw new Error('This browser cannot keep a remembered session (no IndexedDB).')
  }
  const encryption = await mintRecordEncryption({ keyAgreementKey: unlock.keyAgreementKey })
  const cipher = await recordCipher({ keyAgreementKey: unlock.keyAgreementKey, keyResolver: unlock.keyResolver, encryption, collectionId: LABEL })
  const { envelope } = await cipher.encrypt({ data: encodeClientKeyRecord(record) as unknown as Json })
  await withStore('readwrite', (store) => store.put({ version: FRAME_VERSION, encryption, wrapped: envelope }, unlock.spaceId))
}

// The record the credential gates, or null when this browser holds none
// for it.
export async function loadClientKeyRecord({ unlock }: { unlock: UnlockIdentity }): Promise<ClientKeyRecord | null> {
  if (!available()) {
    return null
  }
  const stored = await withStore<unknown>('readonly', (store) => store.get(unlock.spaceId))
  if (stored === undefined || stored === null) {
    return null
  }
  const frame = parseRecordFrame({ record: stored, label: LABEL, version: FRAME_VERSION })
  const cipher = await recordCipher({ keyAgreementKey: unlock.keyAgreementKey, keyResolver: unlock.keyResolver, encryption: frame.encryption, collectionId: LABEL })
  const contents = await cipher.decrypt({ id: recordEnvelopeId({ wrapped: frame.wrapped, label: LABEL }), envelope: frame.wrapped as Json })
  return decodeClientKeyRecord({ contents })
}

export async function deleteClientKeyRecord(unlockSpaceId: string): Promise<void> {
  if (!available()) {
    return
  }
  await withStore('readwrite', (store) => store.delete(unlockSpaceId))
}

export async function deleteAllClientKeyRecords(): Promise<void> {
  if (!available()) {
    return
  }
  await withStore('readwrite', (store) => store.clear())
}
