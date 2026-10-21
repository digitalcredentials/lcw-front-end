import { createEdvEncryption } from '@interop/was-client/edv'
import { webvhSigner, didKeyZcapClient, webvhZcapClient } from '@interop/wallet-core/webvh'
import type { ZcapClient } from '@interop/ezcap'
import { fromBase64url, toBase64url } from './bytes'
import { signingAgents, userKeyVaultKeys, type ProfileAgents, type UserKey } from './keys'

// The signed-in session: what one credential unwrapped, kept for this tab
// only. sessionStorage survives a reload of the tab and is gone when the tab
// closes, and another tab or window (the CHAPI popup) does not see it, so a
// browser the user walks away from keeps nothing durable. The update keys
// are deliberately not here: a session can sign and decrypt, never rewrite
// the account document.
export interface Session {
  email: string
  // The registration token /login returns, required by the PWS server as the
  // coupon when creating a space.
  coupon?: string
  // The account's did:webvh, and the signing key's did:key form, which the
  // back end registered and which controls spaces not yet promoted.
  did: string
  controller: string
  // Where the account lives: the PWS server and the Main Space.
  serverUrl: string
  spaceId: string
  signingSeed: Uint8Array
  userKey: UserKey
}

const SESSION_KEY = 'lcw_session'

interface StoredSession {
  email: string
  coupon?: string
  did: string
  controller: string
  serverUrl: string
  spaceId: string
  signingSeed: string
  userKey: { id: string; secret: string }
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function getSession(): Session | null {
  const raw = storage()?.getItem(SESSION_KEY)
  if (!raw) {
    return null
  }
  try {
    const stored = JSON.parse(raw) as StoredSession
    return {
      ...stored,
      signingSeed: fromBase64url(stored.signingSeed),
      userKey: { id: stored.userKey.id, secret: fromBase64url(stored.userKey.secret) },
    }
  } catch {
    return null
  }
}

export function setSession(session: Session): void {
  const stored: StoredSession = {
    ...session,
    signingSeed: toBase64url(session.signingSeed),
    userKey: { id: session.userKey.id, secret: toBase64url(session.userKey.secret) },
  }
  storage()?.setItem(SESSION_KEY, JSON.stringify(stored))
}

export function clearSession(): void {
  storage()?.removeItem(SESSION_KEY)
}

// The session's Main Space URL, in the form the rest of the wallet uses.
export function sessionSpaceUrl(session: Session): string {
  return `${session.serverUrl}/space/${session.spaceId}`
}

// The session's signing material, expanded once per call: the key agents and
// the two forms the key signs under. The did:webvh form is what a promoted
// space (the Main Space) verifies; the did:key form is what the back end's
// login, the batch issuer's notify, and spaces not yet promoted verify.
export async function sessionAgents(session: Session): Promise<{
  agents: ProfileAgents
  asAccount: { signer: ReturnType<typeof webvhSigner>; zcapClient: ZcapClient }
  asKey: { signer: ReturnType<ProfileAgents['keyAgent']['getSigner']>; zcapClient: ZcapClient }
}> {
  const agents = await signingAgents(session.signingSeed)
  return {
    agents,
    asAccount: {
      signer: webvhSigner({ keyAgent: agents.keyAgent, did: session.did }),
      zcapClient: webvhZcapClient({ keyAgent: agents.keyAgent, did: session.did }),
    },
    asKey: { signer: agents.keyAgent.getSigner(), zcapClient: didKeyZcapClient({ keyAgent: agents.keyAgent }) },
  }
}

// The encryption provider for a was-client: the user key is the recipient
// of every encrypted collection, whichever credential opened the session.
export function sessionEncryption(session: Session) {
  const { keyAgreementKey, keyResolver } = userKeyVaultKeys({ userKey: session.userKey })
  return createEdvEncryption({ resolveKeys: async () => ({ keyAgreementKey, keyResolver }) })
}

export function sessionKeyAgreementKey(session: Session) {
  return userKeyVaultKeys({ userKey: session.userKey }).keyAgreementKey
}
