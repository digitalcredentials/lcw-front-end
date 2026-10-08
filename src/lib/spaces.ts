import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'
import { getSessionKey, getCoupon } from './auth'
import { getSessionWASClientFor } from './was'

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

async function sessionContext(): Promise<{
  zcapClient: ZcapClient
  controller: string
}> {
  const stored = getSessionKey()
  if (!stored) {
    throw new Error('UNAUTHORIZED')
  }
  const keyPair = await Ed25519VerificationKey.from(stored)
  const zcapClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: keyPair.signer(),
  })
  return { zcapClient, controller: keyPair.controller as string }
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

// Provisions a new Space of the given kind. Per the spec the body names the
// Space's controller DID (the wallet's session DID) and the invocation is
// signed by it; this server additionally requires a coupon (the account's
// registration token). Resolves to the new Space URL.
export async function createSpace(type: 'credential' | 'batch', name: string): Promise<string> {
  const { zcapClient, controller } = await sessionContext()
  const response = await zcapClient.request({
    url: `${wasBase()}/spaces/`,
    method: 'POST',
    action: 'POST',
    json: {
      controller,
      name,
      type: type === 'batch' ? ['Space', BATCH_SPACE_TYPE] : ['Space'],
      coupon: getCoupon(),
    },
  })
  return spaceInfo(response.data as { id: string }).url
}

// Lists the session DID's Spaces (the server reads the caller's DID from
// the signed invocation), following the listing's `next` links.
export async function listSpaces(): Promise<SpaceInfo[]> {
  const { zcapClient } = await sessionContext()
  const spaces: SpaceInfo[] = []
  let url: string | undefined = `${wasBase()}/spaces/`
  while (url) {
    const response = await zcapClient.request({ url, method: 'GET', action: 'GET' })
    const page = response.data as { items: Parameters<typeof spaceInfo>[0][]; next?: string }
    spaces.push(...page.items.map(spaceInfo))
    url = page.next
  }
  return spaces
}

// Deletes a Space (its registry row and its whole bucket) by invoking the
// Space's canonical URL; the capability action equals the HTTP method.
export async function deleteSpace(spaceUrl: string): Promise<void> {
  const { zcapClient } = await sessionContext()
  await zcapClient.request({
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
