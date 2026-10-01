import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { Ed25519Signature2020 } from '@interop/ed25519-signature'
import { ZcapClient } from '@interop/ezcap'
import type { Batch, NotifyResult } from '@digitalcredentials/batch-issuer-ui'
import { getEmail, getSessionKey } from './auth'

// The issuer back end's POST /notify: emails every recipient in a batch a
// collection link, staging the encrypted per-credential bundles in the batch's
// space. Signed the same way as the /spaces calls: a zcap invocation of the
// request URL with the session key that authenticated at login.
export async function notifyRecipients(batch: Batch): Promise<NotifyResult> {
  const stored = getSessionKey()
  const email = getEmail()
  if (!stored || !email) {
    throw new Error('UNAUTHORIZED')
  }
  const keyPair = await Ed25519VerificationKey.from(stored)
  const zcapClient = new ZcapClient({
    SuiteClass: Ed25519Signature2020,
    invocationSigner: keyPair.signer(),
  })
  const base = (import.meta.env.VITE_ISSUER_API_BASE ?? '').replace(/\/+$/, '')
  const response = await zcapClient.request({
    url: `${base}/notify`,
    method: 'POST',
    action: 'write',
    json: { email, batch },
  })
  return response.data as NotifyResult
}
