// WebAuthn ceremonies for passkey credentials. A passkey unlocks the account
// through the PRF extension: the authenticator evaluates an HMAC, keyed
// per credential, over a fixed input, and the 32-byte output is the unlock
// secret the credential's unlock identity derives from (wallet-core's
// passkey derivation, the same constants as FreeWallet's, so a passkey
// registered here derives the same unlock identity there). Nothing is
// verified server-side: the challenge is throwaway, and the one property
// used is the PRF output, which a replayed assertion never exposes.
import type { UnlockKdf } from '@interop/wallet-core/keyring'

// FreeWallet's passkey parameters, verbatim: the derivation that turns a
// PRF output into an unlock seed, and the PRF input every passkey of the
// wallet is evaluated over.
export const PASSKEY_KDF: UnlockKdf = {
  version: 1,
  algorithm: 'HKDF',
  hash: 'SHA-256',
  salt: 'freewallet/keyring/passkey/v1',
  info: 'freewallet/unlock-seed',
}
const PASSKEY_PRF_INPUT = new TextEncoder().encode('freewallet/passkey/prf/v1')

export class PasskeyCancelledError extends Error {
  constructor(message = 'The passkey operation was cancelled.') {
    super(message)
    this.name = 'PasskeyCancelledError'
  }
}

export class PasskeyUnsupportedError extends Error {
  constructor(message = 'This passkey or browser cannot be used with this wallet: it does not support the PRF extension.') {
    super(message)
    this.name = 'PasskeyUnsupportedError'
  }
}

export function passkeySupported(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && typeof navigator.credentials?.create === 'function'
}

function copyBytes(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source.slice(0))
  }
  return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))
}

const challenge = () => crypto.getRandomValues(new Uint8Array(32))

const PRF_EXTENSION: AuthenticationExtensionsClientInputs = {
  prf: { eval: { first: PASSKEY_PRF_INPUT as BufferSource } },
}

function mapError(err: unknown): never {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
    throw new PasskeyCancelledError(err.message)
  }
  throw err
}

const PRF_OUTPUT_LENGTH = 32

const isByte = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 256

// The PRF output, or null when the authenticator returned none. 1Password
// returns it as a plain array of byte values rather than the ArrayBuffer
// the WebAuthn spec calls for. Any output but 32 bytes is refused: the
// unlock identity derives from these bytes alone, so an empty or malformed
// one would give the account a weak, possibly shared, unlock identity.
function prfOutputOf(credential: PublicKeyCredential): Uint8Array | null {
  const first: unknown = credential.getClientExtensionResults().prf?.results?.first
  if (!first) {
    return null
  }
  // Spread, so a hole in the array reads as undefined and is refused:
  // every() skips holes, and Uint8Array.from would make each one a 0
  const output = Array.isArray(first)
    ? [...first].every(isByte) ? Uint8Array.from(first) : null
    : first instanceof ArrayBuffer || ArrayBuffer.isView(first) ? copyBytes(first) : null
  if (output?.length !== PRF_OUTPUT_LENGTH) {
    // The PRF answered, so the extension is supported; the output is not usable
    throw new PasskeyUnsupportedError('This passkey or browser cannot be used with this wallet.')
  }
  return output
}

// The WebAuthn user handle for an account: a stable function of the email,
// so a second registration on the same authenticator replaces the first
// rather than piling up.
export async function userHandleFor(email: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase())))
}

// Registers a passkey for the account: a discoverable credential with user
// verification, under the page's own registrable domain. Resolves to the
// credential id and the PRF output. When the authenticator will not
// evaluate the PRF at creation, one assertion follows to obtain it; an
// authenticator that cannot evaluate it at all is refused.
export async function registerPasskey({ email, rpName }: { email: string; rpName: string }): Promise<{
  credentialId: Uint8Array
  prfOutput: Uint8Array
}> {
  let credential: PublicKeyCredential
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: rpName },
        user: { id: (await userHandleFor(email)) as BufferSource, name: email, displayName: email },
        challenge: challenge(),
        pubKeyCredParams: [
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        extensions: PRF_EXTENSION,
      },
    })) as PublicKeyCredential
  } catch (err) {
    mapError(err)
  }
  const credentialId = copyBytes(credential.rawId)
  let prfOutput = prfOutputOf(credential)
  if (!prfOutput) {
    if (credential.getClientExtensionResults().prf?.enabled === false) {
      throw new PasskeyUnsupportedError()
    }
    prfOutput = (await assertPasskey({ credentialIds: [credentialId] })).prfOutput
  }
  return { credentialId, prfOutput }
}

// Asserts a passkey and evaluates the PRF: with no credential ids, the
// browser offers the account's discoverable passkeys.
export async function assertPasskey({ credentialIds = [] }: { credentialIds?: Uint8Array[] } = {}): Promise<{
  credentialId: Uint8Array
  prfOutput: Uint8Array
}> {
  let assertion: PublicKeyCredential
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        allowCredentials: credentialIds.map((id) => ({ type: 'public-key' as const, id: id as BufferSource })),
        userVerification: 'required',
        extensions: PRF_EXTENSION,
      },
    })) as PublicKeyCredential
  } catch (err) {
    mapError(err)
  }
  const prfOutput = prfOutputOf(assertion)
  if (!prfOutput) {
    throw new PasskeyUnsupportedError()
  }
  return { credentialId: copyBytes(assertion.rawId), prfOutput }
}
