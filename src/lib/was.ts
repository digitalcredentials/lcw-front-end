import { WasClient, discoverService } from '@interop/was-client'
import type { ServiceDescription } from '@interop/was-client'
import { getSession, sessionAgents, sessionEncryption } from './identity/session'

// The spaces repository URL a was-client is built with (0.96+ takes the
// repository, not the server base).
export const spacesUrlOf = (serverUrl: string) => `${serverUrl.replace(/\/+$/, '')}/spaces/`

// The server's service description, discovered once per server for the
// session: a client reads it before its first signed request, and the
// wallet builds many clients (one per space it touches), so each would
// otherwise repeat the discovery round trip.
const serviceDescriptions = new Map<string, Promise<ServiceDescription>>()

export function serviceDescriptionFor(serverUrl: string): Promise<ServiceDescription> {
  let pending = serviceDescriptions.get(serverUrl)
  if (!pending) {
    pending = discoverService({ url: serverUrl }).then((info) => info.description)
    pending.catch(() => serviceDescriptions.delete(serverUrl))
    serviceDescriptions.set(serverUrl, pending)
  }
  return pending
}

// Splits a space URL into the PWS server base URL and the space id:
// everything before /space/{space_id}, and the id.
export function parseSpaceUrl(spaceUrl: string): { serverUrl: string; spaceId: string } | null {
  const match = spaceUrl.match(/^(.+)\/space\/([^/?#]+)\/?$/)
  return match ? { serverUrl: match[1], spaceId: match[2] } : null
}

// A client for the session's Main Space, or null when there is no session.
export async function getSessionWASClient(): Promise<{ client: WasClient; spaceId: string } | null> {
  const session = getSession()
  if (!session) {
    return null
  }
  return getSessionWASClientFor(`${session.serverUrl}/space/${session.spaceId}`)
}

// A client for a specific space, signed as the account's did:webvh, which
// every Space is promoted to at creation. Encrypted collections decrypt
// with the user key.
export async function getSessionWASClientFor(
  spaceUrl: string
): Promise<{ client: WasClient; spaceId: string } | null> {
  const session = getSession()
  const parsed = parseSpaceUrl(spaceUrl)
  if (!session || !parsed) {
    return null
  }
  const { asAccount } = await sessionAgents(session)
  const client = await WasClient.fromSigner({
    serverUrl: spacesUrlOf(parsed.serverUrl),
    signer: asAccount.signer,
    encryption: sessionEncryption(session),
    serviceDescription: await serviceDescriptionFor(parsed.serverUrl),
  })
  return { client, spaceId: parsed.spaceId }
}

// A client signed as the key's did:key form, for a Space whose promotion to
// the account tore and that still answers to the key. Null without a session.
export async function getSessionKeyClient(): Promise<{ client: WasClient; spaceId: string } | null> {
  const session = getSession()
  if (!session) {
    return null
  }
  const { asKey } = await sessionAgents(session)
  const client = await WasClient.fromSigner({
    serverUrl: spacesUrlOf(session.serverUrl),
    signer: asKey.signer,
    encryption: sessionEncryption(session),
    serviceDescription: await serviceDescriptionFor(session.serverUrl),
  })
  return { client, spaceId: session.spaceId }
}
