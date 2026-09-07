import { WasClient } from '@interop/was-client'
import { deriveKeyPair } from './login'


export const getWASClient = async (seed: string, serverUrl: string): Promise<WasClient> => {
  const keyPair = await deriveKeyPair(seed)

  return WasClient.fromSigner({
    serverUrl,
    signer: keyPair.signer()
  })
}
