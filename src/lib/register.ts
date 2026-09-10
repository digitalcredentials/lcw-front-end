import { deriveKeyPair } from './login'

// Registers an account: derives the did:key from the password (the same
// derivation login uses, so the registered DID matches later logins) and
// posts it with the email and registration code. The back end gates on the
// code and then starts the registration state machine, which emails a
// confirmation link.
export async function register(email: string, password: string, registrationCode: string): Promise<string> {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
  const keyPair = await deriveKeyPair(password)

  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, did: keyPair.controller, registrationCode })
  })

  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
  if (!res.ok) {
    throw new Error(body.error ?? 'Unable to register. Please try again.')
  }
  return body.message ?? 'Registration started. Check your email for a confirmation link.'
}
