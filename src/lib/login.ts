import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'

export interface LoginResult {
  verified: boolean
  email: string
  controller: string
  space?: string
}

// The wallet key pair is derived deterministically from the password:
// SHA-256(password) is used as the 32-byte Ed25519 seed, so the same
// password always yields the same did:key. The DID registered for the
// account must have been derived the same way.
export async function deriveKeyPair(password: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  const keyPair = await Ed25519VerificationKey.generate({ seed: new Uint8Array(digest) })
  keyPair.controller = `did:key:${keyPair.fingerprint()}`
  keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`
  return keyPair
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
  const keyPair = await deriveKeyPair(password)
  const zcapClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: keyPair.signer()
  })

  // Signs a capability invocation of the /login endpoint's root zcap; the
  // back end verifies the signature against the DID registered for the email.
  const response = await zcapClient.request({
    url: `${base}/login`,
    method: 'POST',
    action: 'write',
    json: { email }
  })
  return response.data as LoginResult
}
