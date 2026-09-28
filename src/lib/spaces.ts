import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'
import { getEmail, getSessionKey } from './auth'

// The lcw-back-end /spaces API: creates, lists, and deletes the account's
// typed WAS spaces. Every call is a zcap invocation of its own URL (query
// string included), signed with the session key that authenticated at login —
// the same scheme as /login itself.

export interface SpaceInfo {
  url: string
  type: string
  name?: string
  createdAt?: string
}

function apiBase(): string {
  return (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
}

async function sessionContext(): Promise<{ zcapClient: ZcapClient; email: string }> {
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
  return { zcapClient, email }
}

// Creates a new WAS space of the given type (controlled by the wallet's DID)
// and registers it in the spaces registry. Resolves to the new space URL.
export async function createSpace(type: 'credential' | 'batch', name: string): Promise<string> {
  const { zcapClient, email } = await sessionContext()
  const response = await zcapClient.request({
    url: `${apiBase()}/spaces`,
    method: 'POST',
    action: 'write',
    json: { email, type, name },
  })
  return (response.data as { space: string }).space
}

export async function listSpaces(): Promise<SpaceInfo[]> {
  const { zcapClient, email } = await sessionContext()
  const response = await zcapClient.request({
    url: `${apiBase()}/spaces?email=${encodeURIComponent(email)}`,
    method: 'GET',
    action: 'read',
  })
  return (response.data as { spaces: SpaceInfo[] }).spaces
}

// Deletes a batch space: its registry row and its whole storage bucket.
export async function deleteSpace(spaceUrl: string): Promise<void> {
  const { zcapClient, email } = await sessionContext()
  await zcapClient.request({
    url: `${apiBase()}/spaces?email=${encodeURIComponent(email)}&space=${encodeURIComponent(spaceUrl)}`,
    method: 'DELETE',
    action: 'write',
  })
}
