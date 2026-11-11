import { getEmail } from './auth'
import { getSession, sessionVaultKeys } from './identity/session'
import { listSpaces, type SpaceInfo } from './spaces'
import { getSessionWASClientFor, parseSpaceUrl } from './was'
import { exportedCollections, packDataExport, readArchivedSpace, type ExportedSpace, type ExportManifest } from './dataExport'

// "Download my data": every space of the account is read through the PWS
// server's Export Space operation, each encrypted collection is decrypted
// with the session's user key (the recipient of every key epoch), and the
// plain documents are packed into one tar (src/lib/dataExport.ts). The file
// leaves the wallet unencrypted, which the Settings dialog says before it
// is made.

export interface WalletExport {
  blob: Blob
  fileName: string
  manifest: ExportManifest
}

// The Space's archive, read as the session (a transient session reaches
// its account Space through its generation delegation, which covers the
// export; a remembered one reaches every Space of the account).
async function exportArchive(space: SpaceInfo): Promise<Uint8Array> {
  const handle = await getSessionWASClientFor(space.url)
  if (!handle) {
    throw new Error('UNAUTHORIZED')
  }
  return handle.space.export()
}

async function exportSpace(space: SpaceInfo, problems: string[]): Promise<ExportedSpace> {
  const session = getSession()
  if (!session) {
    throw new Error('UNAUTHORIZED')
  }
  const archived = await readArchivedSpace(await exportArchive(space))
  const label = space.name ?? parseSpaceUrl(space.url)?.spaceId ?? space.url
  const collections = await exportedCollections({ space: archived, keys: sessionVaultKeys(session), label, problems })
  return {
    id: archived.id,
    url: space.url,
    ...(space.name !== undefined && { name: space.name }),
    types: space.types,
    collections,
  }
}

// Builds the export of every space listed for the account.
export async function exportWalletData(): Promise<WalletExport> {
  const problems: string[] = []
  const spaces: ExportedSpace[] = []
  for (const space of await listSpaces()) {
    spaces.push(await exportSpace(space, problems))
  }
  const exportedAt = new Date()
  const { bytes, manifest } = packDataExport({ spaces, account: getEmail() ?? undefined, problems, exportedAt })
  return {
    blob: new Blob([bytes as BlobPart], { type: 'application/x-tar' }),
    fileName: `lcw-data-${exportedAt.toISOString().slice(0, 10)}.tar`,
    manifest,
  }
}

// Hands the file to the browser's download.
export function saveWalletExport({ blob, fileName }: WalletExport): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
