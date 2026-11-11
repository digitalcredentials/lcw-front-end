import { KEYRING_KDF, deriveUnlockSeed, unlockIdentityFromSeed, type UnlockIdentity, type UnlockKdf } from '@interop/wallet-core/keyring'
import { standingClientFromUnlockSeed, type StandingUnlockClient } from '@interop/wallet-core/unlock'

// An unlock credential: what one typed secret (a passphrase, a passkey's PRF
// output, a recovery code) expands to, the FreeWallet way, so that an
// account bound by either wallet opens in the other.
//
//   - The unlock identity addresses the credential's unlock Space (its id is
//     derived from the unlock did:key) and holds the key-agreement key its
//     keyring record is sealed to and the signer the record is signed with.
//   - The standing client is the credential's standing identity: the
//     client did:key it signs as before any session exists, the
//     key-agreement key it is a user-key roster recipient under, and the MAC
//     key that binds its record to the account it names.
//
// One run of the method's KDF (Argon2id over 64 MiB for a passphrase, HKDF
// for the others) feeds both expansions, so the expensive stretch runs once
// per typed secret.

export interface UnlockCredential {
  unlock: UnlockIdentity
  standing: StandingUnlockClient
}

export async function deriveUnlockCredential({ secret, kdf }: { secret: string | Uint8Array; kdf: UnlockKdf }): Promise<UnlockCredential> {
  const unlockSeed = await deriveUnlockSeed({ secret, kdf })
  const unlock = await unlockIdentityFromSeed({ seed: unlockSeed })
  const standing = await standingClientFromUnlockSeed({ unlockSeed })
  return { unlock, standing }
}

// The passphrase credential: wallet-core's keyring KDF, the parameters
// FreeWallet derives a passphrase under.
export const passphraseCredential = (passphrase: string) => deriveUnlockCredential({ secret: passphrase, kdf: KEYRING_KDF })

export { KEYRING_KDF }
export type { UnlockIdentity, StandingUnlockClient, UnlockKdf }
