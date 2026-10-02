import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'
import { getEmail, getSessionKey, getCoupon } from './auth'

// The WAS server's space registry endpoints (per the Wallet Attached Storage
// spec): POST /spaces provisions a space, GET /spaces lists the account's
// spaces, and DELETE on the space URL itself deletes one. Create and list are
// zcap invocations of their own URL (query string included) signed with the
// session key that authenticated at login; delete invokes the space URL,
// which the server verifies against the space's registered controller.

export interface SpaceInfo {
  url: string
  type: string
  name?: string
  createdAt?: string
}

function wasBase(): string {
  return (import.meta.env.VITE_WAS_BASE_URL ?? '').replace(/\/+$/, '')
}

async function sessionContext(): Promise<{
  zcapClient: ZcapClient
  email: string
  controller: string
}> {
  const stored = getSessionKey()
  const email = getEmail()
  if (!stored || !email) {
    throw new Error('UNAUTHORIZED')
  }
  const keyPair = await Ed25519VerificationKey.from(stored)
  const zcapClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: keyPair.signer(),
  })
  return { zcapClient, email, controller: keyPair.controller as string }
}

// Provisions a new WAS space of the given type. Per the spec the body names
// the space's controller DID (the wallet's session DID) and the invocation is
// signed by it; the server additionally requires the account's registration
// token as a coupon. Resolves to the new space URL.
export async function createSpace(type: 'credential' | 'batch', name: string): Promise<string> {
  const { zcapClient, email, controller } = await sessionContext()
  const response = await zcapClient.request({
    url: `${wasBase()}/spaces`,
    method: 'POST',
    action: 'write',
    json: { controller, email, type, name, coupon: getCoupon() },
  })
  return (response.data as { space: string }).space
}

export async function listSpaces(): Promise<SpaceInfo[]> {
  const { zcapClient, email } = await sessionContext()
  const response = await zcapClient.request({
    url: `${wasBase()}/spaces?email=${encodeURIComponent(email)}`,
    method: 'GET',
    action: 'read',
  })
  return (response.data as { spaces: SpaceInfo[] }).spaces
}

// Deletes a batch space (its registry row and its whole storage bucket) by
// invoking the space URL itself; the WAS server's authorizer expects the
// capability action to equal the HTTP method.
export async function deleteSpace(spaceUrl: string): Promise<void> {
  const { zcapClient } = await sessionContext()
  await zcapClient.request({
    url: spaceUrl,
    method: 'DELETE',
    action: 'DELETE',
  })
}
