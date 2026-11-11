import { PwsClient } from '@interop/pws-client'
import { agentsFromSeed } from '@interop/pws-client/identity'
import { didKeyZcapClient } from '@interop/wallet-core/webvh'
import { getCoupon } from './auth'
import { getSession, sessionAgents, type Session } from './identity/session'
import { randomBytes } from './identity/bytes'
import { getSessionWASClientFor, serviceDescriptionFor } from './was'

// The PWS server's Spaces Repository: POST /spaces/ provisions a Space,
// GET /spaces/ lists the caller's, and DELETE on the Space's own URL
// deletes one. Creating and managing Spaces needs a session that signs as
// the account (one opened with a passkey): a transient session's authority
// is its generation delegation on the account Space alone.
//
// Space URLs are kept without the trailing slash the spec's canonical form
// carries (that is how the login API and the registry name them); the
// client adds the slash where a request needs it.

// What the wallet needs to know about a space. `type` is the wallet's
// reading of the Space's type array: a batch-issuance space carries
// "BatchSpace", every other space holds credentials.
export interface SpaceInfo {
  url: string
  type: 'credential' | 'batch'
  types: string[]
  name?: string
  createdAt?: string
}

export const BATCH_SPACE_TYPE = 'BatchSpace'

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
  const types = Array.isArray(item.type) ? item.type : ['Space']
  return {
    url: `${wasBase()}/space/${item.id}`,
    type: types.includes(BATCH_SPACE_TYPE) ? 'batch' : 'credential',
    types,
    ...(item.name !== undefined && { name: item.name }),
    ...(item.createdAt !== undefined && { createdAt: item.createdAt }),
  }
}

// Provisions a batch Space, the one kind of Space the wallet creates after
// registration (the batch issuer calls this when a batch is saved; the user
// has no "new space" of their own, the account Space being the one
// credential space, as in FreeWallet's model). The Space is created under
// a fresh did:key with the account's coupon (the registration token the
// session carries), then handed to the account's did:webvh, so every
// client of the account may use it. Resolves to the new Space URL.
export async function createSpace(type: 'batch', name: string): Promise<string> {
  const session = requireSession()
  if (session.kind !== 'remembered') {
    throw new PasskeySessionRequiredError('Creating a space')
  }
  const seed = randomBytes(32)
  const { keyAgent, controllerDid } = await agentsFromSeed({ seed })
  const asKey = didKeyZcapClient({ keyAgent })
  const response = await asKey.request({
    url: `${wasBase()}/spaces/`,
    method: 'POST',
    action: 'POST',
    json: { controller: controllerDid, name, type: type === 'batch' ? ['Space', BATCH_SPACE_TYPE] : ['Space'], coupon: getCoupon() },
  })
  const { id } = response.data as { id: string }
  const pws = new PwsClient({ baseServerUrl: session.serverUrl, zcapClient: asKey, serviceDescription: await serviceDescriptionFor(session.serverUrl) })
  // The promotion: the creating key hands the Space to the account
  await pws.space(id).configure({ name, controller: session.did, force: true })
  return spaceInfo({ id }).url
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

// Deletes a Space (its registry row and its whole bucket) by invoking the
// Space's canonical URL; the capability action equals the HTTP method.
export async function deleteSpace(spaceUrl: string): Promise<void> {
  const session = requireSession()
  if (session.kind !== 'remembered') {
    throw new PasskeySessionRequiredError('Deleting a space')
  }
  const { zcapClient } = await sessionAgents(session)
  await zcapClient.request({ url: `${spaceUrl}/`, method: 'DELETE', action: 'DELETE' })
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
