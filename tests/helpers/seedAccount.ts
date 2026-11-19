// What the tests against a deployed wallet expect an account to hold: the
// LCW Experience Badge (the credential inside the fixture's presentation)
// stored the way the wallet stores credentials (the bare credential in the
// private-credentials collection, FreeWallet's layout), tagged "University
// of Toronto" (src/lib/credentials.ts).
import { readFileSync } from 'node:fs'
import { PwsClient } from '@interop/pws-client'
import { sessionAgents, sessionEncryption, type Session } from '../../src/lib/identity'
import { serviceDescriptionFor } from '../../src/lib/identity/service'
import type { CredentialBody } from '../../src/lib/credentials'
import { directCredentialStore } from '../../src/lib/credentialStore'
import { credentialFrom, credentialName } from '../../src/lib/linkedin'

export const SEED_TAG = 'University of Toronto'
const FIXTURE = new URL('../fixtures/PlaywrightUpload.json', import.meta.url)

// The session's account Space, read and written directly, as a password
// session does.
export async function accountSpace(session: Session) {
  const { signer, capabilityFor } = await sessionAgents(session)
  const pws = PwsClient.fromSigner({
    baseServerUrl: session.serverUrl,
    signer,
    encryption: sessionEncryption(session),
    serviceDescription: await serviceDescriptionFor(session.serverUrl),
  })
  const capability = capabilityFor(session.spaceId)
  return pws.space(session.spaceId, capability ? { capability } : undefined)
}

// Stores the badge with its tag. Idempotent: a credential already there
// keeps its tags and gains that one if missing. `outcome` says which.
export async function seedBadge(session: Session): Promise<{ name: string; cid: string; outcome: 'added' | 'tagged' | 'present' }> {
  const credential = credentialFrom(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  if (!credential) {
    throw new Error('The fixture holds no credential.')
  }
  const name = credentialName(credential)
  const store = directCredentialStore(await accountSpace(session))
  const { cid, created } = await store.addCredential({ body: credential as CredentialBody, tags: [SEED_TAG] })
  if (created) {
    return { name, cid, outcome: 'added' }
  }
  const tags = await store.readTags(cid)
  if (tags.includes(SEED_TAG)) {
    return { name, cid, outcome: 'present' }
  }
  await store.setTags(cid, [...tags, SEED_TAG])
  return { name, cid, outcome: 'tagged' }
}
