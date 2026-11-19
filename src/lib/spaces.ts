import { getSession, sessionAgents, type Session } from './identity/session'
import { getSessionWASClientFor } from './was'

// The PWS server's Spaces Repository, as the wallet reads it: GET /spaces/
// lists the Spaces registered to the account. The wallet creates its Spaces
// at registration and when a sign-in credential is added
// (src/lib/identity/provision.ts), and none after that. Managing a Space
// needs a session that signs as the account (one opened with a passkey): a
// transient session's authority is its generation delegation on the account
// Space alone.
//
// Space URLs are kept without the trailing slash the spec's canonical form
// carries (that is how the login API and the registry name them); the
// client adds the slash where a request needs it.

// What the wallet needs to know about a space; `types` is the Space's type
// array.
export interface SpaceInfo {
  url: string
  types: string[]
  name?: string
  createdAt?: string
}

export class PasskeySessionRequiredError extends Error {
  constructor(action = 'This action') {
    super(`${action} needs a session signed in with a passkey.`)
    this.name = 'PasskeySessionRequiredError'
  }
}

function wasBase(): string {
  return (import.meta.env.VITE_WAS_BASE_URL ?? '').replace(/\/+$/, '')
}

function requireSession(): Session {
  const session = getSession()
  if (!session) {
    throw new Error('UNAUTHORIZED')
  }
  return session
}

function spaceInfo(item: { id: string; type?: string[]; name?: string; createdAt?: string }): SpaceInfo {
  return {
    url: `${wasBase()}/space/${item.id}`,
    types: Array.isArray(item.type) ? item.type : ['Space'],
    ...(item.name !== undefined && { name: item.name }),
    ...(item.createdAt !== undefined && { createdAt: item.createdAt }),
  }
}

// Lists the account's Spaces. A remembered session lists by the account
// DID; a transient session knows its account Space and nothing else.
export async function listSpaces(): Promise<SpaceInfo[]> {
  const session = requireSession()
  const account = spaceInfo({ id: session.spaceId })
  if (session.kind !== 'remembered') {
    return [account]
  }
  const { zcapClient } = await sessionAgents(session)
  const seen = new Map<string, SpaceInfo>([[account.url, account]])
  let url: string | undefined = `${wasBase()}/spaces/`
  while (url) {
    const response = await zcapClient.request({ url, method: 'GET', action: 'GET' })
    const page = response.data as { items: Parameters<typeof spaceInfo>[0][]; next?: string }
    for (const item of page.items) {
      const info = spaceInfo(item)
      seen.set(info.url, info)
    }
    url = page.next
  }
  return [...seen.values()]
}

// Replaces the writable fields of a Space's metadata object (its name and
// description) under If-Match, keeping everything else the object holds.
// The pws-client's configure() carries only name/controller/type, so the
// description goes through a request of its own. A root operation on the
// server, so a remembered session's.
export async function updateSpaceMeta(spaceUrl: string, fields: { name?: string; description?: string }): Promise<void> {
  const session = requireSession()
  if (session.kind !== 'remembered') {
    throw new PasskeySessionRequiredError('Renaming a space')
  }
  const s = await getSessionWASClientFor(spaceUrl)
  if (!s) {
    throw new Error('UNAUTHORIZED')
  }
  const current = await s.space.describeWithEtag()
  if (!current) {
    throw new Error('The space could not be read.')
  }
  const document: Record<string, unknown> = { ...current.description }
  if (fields.name !== undefined) {
    document.name = fields.name
  }
  if (fields.description !== undefined) {
    if (fields.description) {
      document.description = fields.description
    } else {
      delete document.description
    }
  }
  await s.client.request({
    url: `${spaceUrl.replace(/\/+$/, '')}/meta`,
    method: 'PUT',
    json: document,
    headers: current.etag ? { 'if-match': current.etag } : undefined,
  })
}
