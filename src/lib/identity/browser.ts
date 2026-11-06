import { deriveUnlockIdentity, type UnlockIdentity, type UnlockKdf } from '@interop/wallet-core/keyring'
import { fromBase64url, toBase64url } from './bytes'

// "Stay signed in on this browser": a credential whose unlock secret is 32
// random bytes kept in this browser's local storage. It is a credential like
// a passkey, with its own signing and update keys in the account document,
// its own unlock space, and its own entry in the user-key roster, so it is
// listed under Sign-in credentials and can be removed from any other
// sign-in, which rotates the user key. On a return visit the wallet opens
// it silently. Signing out forgets it: the secret is deleted here, its unlock
// space and roster entry are retired, and the next password or passkey
// sign-in drops its keys from the document (pruneCredentials).
//
// Anyone who can use this browser profile can open the account until the
// credential is removed, as with any stay-signed-in design.

export const BROWSER_KDF: UnlockKdf = {
  version: 1,
  algorithm: 'HKDF',
  hash: 'SHA-256',
  salt: 'lcw/keyring/browser/v1',
  info: 'lcw/unlock-seed',
}

const STORAGE_KEY = 'lcw_browser_credential'

export interface StoredBrowserCredential {
  email: string
  secret: Uint8Array
  createdAt: string
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

// The browser credential this browser holds, or null. One per browser: a
// second account signing in with the option replaces the first.
export function storedBrowserCredential(): StoredBrowserCredential | null {
  const raw = storage()?.getItem(STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    const stored = JSON.parse(raw) as { email?: unknown; secret?: unknown; createdAt?: unknown }
    if (typeof stored.email !== 'string' || typeof stored.secret !== 'string') {
      return null
    }
    return { email: stored.email, secret: fromBase64url(stored.secret), createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : '' }
  } catch {
    return null
  }
}

export function storeBrowserCredential({ email, secret }: { email: string; secret: Uint8Array }): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify({ email, secret: toBase64url(secret), createdAt: new Date().toISOString() }))
}

export function forgetStoredBrowserCredential(): void {
  storage()?.removeItem(STORAGE_KEY)
}

export function browserUnlock(secret: Uint8Array): Promise<UnlockIdentity> {
  return deriveUnlockIdentity({ secret, kdf: BROWSER_KDF })
}

// A short name for this browser, for the credentials list: "Chrome on macOS".
export function browserLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} on ${os}` : browser
}
