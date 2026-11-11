import { PwsClient, discoverService } from '@interop/pws-client'
import type { ServiceDescription, Space } from '@interop/pws-client'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import { getSession, sessionAgents, sessionEncryption } from './identity/session'

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

// A client whose Space handles ride the capability the session holds for
// that Space (a transient session reaches the account Space through its
// generation delegation; a remembered session invokes as the account), and
// whose other members are the underlying client's.
function sessionClient(client: PwsClient, capabilityFor: (spaceId: string) => IZcap | undefined): PwsClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'space') {
        return (spaceId: string, options?: { capability?: IZcap }): Space => {
          const capability = options?.capability ?? capabilityFor(spaceId)
          return target.space(spaceId, capability ? { ...options, capability } : options)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export interface SessionClient {
  client: PwsClient
  spaceId: string
  // The Space's handle, with the session's capability for it applied
  space: Space
}

// A client for the session's account Space, or null when there is no
// session.
export async function getSessionWASClient(): Promise<SessionClient | null> {
  const session = getSession()
  if (!session) {
    return null
  }
  return getSessionWASClientFor(`${session.serverUrl}/space/${session.spaceId}`)
}

// A client for a specific space, signed as the session's acting identity.
// Encrypted collections decrypt with the user key. A transient session
// reaches only the account Space (its generation delegation covers nothing
// else), so another Space's handle answers 404 to it.
export async function getSessionWASClientFor(spaceUrl: string): Promise<SessionClient | null> {
  const session = getSession()
  const parsed = parseSpaceUrl(spaceUrl)
  if (!session || !parsed) {
    return null
  }
  const { signer, capabilityFor } = await sessionAgents(session)
  const client = sessionClient(
    PwsClient.fromSigner({
      baseServerUrl: parsed.serverUrl,
      signer,
      encryption: sessionEncryption(session),
      serviceDescription: await serviceDescriptionFor(parsed.serverUrl),
    }),
    capabilityFor
  )
  return { client, spaceId: parsed.spaceId, space: client.space(parsed.spaceId) }
}
