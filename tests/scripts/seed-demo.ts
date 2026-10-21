// Seeds the deployed demo account's Main Space with what the deployed tests
// expect: a "UniversityOfToronto" collection (encrypted, the way the wallet
// creates collections) holding the LCW Experience Badge fixture. Idempotent:
// a collection or credential already there is left alone.
//
// The account itself must exist first (tests/scripts/register-demo.ts, and
// its confirmation email clicked). The account is opened the way the wallet
// signs in: the passphrase unlocks the credential, which carries the keys.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/seed-demo.ts
//
// Environment: DEMO_EMAIL (required), DEMO_PASSPHRASE (defaults to the
// deployed tests' passphrase), API_BASE and WAS_URL (default to the sandbox).
import '@interop/http-client'
import { readFileSync } from 'node:fs'
import { WasClient } from '@interop/was-client'
import { ensureFirstEpoch, ownerRecipient } from '@interop/was-client/edv'
import { loginWithPassphrase, sessionAgents, sessionEncryption, sessionKeyAgreementKey } from '../../src/lib/identity'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const COLLECTION = 'UniversityOfToronto'
const FIXTURE = new URL('../fixtures/PlaywrightUpload.json', import.meta.url)

const session = await loginWithPassphrase({
  email,
  passphrase: process.env.DEMO_PASSPHRASE ?? 'my-secret-seed-that-is-long-enou',
  config: {
    apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
    serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
  },
})
console.log(`space ${session.serverUrl}/space/${session.spaceId} (${session.did})`)

const { asAccount } = await sessionAgents(session)
const was = await WasClient.fromSigner({
  serverUrl: `${session.serverUrl}/spaces/`,
  signer: asAccount.signer,
  encryption: sessionEncryption(session),
})
const space = was.space(session.spaceId)

let collection = space.collection(COLLECTION)
const described = (await collection.describe()) as { encryption?: unknown } | null
if (described === null) {
  collection = await space.createCollection({ id: COLLECTION, encryption: { scheme: 'edv' } })
  console.log(`created collection ${COLLECTION}`)
} else if (!described.encryption) {
  console.error(`Collection ${COLLECTION} exists and is not encrypted.`)
  process.exit(1)
}
await ensureFirstEpoch({ collection, recipients: [ownerRecipient({ keyAgreementKey: sessionKeyAgreementKey(session) })] })
const meta = (await collection.meta()) as { custom?: { name?: string } } | null
if (!meta?.custom?.name) {
  await collection.setMeta({ custom: { name: COLLECTION } })
  console.log('named the collection')
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const fixtureName: string = fixture.verifiableCredential?.[0]?.name ?? fixture.name
const listing = await collection.list()
let present = false
for (const item of listing?.items ?? []) {
  const stored = (await collection.get(item.id).catch(() => null)) as { verifiableCredential?: { name?: string }[]; name?: string } | null
  if ((stored?.verifiableCredential?.[0]?.name ?? stored?.name) === fixtureName) {
    present = true
    break
  }
}
if (present) {
  console.log(`"${fixtureName}" is already there`)
} else {
  const added = await collection.add(fixture)
  console.log(`added "${fixtureName}" as ${added.id}`)
}
console.log('done')
