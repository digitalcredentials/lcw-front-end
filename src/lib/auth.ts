import { getSession, clearSession, sessionSpaceUrl } from './identity/session'

// The signed-in session, as the rest of the wallet asks about it. The
// session itself (the unwrapped keys, the account pointer) lives in
// src/lib/identity/session.ts, in this tab's sessionStorage; these are the
// read-only views the pages and libraries use.

// The signing key's did:key, present while signed in.
export function getToken(): string | null {
  return getSession()?.controller ?? null
}

export function clearToken(): void {
  clearSession()
}

// The account's registration token, returned by /login. The PWS server
// requires it as the coupon when creating a space.
export function getCoupon(): string | null {
  return getSession()?.coupon ?? null
}

// The signed-in account's email, for the back-end endpoints that identify
// the account by email (the batch issuer's notify, the welcome offer).
export function getEmail(): string | null {
  return getSession()?.email ?? null
}

// The account's Main Space URL, from the credential's pointer record.
export function getSpaceUrl(): string | null {
  const session = getSession()
  return session ? sessionSpaceUrl(session) : null
}

export function isAuthenticated(): boolean {
  return getSession() !== null
}
