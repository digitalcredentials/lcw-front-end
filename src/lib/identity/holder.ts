import { convertWebvhIdToWebId } from '@interop/did-method-webvh'
import { clientSigningKeyMultibase } from '@interop/wallet-core/webvh'
import { sessionAgents, type Session } from './session'

// The holder DID a credential is bound to, and the key that proves it. An
// account has two DIDs for the same document: its did:webvh, and the did:web
// projection served beside the log (did.json), which any verifier that
// resolves did:web can use. Both list every enrolled client's signing key,
// so a presentation can be signed by a remembered session's client. A
// transient session's visit key is listed in the client annex, not the
// account document, so such a session cannot sign as the account: it
// claims and presents with a did:key of its own instead.

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

// The account DID method to answer with: the did:webvh when it is accepted
// and the session can sign for it, else the did:web projection when that
// is, else null (a fresh did:key).
export function chooseAccountMethod(accepted: string[], session?: Pick<Session, 'kind'>): AccountDidMethod | null {
  if (session && session.kind !== 'remembered') {
    return null
  }
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

// A remembered session's client key as a signer whose id names the key in
// the chosen DID's document: <did>#<multibase>.
export async function holderSigner(session: Session, method: AccountDidMethod): Promise<{ did: string; signer: HolderSigner }> {
  if (session.kind !== 'remembered') {
    throw new Error('Only a session opened with a passkey can sign as the account.')
  }
  const did = accountDid(session, method)
  const { agents } = await sessionAgents(session)
  const signer = agents.keyAgent.getSigner() as { algorithm?: string; sign: (options: { data: Uint8Array }) => Promise<Uint8Array> }
  return {
    did,
    signer: {
      id: `${did}#${clientSigningKeyMultibase({ keyAgent: agents.keyAgent })}`,
      algorithm: signer.algorithm ?? 'Ed25519',
      sign: (options) => signer.sign(options),
    },
  }
}
