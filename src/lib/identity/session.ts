import { createEdvEncryption } from '@interop/pws-client/edv'
import { agentsFromSeed, type ProfileAgents } from '@interop/pws-client/identity'
import { userKeyVaultKeys, type UserKey } from '@interop/wallet-core/keys'
import { webvhSigner, webvhZcapClient, type ClientWebvhUpdateKeys } from '@interop/wallet-core/webvh'
import type { ZcapClient } from '@interop/ezcap'
import type { IZcap } from '@interop/data-integrity-core/zcap'
import { fromBase64url, toBase64url } from './bytes'

// The signed-in session: what one credential opened, kept for this tab
// only. sessionStorage survives a reload of the tab and is gone when the tab
// closes, and another tab or window (the CHAPI popup) does not see it, so a
// browser the user walks away from keeps nothing durable.
//
// Two kinds, FreeWallet's two session kinds:
//
//   - A transient session (a passphrase or recovery-code sign-in): a
//     per-visit key, enrolled into the account's client annex for this
//     visit, which signs as `<clientAnnexDid>#<key>` and rides the
//     generation delegation on every request to the account Space. Nothing
//     of it is written anywhere but this tab.
//   - A remembered session (a passkey sign-in on a browser that enrolled):
//     the enrolled client's seed, whose key the account document lists, so
//     it signs as the account itself on any Space the account controls.

export interface SessionBase {
  email: string
  // The registration token /login returns, required by the PWS server as the
  // coupon when creating a space.
  coupon?: string
  // The account's did:webvh
  did: string
  // Where the account lives: the PWS server and the account Space.
  serverUrl: string
  spaceId: string
  userKey: UserKey
  // The unlock Space of the credential that opened the session
  unlockSpaceId: string
}

export interface TransientSession extends SessionBase {
  kind: 'transient'
  clientAnnexDid: string
  visitSeed: Uint8Array
  generationDelegation: IZcap
  // The credential that opened the session, as the acting authority a
  // ceremony run from this session signs with: its ladder seed (the ladder
  // VM signs log entries and roster appends), its standing client seed
  // (the did:key its delegations are made to), and its two delegations
  ladderSeed: Uint8Array
  standingClientSeed: Uint8Array
  bridgeDelegation: IZcap
  siblingDelegation: IZcap
}

export interface RememberedSession extends SessionBase {
  kind: 'remembered'
  clientSeed: Uint8Array
  // The enrolled client's did:webvh update keys, which sign the account-log
  // entries the session makes (adding a credential, a recovery code)
  webvhUpdateKeys: ClientWebvhUpdateKeys
}

export type Session = TransientSession | RememberedSession

const SESSION_KEY = 'lcw_session'

type Stored = Omit<SessionBase, 'userKey'> & { userKey: { id: string; secret: string } } & (
  | {
      kind: 'transient'
      clientAnnexDid: string
      visitSeed: string
      generationDelegation: IZcap
      ladderSeed: string
      standingClientSeed: string
      bridgeDelegation: IZcap
      siblingDelegation: IZcap
    }
  | { kind: 'remembered'; clientSeed: string; webvhUpdateKeys: { updateSeed: string; stagedSeed: string; pendingStagedSeed?: string } }
)

const encodeUpdateKeys = (keys: ClientWebvhUpdateKeys) => ({
  updateSeed: toBase64url(keys.updateSeed),
  stagedSeed: toBase64url(keys.stagedSeed),
  ...(keys.pendingStagedSeed && { pendingStagedSeed: toBase64url(keys.pendingStagedSeed) }),
})
const decodeUpdateKeys = (keys: { updateSeed: string; stagedSeed: string; pendingStagedSeed?: string }): ClientWebvhUpdateKeys => ({
  updateSeed: fromBase64url(keys.updateSeed),
  stagedSeed: fromBase64url(keys.stagedSeed),
  ...(keys.pendingStagedSeed && { pendingStagedSeed: fromBase64url(keys.pendingStagedSeed) }),
})

// Outside a browser (the scripts under tsx) the session is kept in memory
// instead, so the libraries that read the current session work there too.
let inMemory: string | null = null

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    if (typeof sessionStorage !== 'undefined') {
      return sessionStorage
    }
  } catch {
    // falls through to memory
  }
  return {
    getItem: () => inMemory,
    setItem: (_key, value) => {
      inMemory = value
    },
    removeItem: () => {
      inMemory = null
    },
  }
}

