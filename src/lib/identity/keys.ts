import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { agentsFromSeed, type ProfileAgents } from '@interop/was-client/identity'
import { mintUserKey, userKeyVaultKeys, type UserKey } from '@interop/wallet-core/keys'
import { signerFromDidKeySigner, type Signer } from '@interop/did-method-webvh'
import { randomBytes } from './bytes'

// The account's key material. Nothing here is derived from a credential:
// every key is minted at random when the account (or a credential) is
// created, and reaches a session only by being unwrapped from a credential's
// unlock space.
//
//   - The user key is one per account: the X25519 key every encrypted
//     collection's key epoch is wrapped to, published under keyAgreement in
//     the account document. It only ever decrypts.
//   - Each credential (a passphrase, a passkey, the recovery code) has its
//     own signing key, listed in the account document as a verification
//     method, which signs login, PWS requests and DIDAuth; and its own
//     did:webvh update key, with a staged successor committed by hash, which
//     signs log entries and nothing else. A session holds the signing key;
//     the update keys are unwrapped only to add, remove or rotate a
//     credential.

export interface CredentialKeys {
  // Seed of this credential's signing key; `agentsFromSeed` expands it the
  // way FreeWallet expands a client seed, so the did:key is byte-compatible.
  signingSeed: Uint8Array
  // Seed of this credential's current did:webvh update key.
  updateSeed: Uint8Array
  // Seed of the successor committed in nextKeyHashes.
  stagedSeed: Uint8Array
}

export function mintCredentialKeys(): CredentialKeys {
  return { signingSeed: randomBytes(32), updateSeed: randomBytes(32), stagedSeed: randomBytes(32) }
}

export { mintUserKey, userKeyVaultKeys }
export type { UserKey, ProfileAgents }

// The signing key's agents: the did:key (`controllerDid`), the key agent
// whose signer every request rides, and a zcap client in the did:key form.
export function signingAgents(signingSeed: Uint8Array): Promise<ProfileAgents> {
  return agentsFromSeed({ seed: signingSeed })
}

// The public multibase of a did:key (`z6Mk...` for Ed25519, `z6LS...` for
// X25519), as the account document names keys.
export function multibaseOf(didKey: string): string {
  return didKey.split('#')[0].slice('did:key:'.length)
}

export interface UpdateKey {
  multibase: string
  didKey: string
  // A signer in the form the did:webvh driver takes for createDID/updateDID.
  logSigner: Signer
}

// An update key from its seed: a plain Ed25519 key whose did:key form the log
// lists under updateKeys.
export async function updateKeyFromSeed(seed: Uint8Array): Promise<UpdateKey> {
  const key = await Ed25519VerificationKey.generate({ seed })
  const multibase = key.fingerprint()
  key.controller = `did:key:${multibase}`
  key.id = `${key.controller}#${multibase}`
  return { multibase, didKey: key.controller, logSigner: signerFromDidKeySigner(key.signer()) }
}

// The staged successor's public multibase, for the nextKeyHashes commitment.
export async function multibaseOfSeed(seed: Uint8Array): Promise<string> {
  const key = await Ed25519VerificationKey.generate({ seed })
  return key.fingerprint()
}
