import { WasClient, discoverService } from '@interop/was-client'
import type { ServiceDescription } from '@interop/was-client'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { deriveKeyPair } from './login'
import { getSessionKey, getSpaceUrl } from './auth'
import { sessionEncryption } from './edv'

// The server's service description, discovered once per server for the
// session: a client reads it before its first signed request, and the
// wallet builds many clients (one per space it touches), so each would
// otherwise repeat the discovery round trip.
const serviceDescriptions = new Map<string, Promise<ServiceDescription>>()

function serviceDescriptionFor(serverUrl: string): Promise<ServiceDescription> {
  let pending = serviceDescriptions.get(serverUrl)
  if (!pending) {
    pending = discoverService({ url: serverUrl }).then((info) => info.description)
    pending.catch(() => serviceDescriptions.delete(serverUrl))
    serviceDescriptions.set(serverUrl, pending)
  }
  return pending
}

export const getWASClient = async (seed: string, serverUrl: string): Promise<WasClient> => {
  const keyPair = await deriveKeyPair(seed)

  return WasClient.fromSigner({
    serverUrl,
    signer: keyPair.signer(),
    serviceDescription: await serviceDescriptionFor(serverUrl),
  })
}

// Splits a space URL (as returned by the login API) into the WAS server base
// URL and the space id: everything before /space/{space_id}, and the id.
export function parseSpaceUrl(spaceUrl: string): { serverUrl: string; spaceId: string } | null {
  const match = spaceUrl.match(/^(.+)\/space\/([^/?#]+)\/?$/)
  return match ? { serverUrl: match[1], spaceId: match[2] } : null
}

// Builds a WAS client for the logged-in session: the space URL and the key
// pair stored at login. Returns null when there is no complete session.
export async function getSessionWASClient(): Promise<{ client: WasClient; spaceId: string } | null> {
  const spaceUrl = getSpaceUrl()
  if (!spaceUrl) {
    return null
  }
  return getSessionWASClientFor(spaceUrl)
}

// Builds a WAS client for a specific space (multi-space support): the stored
// session key signs, the server URL and space id come from the given space
// URL. Returns null when there is no complete session.
export async function getSessionWASClientFor(
  spaceUrl: string
): Promise<{ client: WasClient; spaceId: string } | null> {
  const storedKeyPair = getSessionKey()
  const parsed = parseSpaceUrl(spaceUrl)
  if (!storedKeyPair || !parsed) {
    return null
  }
  const keyPair = await Ed25519VerificationKey.from(storedKeyPair)
  const client = await WasClient.fromSigner({
    serverUrl: parsed.serverUrl,
    signer: keyPair.signer(),
    // Pass-through EDV: collections whose metadata declares the edv scheme
    // encrypt on write and decrypt on read with the session key
    encryption: await sessionEncryption(storedKeyPair),
    serviceDescription: await serviceDescriptionFor(parsed.serverUrl),
  })
  return { client, spaceId: parsed.spaceId }
}
