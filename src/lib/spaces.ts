import type { ZcapClient } from '@interop/ezcap'
import { getCoupon } from './auth'
import { getSession, sessionAgents } from './identity/session'
import { promoteSpace } from './identity/account'
import { WasClient } from '@interop/was-client'
import { getSessionWASClientFor, spacesUrlOf } from './was'

// The WAS server's Spaces Repository (Wallet Attached Storage v0.5):
// POST /spaces/ provisions a Space, GET /spaces/ lists the caller's, and
// DELETE on the Space's own URL deletes one. Create and list are zcap
// invocations of their own URL signed with the session key that
// authenticated at login (the server verifies them against the signer's
// DID); delete invokes the Space URL, which the server verifies against the
// Space's registered controller.
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

function wasBase(): string {
  return (import.meta.env.VITE_WAS_BASE_URL ?? '').replace(/\/+$/, '')
}

// The session's two signing forms: every Space answers to the account's
// did:webvh once promoted; the did:key form creates Spaces and lists any
// whose promotion tore (src/lib/identity).
async function sessionContext(): Promise<{ asKey: ZcapClient; asAccount: ZcapClient }> {
  const session = getSession()
  if (!session) {
    throw new Error('UNAUTHORIZED')
  }
  const { asKey, asAccount } = await sessionAgents(session)
  return { asKey: asKey.zcapClient, asAccount: asAccount.zcapClient }
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

// Provisions a new Space of the given kind. Per the spec the body names a
// did:key controller and the invocation is signed by it, so the Space is
// created under the signing key's did:key form (this server additionally
// requires a coupon, the account's registration token), then promoted to
// the account's did:webvh so every credential's key may use it. Resolves to
// the new Space URL.
export async function createSpace(type: 'credential' | 'batch', name: string): Promise<string> {
  const session = getSession()
  if (!session) {
    throw new Error('UNAUTHORIZED')
  }
  const { asKey } = await sessionAgents(session)
  const response = await asKey.zcapClient.request({
    url: `${wasBase()}/spaces/`,
    method: 'POST',
    action: 'POST',
    json: {
      controller: session.controller,
      name,
      type: type === 'batch' ? ['Space', BATCH_SPACE_TYPE] : ['Space'],
      coupon: getCoupon(),
    },
  })
  const { id } = response.data as { id: string }
  const was = await WasClient.fromSigner({ serverUrl: spacesUrlOf(session.serverUrl), signer: asKey.signer })
  await promoteSpace({ was, spaceId: id, did: session.did, name })
  return spaceInfo({ id }).url
}

// Lists the account's Spaces: the server lists by the signing DID. Every
// Space is promoted to the account's did:webvh, but a Space whose promotion
// tore stays under the signing key's did:key, so both listings are read and
// merged, following each listing's `next` links.
export async function listSpaces(): Promise<SpaceInfo[]> {
  const { asKey, asAccount } = await sessionContext()
  const seen = new Map<string, SpaceInfo>()
  for (const zcapClient of [asAccount, asKey]) {
    let url: string | undefined = `${wasBase()}/spaces/`
    while (url) {
      const response = await zcapClient.request({ url, method: 'GET', action: 'GET' })
      const page = response.data as { items: Parameters<typeof spaceInfo>[0][]; next?: string }
      for (const item of page.items) {
        const info = spaceInfo(item)
        if (!seen.has(info.url)) {
          seen.set(info.url, info)
        }
      }
      url = page.next
    }
  }
  return [...seen.values()]
}

// Deletes a Space (its registry row and its whole bucket) by invoking the
// Space's canonical URL; the capability action equals the HTTP method.
export async function deleteSpace(spaceUrl: string): Promise<void> {
  const { asAccount } = await sessionContext()
  await asAccount.request({
    url: `${spaceUrl}/`,
    method: 'DELETE',
    action: 'DELETE',
  })
}

// Replaces the writable fields of a Space's metadata object (its name and
// description) under If-Match, keeping everything else the object holds.
// The was-client's configure() carries only name/controller/type, so the
// description goes through a request of its own.
export async function updateSpaceMeta(
  spaceUrl: string,
  fields: { name?: string; description?: string }
): Promise<void> {
  const s = await getSessionWASClientFor(spaceUrl)
  if (!s) {
    throw new Error('UNAUTHORIZED')
  }
  const space = s.client.space(s.spaceId)
  const current = await space.describeWithEtag()
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
    path: `/space/${s.spaceId}/meta`,
    method: 'PUT',
    json: document,
    headers: current.etag ? { 'if-match': current.etag } : undefined,
  })
}
