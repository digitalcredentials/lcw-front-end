import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { WasClient } from '@interop/was-client'


export const getWASClient = async (seed: string, serverUrl: string): Promise<WasClient> => {
  const keyPair = await Ed25519VerificationKey.generate({
    seed: new TextEncoder().encode(seed)
  })
  keyPair.controller = `did:key:${keyPair.fingerprint()}`
  keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`

  return WasClient.fromSigner({
    serverUrl,
    signer: keyPair.signer()
  })
}