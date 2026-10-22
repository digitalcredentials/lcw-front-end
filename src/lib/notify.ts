import type { Batch, NotifyResult } from '@digitalcredentials/batch-issuer-ui'
import { getEmail } from './auth'
import { getSession, sessionAgents } from './identity/session'

// The batch issuer back end's (batch-issuer-backend) POST /notify: emails
// every recipient in a batch a collection link, staging the encrypted
// per-credential bundles in the batch's space. Signed the same way as the
// /spaces calls: a zcap invocation of the request URL with the session key
// that authenticated at login.
export async function notifyRecipients(batch: Batch): Promise<NotifyResult> {
  const session = getSession()
  const email = getEmail()
  if (!session || !email) {
    throw new Error('UNAUTHORIZED')
  }
  // The batch issuer verifies against the DID registered for the email, the
  // account's did:webvh, whose document lists this session's key
  const zcapClient = (await sessionAgents(session)).asAccount.zcapClient
  const base = (import.meta.env.VITE_BATCH_API_BASE ?? '').replace(/\/+$/, '')
  const response = await zcapClient.request({
    url: `${base}/notify`,
    method: 'POST',
    action: 'write',
    json: { email, batch },
  })
  return response.data as NotifyResult
}
