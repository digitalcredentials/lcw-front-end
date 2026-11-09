import type { IKeyAgreementKey, IKeyResolver } from '@interop/data-integrity-core'
import type { CollectionEncryption } from '@interop/was-client'
import { createEdvDocCipher } from '@interop/was-client/edv'
import {
  readSpaceArchive,
  parseArchivePath,
  classifyCollectionFile,
  collectionMetadataFromFile,
  spaceMetadataFromFile,
} from '@interop/space-archive'
import { ACCOUNT_COLLECTIONS } from './accountCollections'
import { packTar, type TarFile } from './tar'

// The data export: every document from every space of the account, unencrypted,
// in one plain tar organized `<space>/<collection>/<document>`.
//
// Each space is read through the PWS server's Export Space operation
// (`POST /space/{id}/export`), which answers the Space as a Space archive;
// this module reads that archive, decrypts an encrypted collection's
// envelopes with the reader's key, and packs the plain documents.
// src/lib/exportWallet.ts fetches the archives and supplies the session's
// user key. Nothing here touches the session or the network, so every part
// is unit-tested on its own.

// Collections left out of the export. `id` and `account` hold the account
// itself (the did:webvh log, the catalogue, the user-key roster); `dids`
// holds each credential's holder key, a private key; `public` holds the
// plaintext copies of shared credentials, which the originals cover.
export const EXCLUDED_COLLECTIONS: readonly string[] = [...ACCOUNT_COLLECTIONS, 'dids', 'public']

export interface ArchivedResource {
  id: string
  bytes: Uint8Array
  contentType: string
  // The extension the archive gave the representation (`json`, `png`, ...)
  extension: string
}

export interface ArchivedCollection {
  id: string
  // The stored Collection Metadata object; `encryption` marks an encrypted
  // collection whose resources are EDV envelopes
  meta: Record<string, unknown> | null
  resources: Map<string, ArchivedResource>
  // A chunked resource's chunk files, by resource id then chunk index
  chunks: Map<string, Map<number, Uint8Array>>
}

export interface ArchivedSpace {
  id: string
  meta: Record<string, unknown> | null
  collections: Map<string, ArchivedCollection>
}

const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot + 1) : 'bin'
}

// Reads a Space archive (the bytes `POST /space/{id}/export` answers) into
// the collections and resources the export packs, leaving out the excluded
// collections.
export async function readArchivedSpace(bytes: Uint8Array): Promise<ArchivedSpace> {
  const archive = await readSpaceArchive(bytes)
  const space: ArchivedSpace = { id: archive.spaceId, meta: null, collections: new Map() }
  const collection = (id: string): ArchivedCollection => {
    let c = space.collections.get(id)
    if (!c) {
      c = { id, meta: null, resources: new Map(), chunks: new Map() }
      space.collections.set(id, c)
    }
    return c
  }
  try {
    for await (const entry of archive.entries) {
      if (entry.type !== 'file') {
        continue
      }
      const position = parseArchivePath(entry.name)
      if (position.area === 'space') {
        if (position.fileName.startsWith('.space.meta.')) {
          space.meta = spaceMetadataFromFile({ bytes: await entry.bytes() })
        }
        continue
      }
      if (position.area === 'chunk') {
        if (EXCLUDED_COLLECTIONS.includes(position.collectionId)) {
          continue
        }
        const kind = classifyCollectionFile(position.fileName)
        if (kind.kind === 'representation') {
          const chunks = collection(position.collectionId).chunks
          const indexed = chunks.get(position.resourceId) ?? new Map<number, Uint8Array>()
          indexed.set(Number(kind.resourceId), await entry.bytes())
          chunks.set(position.resourceId, indexed)
        }
        continue
      }
      if (position.area !== 'collection' || EXCLUDED_COLLECTIONS.includes(position.collectionId)) {
        continue
      }
      const kind = classifyCollectionFile(position.fileName)
      if (kind.kind === 'collectionMetadata') {
        collection(position.collectionId).meta = collectionMetadataFromFile({ bytes: await entry.bytes() })
      } else if (kind.kind === 'representation') {
        collection(position.collectionId).resources.set(kind.resourceId, {
          id: kind.resourceId,
          bytes: await entry.bytes(),
          contentType: kind.contentType,
          extension: extensionOf(position.fileName),
        })
      }
    }
  } finally {
    await archive.close().catch(() => undefined)
  }
  return space
}

// One decrypted document, ready to pack.
export interface ExportedDocument {
  id: string
  bytes: Uint8Array
  extension: string
}

const utf8 = new TextEncoder()