export function getSession(): Session | null {
  const raw = storage().getItem(SESSION_KEY)
  if (!raw) {
    return null
  }
  try {
    const stored = JSON.parse(raw) as Stored
    const base = { ...stored, userKey: { id: stored.userKey.id, secret: fromBase64url(stored.userKey.secret) } }
    if (stored.kind === 'transient') {
      return {
        ...base,
        kind: 'transient',
        visitSeed: fromBase64url(stored.visitSeed),
        generationDelegation: stored.generationDelegation,
        ladderSeed: fromBase64url(stored.ladderSeed),
        standingClientSeed: fromBase64url(stored.standingClientSeed),
        bridgeDelegation: stored.bridgeDelegation,
        siblingDelegation: stored.siblingDelegation,
      } as TransientSession
    }
    if (stored.kind === 'remembered') {
      return { ...base, kind: 'remembered', clientSeed: fromBase64url(stored.clientSeed), webvhUpdateKeys: decodeUpdateKeys(stored.webvhUpdateKeys) } as RememberedSession
    }
    return null
  } catch {
    return null
  }
}

export function setSession(session: Session): void {
  const userKey = { id: session.userKey.id, secret: toBase64url(session.userKey.secret) }
  const stored: Stored =
    session.kind === 'transient'
      ? {
          ...session,
          userKey,
          visitSeed: toBase64url(session.visitSeed),
          ladderSeed: toBase64url(session.ladderSeed),
          standingClientSeed: toBase64url(session.standingClientSeed),
        }
      : { ...session, userKey, clientSeed: toBase64url(session.clientSeed), webvhUpdateKeys: encodeUpdateKeys(session.webvhUpdateKeys) }
  storage().setItem(SESSION_KEY, JSON.stringify(stored))
}

export function clearSession(): void {
  storage().removeItem(SESSION_KEY)
}

// The session's account Space URL, in the form the rest of the wallet uses.
export function sessionSpaceUrl(session: Session): string {
  return `${session.serverUrl}/space/${session.spaceId}`
}

// The acting identity's signing material: the key agents, the DID the
// session signs as (the account for a remembered session, the client annex
// for a transient one), its signer and zcap client, and the capability a
// request to a given Space rides (a transient session reaches the account
// Space through the generation delegation and nothing else).
export async function sessionAgents(session: Session): Promise<{
  agents: ProfileAgents
  actingDid: string
  signer: ReturnType<typeof webvhSigner>
  zcapClient: ZcapClient
  capabilityFor: (spaceId: string) => IZcap | undefined
}> {
  if (session.kind === 'transient') {
    const agents = await agentsFromSeed({ seed: session.visitSeed })
    return {
      agents,
      actingDid: session.clientAnnexDid,
      signer: webvhSigner({ keyAgent: agents.keyAgent, did: session.clientAnnexDid }),
      zcapClient: webvhZcapClient({ keyAgent: agents.keyAgent, did: session.clientAnnexDid }),
      capabilityFor: (spaceId) => (spaceId === session.spaceId ? session.generationDelegation : undefined),
    }
  }
  const agents = await agentsFromSeed({ seed: session.clientSeed })
  return {
    agents,
    actingDid: session.did,
    signer: webvhSigner({ keyAgent: agents.keyAgent, did: session.did }),
    zcapClient: webvhZcapClient({ keyAgent: agents.keyAgent, did: session.did }),
    capabilityFor: () => undefined,
  }
}

// Whether the session can reach Spaces other than the account Space (a
// transient session cannot: its authority is the generation delegation on
// the account Space alone).
export const sessionReachesOtherSpaces = (session: Session) => session.kind === 'remembered'

// The encryption provider for a pws-client: the user key is the recipient
// of every encrypted collection, whichever credential opened the session.
// The session's encryption for pws-client handles: every encrypted
// collection decrypts with the user key, and a resource added without an
// id gets one derived from its envelope's content, FreeWallet's convention
// for the synced collections (two replicas adding the same document agree
// on its id).
export function sessionEncryption(session: Session) {
  const { keyAgreementKey, keyResolver } = userKeyVaultKeys({ userKey: session.userKey })
  return createEdvEncryption({ resolveKeys: async () => ({ keyAgreementKey, keyResolver }), idDerivation: 'content' })
}

export function sessionKeyAgreementKey(session: Session) {
  return userKeyVaultKeys({ userKey: session.userKey }).keyAgreementKey
}

// The user key as a reader's key material (its key-agreement key and the
// resolver that finds it), for decrypting an envelope outside a pws-client
// handle, such as one read from a Space archive.
export function sessionVaultKeys(session: Session) {
  const { keyAgreementKey, keyResolver } = userKeyVaultKeys({ userKey: session.userKey })
  return { keyAgreementKey, keyResolver }
}
