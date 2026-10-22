import { base32 } from '@scure/base'
import type { UnlockKdf } from '@interop/wallet-core/keyring'
import { randomBytes } from './bytes'

// The recovery code: 32 random bytes that serve as a credential's unlock
// secret. Written for a person to read from an email and type or paste:
// uppercase base32 in groups of four (52 characters, 13 groups). Forgiving
// on the way back in, ignoring case, spaces and dashes.
//
// The derivation is HKDF over the bytes (they are uniform, so no memory-hard
// stretching), with a salt of its own so a recovery code can never derive
// another credential's unlock identity. This is this wallet's recovery
// credential, not FreeWallet's recovery-code format.
export const RECOVERY_KDF: UnlockKdf = {
  version: 1,
  algorithm: 'HKDF',
  hash: 'SHA-256',
  salt: 'lcw/keyring/recovery/v1',
  info: 'lcw/unlock-seed',
}

const GROUP = 4

export function mintRecoveryCode(): string {
  const text = base32.encode(randomBytes(32)).replace(/=+$/, '')
  return text.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-')
}

// The secret bytes a typed or pasted code stands for, or null when it is not
// a recovery code.
export function recoverySecretOf(code: string): Uint8Array | null {
  const clean = code.toUpperCase().replace(/[^A-Z2-7]/g, '')
  if (clean.length !== 52) {
    return null
  }
  try {
    const bytes = base32.decode(clean + '====')
    return bytes.length === 32 ? bytes : null
  } catch {
    return null
  }
}