// Decrypts one encrypted collection's resources with the reader's key (the
// account's user key, the recipient of every key epoch), using the
// collection's own encryption descriptor from the archive, so a resource
// written under an earlier epoch still opens. A resource that cannot be
// opened is reported in `problems`, not exported, so one damaged document
// does not stop the rest. `label` names the space in the report.
export async function decryptCollection({
  collection,
  encryption,
  keys,
  label,
  problems,
}: {
  collection: ArchivedCollection
  encryption: CollectionEncryption
  keys: { keyAgreementKey: IKeyAgreementKey; keyResolver: IKeyResolver }
  label: string
  problems: string[]
}): Promise<ExportedDocument[]> {
  const cipher = await createEdvDocCipher({ ...keys, collectionId: collection.id, encryption })
  const decoder = new TextDecoder()
  const chunkSource = async ({ docId, chunkIndex }: { docId: string; chunkIndex: number }) => {
    const bytes = collection.chunks.get(docId)?.get(chunkIndex)
    return bytes ? JSON.parse(decoder.decode(bytes)) : undefined
  }
  const documents: ExportedDocument[] = []
  for (const resource of collection.resources.values()) {
    try {
      const envelope = JSON.parse(decoder.decode(resource.bytes))
      const plain = await cipher.decrypt({ id: resource.id, envelope, chunkSource })
      if (plain instanceof Blob) {
        documents.push({ id: resource.id, bytes: new Uint8Array(await plain.arrayBuffer()), extension: extensionFor(plain.type) })
      } else {
        documents.push({ id: resource.id, bytes: utf8.encode(JSON.stringify(plain, null, 2)), extension: 'json' })
      }
    } catch (err) {
      console.error(`Wallet: the export could not open ${label}/${collection.id}/${resource.id}:`, err)
      problems.push(`${label}/${collection.id}/${resource.id} could not be decrypted and was left out.`)
    }
  }
  return documents
}

// Every collection of an archived space as plain documents: encrypted ones
// decrypted with `keys`, plaintext ones as stored.
export async function exportedCollections({
  space,
  keys,
  label,
  problems,
}: {
  space: ArchivedSpace
  keys: { keyAgreementKey: IKeyAgreementKey; keyResolver: IKeyResolver }
  label: string
  problems: string[]
}): Promise<ExportedCollection[]> {
  const collections: ExportedCollection[] = []
  for (const collection of [...space.collections.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const encryption = collection.meta?.encryption as CollectionEncryption | undefined
    if (encryption) {
      const documents = await decryptCollection({ collection, encryption, keys, label, problems })
      collections.push({ id: collection.id, encrypted: true, documents })
    } else {
      const documents = [...collection.resources.values()].map((r) => ({
        id: r.id,
        bytes: r.bytes,
        extension: extensionFor(r.contentType, r.extension),
      }))
      collections.push({ id: collection.id, encrypted: false, documents })
    }
  }
  return collections
}

export interface ExportedCollection {
  id: string
  encrypted: boolean
  documents: ExportedDocument[]
}

export interface ExportedSpace {
  id: string
  url: string
  name?: string
  types: string[]
  collections: ExportedCollection[]
}

export interface ExportManifest {
  format: 'lcw-data-export/1'
  exportedAt: string
  account?: string
  spaces: {
    folder: string
    id: string
    url: string
    name?: string
    types: string[]
    collections: { folder: string; id: string; encrypted: boolean; documents: number }[]
  }[]
  excludedCollections: string[]
  // Documents that could not be exported, one sentence each
  problems: string[]
}

// A name usable as a folder or file on every common file system: no path
// separators, control characters or reserved punctuation, no leading dot
// (hidden on Unix), trimmed, bounded in length; a name left empty falls back.
export function safeName(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\p{Cc}/\\:*?"<>|]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  return cleaned || fallback
}

// Distinct folder names for a list, suffixing repeats ("Main Space (2)").
function uniqueNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    let candidate = name
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      candidate = `${name} (${n})`
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

// Packs the decrypted spaces into the export tar: `manifest.json` first, then
// `<space folder>/<collection folder>/<document id>.<ext>` for every document.
export function packDataExport({
  spaces,
  account,
  problems = [],
  exportedAt = new Date(),
}: {
  spaces: ExportedSpace[]
  account?: string
  problems?: string[]
  exportedAt?: Date
}): { bytes: Uint8Array; manifest: ExportManifest } {
  const spaceFolders = uniqueNames(spaces.map((s) => safeName(s.name ?? '', s.id)))
  const files: TarFile[] = []
  const manifest: ExportManifest = {
    format: 'lcw-data-export/1',
    exportedAt: exportedAt.toISOString(),
    ...(account && { account }),
    spaces: [],
    excludedCollections: [...EXCLUDED_COLLECTIONS],
    problems,
  }
  spaces.forEach((space, i) => {
    const folder = spaceFolders[i]
    const collectionFolders = uniqueNames(space.collections.map((c) => safeName(c.id, 'collection')))
    manifest.spaces.push({
      folder,
      id: space.id,
      url: space.url,
      ...(space.name !== undefined && { name: space.name }),
      types: space.types,
      collections: space.collections.map((c, j) => ({
        folder: collectionFolders[j],
        id: c.id,
        encrypted: c.encrypted,
        documents: c.documents.length,
      })),
    })
    space.collections.forEach((c, j) => {
      const names = uniqueNames(c.documents.map((d) => safeName(d.id, 'document')))
      c.documents.forEach((d, k) => {
        files.push({ name: `${folder}/${collectionFolders[j]}/${names[k]}.${d.extension}`, bytes: d.bytes })
      })
    })
  })
  files.unshift({ name: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) })
  return { bytes: packTar(files, { mtime: Math.floor(exportedAt.getTime() / 1000) }), manifest }
}

// The file extension for a decrypted document: JSON documents are `.json`,
// a binary one keeps the extension its media type implies.
const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/ld+json': 'json',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/plain': 'txt',
}

export function extensionFor(contentType: string | undefined, fallback = 'bin'): string {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (EXTENSIONS[type]) {
    return EXTENSIONS[type]
  }
  if (type.endsWith('+json')) {
    return 'json'
  }
  return fallback
}
