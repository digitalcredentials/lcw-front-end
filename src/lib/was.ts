import { WasClient } from '@interop/was-client'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { deriveKeyPair } from './login'
import { getSessionKey, getSpaceUrl } from './auth'


export const getWASClient = async (seed: string, serverUrl: string): Promise<WasClient> => {
  const keyPair = await deriveKeyPair(seed)

  return WasClient.fromSigner({
    serverUrl,
    signer: keyPair.signer()
  })
}

// Splits a space URL (as returned by the login API) into the WAS server base
// URL and the space id: everything before /space/{space_id}, and the id.
export function parseSpaceUrl(spaceUrl: string): { serverUrl: string; spaceId: string } | null {
  const match = spaceUrl.match(/^(.+)\/space\/([^/?#]+)$/)
  return match ? { serverUrl: match[1], spaceId: match[2] } : null
}

// Builds a WAS client for the logged-in session: the space URL and the key
// pair stored at login. Returns null when there is no complete session.
export async function getSessionWASClient(): Promise<{ client: WasClient; spaceId: string } | null> {
  const spaceUrl = getSpaceUrl()
  const storedKeyPair = getSessionKey()
  if (!spaceUrl || !storedKeyPair) {
    return null
  }

  const parsed = parseSpaceUrl(spaceUrl)
  if (!parsed) {
    return null
  }

  const keyPair = await Ed25519VerificationKey.from(storedKeyPair)
  const client = await WasClient.fromSigner({
    serverUrl: parsed.serverUrl,
    signer: keyPair.signer()
  })
  return { client, spaceId: parsed.spaceId }
}
