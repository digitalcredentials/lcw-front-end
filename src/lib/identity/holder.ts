import { convertWebvhIdToWebId } from '@interop/did-method-webvh'
import { multibaseOf, signingAgents } from './keys'
import type { Session } from './session'

// The holder DID a credential is bound to, and the key that proves it. An
// account has two DIDs for the same document: its did:webvh, and the did:web
// projection the identity domain serves beside the log (did.json), which
// any verifier that resolves did:web can use. Both list every credential's
// signing key, so a presentation can be signed by whichever credential
// opened the session. An issuer or verifier says which methods it accepts
// in its DIDAuthentication query (`acceptedMethods`); a request that
// accepts neither gets a fresh did:key per credential, as before.

export type AccountDidMethod = 'webvh' | 'web'

// The methods a request's DIDAuthentication query accepts, by name, in the
// request's order; empty when it states none.
export function acceptedMethodsOf(vpr: Record<string, unknown> | undefined): string[] {
  const queries = [vpr?.query ?? []].flat() as { type?: string; acceptedMethods?: unknown }[]
  const didAuth = queries.find((query) => query?.type === 'DIDAuthentication' || query?.type === 'DIDAuth')
  return [didAuth?.acceptedMethods ?? []]
    .flat()
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { method?: unknown })?.method))
    .filter((method): method is string => typeof method === 'string')
    .map((method) => method.replace(/^did:/, ''))
}

// The account DID method to answer with: the did:webvh when it is accepted,
// else the did:web projection when that is, else null (a fresh did:key).
export function chooseAccountMethod(accepted: string[]): AccountDidMethod | null {
  if (accepted.includes('webvh')) {
    return 'webvh'
  }
  if (accepted.includes('web')) {
    return 'web'
  }
  return null
}

export const webDidOf = (session: Pick<Session, 'did'>): string => convertWebvhIdToWebId(session.did)

export function accountDid(session: Pick<Session, 'did'>, method: AccountDidMethod): string {
  return method === 'webvh' ? session.did : webDidOf(session)
}

// Which of the account's DIDs `did` is, or null when it is neither.
export function accountMethodOf(session: Pick<Session, 'did'>, did: string): AccountDidMethod | null {
  if (did === session.did) {
    return 'webvh'
  }
  if (did === webDidOf(session)) {
    return 'web'
  }
  return null
}

// A signer in the shape the Ed25519Signature2020 suite takes: its id is the
// verification method the proof names.
export interface HolderSigner {
  id: string
  algorithm?: string
  sign: (options: { data: Uint8Array }) => Promise<Uint8Array>
}

// The session's signing key as a signer whose id names the key in the
// chosen DID's document: <did>#<multibase>.
export async function holderSigner(session: Session, method: AccountDidMethod): Promise<{ did: string; signer: HolderSigner }> {
  const did = accountDid(session, method)
  const agents = await signingAgents(session.signingSeed)
  const signer = agents.keyAgent.getSigner() as { algorithm?: string; sign: (options: { data: Uint8Array }) => Promise<Uint8Array> }
  return {
    did,
    signer: {
      id: `${did}#${multibaseOf(session.controller)}`,
      algorithm: signer.algorithm ?? 'Ed25519',
      sign: (options) => signer.sign(options),
    },
  }
}
