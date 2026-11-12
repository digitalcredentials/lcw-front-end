// Seeds the deployed demo account's Space with what the deployed tests
// expect: the LCW Experience Badge fixture stored the way the wallet stores
// credentials (the private-credentials collection, FreeWallet's layout),
// filed under a "UniversityOfToronto" group (src/lib/credentials.ts).
// Idempotent: a group or credential already there is left alone.
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
import { addCredential, createGroup, groupOf, listCredentialIds, listGroups, moveCredential, readCredential } from '../../src/lib/credentials'
import { credentialFrom, credentialName } from '../../src/lib/linkedin'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const GROUP = 'UniversityOfToronto'
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

let groups = await listGroups(space)
let group = groups.find((g) => g.name === GROUP)
if (!group) {
  group = await createGroup({ space, name: GROUP })
  groups = [...groups, group]
  console.log(`created group ${GROUP}`)
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>
const fixtureName = credentialName(credentialFrom(fixture)!)
let found: string | null = null
for (const cid of await listCredentialIds(space)) {
  const stored = await readCredential(space, cid).catch(() => null)
  const credential = stored ? credentialFrom(stored) : null
  if (credential && credentialName(credential) === fixtureName) {
    found = cid
    break
  }
}
if (found) {
  const filed = groupOf(groups, found)
  if (filed?.id !== group.id) {
    await moveCredential({ space, cid: found, fromGroupId: filed?.id ?? null, toGroupId: group.id })
    console.log(`"${fixtureName}" filed under ${GROUP}`)
  } else {
    console.log(`"${fixtureName}" is already there`)
  }
} else {
  const { cid } = await addCredential({ space, body: fixture, groupId: group.id })
  console.log(`added "${fixtureName}" as ${cid}`)
}
console.log('done')
