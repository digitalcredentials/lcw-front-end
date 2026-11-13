import type { CredentialBody } from './credentials'
import type { CredentialStore } from './credentialStore'
import type { ExportManifest } from './dataExport'
import { credentialsFrom } from './linkedin'
import { normalizeTags } from './tags'
import { readTar } from './tar'

// wallet-core's PRIVATE_CREDENTIALS_COLLECTION, named here so this module
// loads without wallet-core (the test runner cannot load it)
const PRIVATE_CREDENTIALS_COLLECTION = 'private-credentials'

// "Import my data": the credentials in a file Download my data made, added
// back to the account. The file is read here (the tar, its manifest, the
// documents of every `private-credentials` folder); the credential store
// does the adding, so a credential already there is left as it is, with
// the tags the file gives it added to the stored copy. Nothing here touches
// the session or the network, so the reading is unit-tested on its own.

export const EXPORT_FORMAT = 'lcw-data-export/1'

// The file is not a download of this wallet's: said in a sentence the
// dialog shows
export class NotAnExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotAnExportError'
  }
}

export interface ImportableCredential {
  // The document's path in the file
  file: string
  body: CredentialBody
  tags: string[]
}

export interface DataExportContents {
  manifest: ExportManifest
  credentials: ImportableCredential[]
  // The documents of the credential folders that are not credentials, each
  // with the reason
  skipped: { file: string; reason: string }[]
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

// Reads a data download: its manifest, and every credential under a
// `private-credentials` folder with the tags the manifest lists for it. A
// presentation stored as a document is unwrapped to its credentials.
export function readDataExport(bytes: Uint8Array): DataExportContents {
  let files
  try {
    files = readTar(bytes)
  } catch {
    throw new NotAnExportError('That file is not a .tar archive.')
  }
  const manifestFile = files.find((file) => file.name === 'manifest.json')
  if (!manifestFile) {
    throw new NotAnExportError('That file is not a data download from this wallet: it holds no manifest.json.')
  }
  let manifest: Partial<ExportManifest>
  try {
    manifest = JSON.parse(decode(manifestFile.bytes)) as Partial<ExportManifest>
  } catch {
    throw new NotAnExportError("The file's manifest.json could not be read.")
  }
  if (!manifest || typeof manifest !== 'object' || manifest.format !== EXPORT_FORMAT) {
    throw new NotAnExportError('That file is not a data download from this wallet.')
  }
  const byName = new Map(files.map((file) => [file.name, file.bytes]))
  const credentials: ImportableCredential[] = []
  const skipped: { file: string; reason: string }[] = []
  for (const space of manifest.spaces ?? []) {
    for (const collection of space.collections ?? []) {
      if (collection.id !== PRIVATE_CREDENTIALS_COLLECTION) {
        continue
      }
      const prefix = `${space.folder}/${collection.folder}/`
      for (const [name, data] of byName) {
        if (!name.startsWith(prefix)) {
          continue
        }
        const file = name.slice(prefix.length)
        if (file.includes('/')) {
          continue
        }
        if (!file.endsWith('.json')) {
          skipped.push({ file: name, reason: 'not a JSON document' })
          continue
        }
        let document: unknown
        try {
          document = JSON.parse(decode(data))
        } catch {
          skipped.push({ file: name, reason: 'not valid JSON' })
          continue
        }
        const found = credentialsFrom(document)
        if (found.length === 0) {
          skipped.push({ file: name, reason: 'not a credential' })
          continue
        }
        const tags = normalizeTags(collection.tags?.[file] ?? [])
        for (const credential of found) {
          credentials.push({ file: name, body: credential as CredentialBody, tags })
        }
      }
    }
  }
  return { manifest: manifest as ExportManifest, credentials, skipped }
}

export interface ImportResult {
  // Credentials stored by the import
  added: number
  // Credentials the account held already (their tags from the file added)
  existing: number
  failed: { file: string; reason: string }[]
}

// Adds the credentials to the store, one by one, reporting progress by
// count. A credential that fails is reported and the rest go on.
export async function importCredentials({
  credentials,
  store,
  onProgress,
}: {
  credentials: ImportableCredential[]
  store: Pick<CredentialStore, 'addCredential' | 'readTags' | 'setTags'>
  onProgress?: (done: number) => void
}): Promise<ImportResult> {
  const result: ImportResult = { added: 0, existing: 0, failed: [] }
  for (const [index, credential] of credentials.entries()) {
    try {
      const { cid, created } = await store.addCredential({ body: credential.body, tags: credential.tags })
      if (created) {
        result.added++
      } else {
        result.existing++
        if (credential.tags.length) {
          const current = await store.readTags(cid)
          const merged = normalizeTags([...current, ...credential.tags])
          if (merged.length !== current.length) {
            await store.setTags(cid, merged)
          }
        }
      }
    } catch (err) {
      console.error(`Wallet: the import could not add ${credential.file}:`, err)
      result.failed.push({ file: credential.file, reason: err instanceof Error ? err.message : String(err) })
    }
    onProgress?.(index + 1)
  }
  return result
}
