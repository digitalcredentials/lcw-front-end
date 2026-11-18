import { sessionAgents, type Session } from './identity'

// The tester's answer to "Contact me with news and updates": asked on the
// register page and kept by the back end with the account (lcw-back-end's
// /contact, read and changed with requests signed as the account, the way
// the recovery code is).

export interface ContactChoice {
  contactOptIn: boolean
  // When the choice was last given; absent for an account registered
  // before the question was asked
  updatedAt?: string
}

function choiceOf(data: unknown): ContactChoice {
  const { contactOptIn, updatedAt } = (data ?? {}) as { contactOptIn?: unknown; updatedAt?: unknown }
  return { contactOptIn: contactOptIn === true, ...(typeof updatedAt === 'string' && { updatedAt }) }
}

export async function readContactChoice({ session, apiBase }: { session: Session; apiBase: string }): Promise<ContactChoice> {
  const { zcapClient } = await sessionAgents(session)
  const response = await zcapClient.request({ url: `${apiBase}/contact?email=${encodeURIComponent(session.email)}`, method: 'GET', action: 'read' })
  return choiceOf(response.data)
}

export async function saveContactChoice({ session, apiBase, contactOptIn }: { session: Session; apiBase: string; contactOptIn: boolean }): Promise<ContactChoice> {
  const { zcapClient } = await sessionAgents(session)
  const response = await zcapClient.request({ url: `${apiBase}/contact`, method: 'PUT', action: 'write', json: { email: session.email, contactOptIn } })
  return choiceOf(response.data)
}
