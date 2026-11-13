// Seeds the deployed demo account's Space with what the deployed tests
// expect: the LCW Experience Badge (the credential inside the fixture's
// presentation) stored the way the wallet stores credentials (the bare
// credential in the private-credentials collection, FreeWallet's layout),
// tagged "University of Toronto" (src/lib/credentials.ts). Idempotent: a
// credential already there keeps its tags and gains that one if missing.
// With --reset, every stored credential, Trash record and public copy is
// deleted first, so the Space holds the badge alone afterwards.
//
// The account itself must exist first (tests/scripts/register-demo.ts, and
// its confirmation email clicked). The account is opened the way the wallet
// signs in with a password: a transient session riding the account's
// generation delegation.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/seed-demo.ts [--reset]
//
// Environment: DEMO_EMAIL (required), DEMO_PASSPHRASE (defaults to the
// deployed tests' passphrase), API_BASE and WAS_URL (default to the sandbox).
import '@interop/http-client'
import { readFileSync } from 'node:fs'
import { PwsClient } from '@interop/pws-client'
import { PUBLIC_CREDENTIALS_COLLECTION } from '@interop/wallet-core/space'
import { loginWithPassphrase, sessionAgents, sessionEncryption, setSession } from '../../src/lib/identity'
import { serviceDescriptionFor } from '../../src/lib/identity/service'
import { deleteResource, discardTrashItem, listResourceIds, listTrash, type CredentialBody } from '../../src/lib/credentials'
import { directCredentialStore } from '../../src/lib/credentialStore'
import { credentialFrom, credentialName } from '../../src/lib/linkedin'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const reset = process.argv.includes('--reset')
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

if (reset) {
  // Every resource goes, read or not: what is there is not looked at
  const rids = await listResourceIds(space)
  for (const rid of rids) {
    await deleteResource(space, rid)
  }
  const trash = await listTrash(space)
  for (const item of trash) {
    await discardTrashItem(space, item)
  }
  const copies = (await space.collection(PUBLIC_CREDENTIALS_COLLECTION, { encryption: 'plaintext' }).list().catch(() => null))?.items ?? []
  for (const copy of copies) {
    await space.collection(PUBLIC_CREDENTIALS_COLLECTION, { encryption: 'plaintext' }).resource(copy.id).delete()
  }
  console.log(`reset: ${rids.length} credential resource(s), ${trash.length} Trash record(s), ${copies.length} public cop${copies.length === 1 ? 'y' : 'ies'} deleted`)
}

const credential = credentialFrom(JSON.parse(readFileSync(FIXTURE, 'utf8')))
if (!credential) {
  throw new Error('The fixture holds no credential.')
}
const name = credentialName(credential)
const store = directCredentialStore(space)
const { cid, created } = await store.addCredential({ body: credential as CredentialBody, tags: [TAG] })
if (created) {
  console.log(`added "${name}" as ${cid}, tagged "${TAG}"`)
} else {
  const tags = await store.readTags(cid)
  if (!tags.includes(TAG)) {
    await store.setTags(cid, [...tags, TAG])
    console.log(`tagged "${name}" "${TAG}"`)
  } else {
    console.log(`"${name}" is already there as ${cid}, tagged "${TAG}"`)
  }
}
console.log('done')
