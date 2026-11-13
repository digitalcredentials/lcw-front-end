// Exercises the local replica against the deployed back end and PWS server
// on the demo account, outside a browser (the replica runs in memory): a
// stand-in passkey opens a remembered session, the replica pulls the
// account's credentials, a credential and its tags added through the
// replica reach the Space, a credential added directly reaches the
// replica, and the Trash flow round-trips through it. The passkey and the
// client it enrolled are removed at the end, so the account is left as it
// was (its user key rotated twice).
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/replica-demo.ts
import '@interop/http-client'
import { readFileSync } from 'node:fs'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { agentsFromSeed } from '@interop/pws-client/identity'
import { clientSigningKeyMultibase } from '@interop/wallet-core/webvh'
import {
  addPasskeyCredential,
  disconnectWallet,
  listConnectedWallets,
  listSignInMethods,
  loginWithPassphrase,
  loginWithPasskeySecret,
  memoryClientKeyStore,
  removeSignInMethod,
  requireTransient,
  setSession,
} from '../../src/lib/identity'
import { randomBytes } from '../../src/lib/identity/bytes'
import { discardTrashItem, listTrash, restoreFromTrash, sessionStores, trashCredential, type CredentialBody } from '../../src/lib/credentialStore'
import { addCredential as addDirect, readCredential as readDirect, readTags as readTagsDirect } from '../../src/lib/credentials'
import { replicaFor, setReplicaStorage, stopReplica } from '../../src/lib/replica/replica'
import { credentialFrom } from '../../src/lib/linkedin'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const passphrase = process.env.DEMO_PASSPHRASE ?? 'my-secret-seed-that-is-long-enou'
const config = {
  apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
  serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
}
let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}
// Waits for a condition replication has to bring about
async function until<T>(label: string, probe: () => Promise<T | null | false>, ms = 90_000): Promise<T | null> {
  const started = Date.now()
  for (;;) {
    const found = await probe().catch(() => null)
    if (found) {
      console.log(`     ${label}: ${Date.now() - started} ms`)
      return found
    }
    if (Date.now() - started > ms) {
      console.log(`     ${label}: not within ${ms} ms`)
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
// The credential's own `name` member (the display name a wallet derives can
// come from the achievement instead)
const nameOf = (body: CredentialBody) => (credentialFrom(body) as { name?: unknown } | null)?.name
// A credential of its own: the badge fixture (a presentation envelope
// around one credential) with another name on the credential
function fixtureNamed(name: string): CredentialBody {
  const body = JSON.parse(readFileSync(new URL('../fixtures/PlaywrightUpload.json', import.meta.url), 'utf8')) as CredentialBody & { verifiableCredential: Record<string, unknown>[] }
  body.verifiableCredential[0].name = name
  return body
}

// --- a remembered session, its replica in memory ---------------------------
const password = await loginWithPassphrase({ email, passphrase, config })
const prf = randomBytes(32)
const store = memoryClientKeyStore()
const remembered = await addPasskeyCredential({ session: requireTransient(password), prfOutput: prf, config, store, label: 'Replica script passkey' })
check('the passkey opens a remembered session', remembered.kind === 'remembered')
setReplicaStorage(getRxStorageMemory())
setSession(remembered)
const stores = await sessionStores()
if (!stores) {
  throw new Error('no stores')
}
check('a remembered session reads through the replica', stores.store.kind === 'replica', stores.store.kind)
const replica = replicaFor(remembered)
check('the replica is running for the session', replica !== null)

// --- the first pull ---------------------------------------------------------
const listed = await stores.store.loadCredentials()
check('the replica lists the demo credential after its first pull', listed.some((c) => nameOf(c.body) === 'LCW Experience Badge'), listed.map((c) => nameOf(c.body)))
check('the demo credential carries its tag', listed.find((c) => nameOf(c.body) === 'LCW Experience Badge')?.tags.includes('University of Toronto'))

// --- a credential and its tags added through the replica reach the Space ---
const added = await stores.store.addCredential({ body: fixtureNamed('Replica script credential'), tags: ['Replica'] })
check('the replica mints a content-derived id', added.cid.length > 10, added.cid)
const pushed = await until('the credential is pushed', () => readDirect(stores.space, added.cid))
check('the credential added through the replica is readable directly', pushed !== null && nameOf(pushed) === 'Replica script credential')
const pushedTags = await until('its tags are pushed', async () => {
  const tags = await readTagsDirect(stores.space, added.cid)
  return tags.includes('Replica') ? tags : null
})
check('its tags reached the Space', pushedTags?.includes('Replica'), pushedTags)
await stores.store.setTags(added.cid, ['Replica', 'Second'])
const retagged = await until('the changed tags are pushed', async () => {
  const tags = await readTagsDirect(stores.space, added.cid)
  return tags.includes('Second') ? tags : null
})
check('tags changed through the replica reached the Space', retagged?.includes('Second'), retagged)

// --- a credential added directly reaches the replica ------------------------
const direct = await addDirect({ space: stores.space, body: fixtureNamed('Direct credential'), tags: ['Direct'] })
replica?.reSync()
const pulled = await until('the direct credential is pulled', () => stores.store.readCredential(direct.cid))
check('a credential added directly is readable through the replica', pulled !== null && nameOf(pulled) === 'Direct credential')
check('its tags came with it', (await stores.store.readTags(direct.cid)).includes('Direct'), await stores.store.readTags(direct.cid))

// --- Trash through the replica ------------------------------------------------
await trashCredential({ ...stores, cid: added.cid })
const gone = await until('the deletion is pushed', async () => ((await readDirect(stores.space, added.cid)) === null ? true : null))
check('a credential trashed through the replica is deleted from the Space', gone === true)
const trashed = (await listTrash(stores.space)).find((item) => item.cid === added.cid)
check('the Trash record holds its body and tags', trashed !== undefined && nameOf(trashed.body) === 'Replica script credential' && trashed.tags.includes('Second'))
if (trashed) {
  const restored = await restoreFromTrash({ ...stores, item: trashed })
  const back = await until('the restored credential is pushed', () => readDirect(stores.space, restored.cid))
  check('a credential restored through the replica is readable directly, under a new id', back !== null && restored.cid !== added.cid)
  // Both script credentials go, so the account is left with the badge alone
  for (const cid of [restored.cid, direct.cid]) {
    await trashCredential({ ...stores, cid })
    const item = (await listTrash(stores.space)).find((entry) => entry.cid === cid)
    if (item) {
      await discardTrashItem(stores.space, item)
    }
  }
  await until('the cleanup is pushed', async () => ((await readDirect(stores.space, direct.cid)) === null ? true : null))
}
await stopReplica()

// --- the passkey and its client, removed again ------------------------------
const cleanup = await loginWithPassphrase({ email, passphrase, config })
const passkeyMethod = (await listSignInMethods({ session: cleanup })).find((m) => m.kind === 'passkey' && m.label === 'Replica script passkey')
const removed = passkeyMethod ? await removeSignInMethod({ session: cleanup, unlockSpaceId: passkeyMethod.unlockSpaceId }) : null
check('the passkey is removed again', removed?.completion === 'complete', removed && `${removed.completion}, unlock Space ${removed.unlockSpace}`)
const { keyAgent } = await agentsFromSeed({ seed: remembered.clientSeed })
const ownKey = clientSigningKeyMultibase({ keyAgent })
const wallets = await listConnectedWallets(removed?.session ?? cleanup)
const own = wallets.find((w) => w.signingKeyMultibase === ownKey)
const outcome = own ? await disconnectWallet({ session: removed?.session ?? cleanup, wallet: own }) : null
check('the client is disconnected again', outcome?.completion === 'complete', outcome ?? 'not listed')
const refused = await loginWithPasskeySecret({ prfOutput: prf, config, store, email }).then(
  () => 'signed in',
  (err: { status?: number; message?: string }) => err.status ?? err.message
)
check('the removed passkey no longer opens the browser that held its record', refused !== 'signed in', refused)
console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
