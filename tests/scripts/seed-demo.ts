// Seeds the deployed demo account's Space with what the deployed tests
// expect: the LCW Experience Badge fixture stored the way the wallet stores
// credentials (the private-credentials collection, FreeWallet's layout),
// tagged "University of Toronto" (src/lib/credentials.ts). Idempotent: a
// credential already there keeps its tags and gains that one if missing.
//
// The account itself must exist first (tests/scripts/register-demo.ts, and
// its confirmation email clicked). The account is opened the way the wallet
// signs in with a password: a transient session riding the account's
// generation delegation.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/seed-demo.ts
//
// Environment: DEMO_EMAIL (required), DEMO_PASSPHRASE (defaults to the
// deployed tests' passphrase), API_BASE and WAS_URL (default to the sandbox).
import '@interop/http-client'
import { readFileSync } from 'node:fs'
import { PwsClient } from '@interop/pws-client'
import { loginWithPassphrase, sessionAgents, sessionEncryption, setSession } from '../../src/lib/identity'
import { serviceDescriptionFor } from '../../src/lib/identity/service'
import { addCredential, loadCredentials, setTags } from '../../src/lib/credentials'
import { credentialFrom, credentialName } from '../../src/lib/linkedin'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const TAG = 'University of Toronto'
const FIXTURE = new URL('../fixtures/PlaywrightUpload.json', import.meta.url)

const session = await loginWithPassphrase({
  email,
  passphrase: process.env.DEMO_PASSPHRASE ?? 'my-secret-seed-that-is-long-enou',
  config: {
    apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
    serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
  },
})
setSession(session)
console.log(`space ${session.serverUrl}/space/${session.spaceId} (${session.did})`)

const { signer, capabilityFor } = await sessionAgents(session)
const pws = PwsClient.fromSigner({
  baseServerUrl: session.serverUrl,
  signer,
  encryption: sessionEncryption(session),
  serviceDescription: await serviceDescriptionFor(session.serverUrl),
})
const capability = capabilityFor(session.spaceId)
const space = pws.space(session.spaceId, capability ? { capability } : undefined)

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
const fixtureName = credentialName(credentialFrom(fixture)!)
const stored = (await loadCredentials(space)).find((c) => {
  const credential = credentialFrom(c.body)
  return credential !== null && credentialName(credential) === fixtureName
})
if (!stored) {
  const { cid } = await addCredential({ space, body: fixture, tags: [TAG] })
  console.log(`added "${fixtureName}" as ${cid}, tagged "${TAG}"`)
} else if (!stored.tags.includes(TAG)) {
  await setTags(space, stored.cid, [...stored.tags, TAG])
  console.log(`tagged "${fixtureName}" "${TAG}"`)
} else {
  console.log(`"${fixtureName}" is already there, tagged "${TAG}"`)
}
console.log('done')
