// Exercises the local replica against the deployed back end and PWS server
// on the demo account, outside a browser (the replica runs in memory): a
// stand-in passkey opens a remembered session, the replica pulls the
// account's credentials, a credential and its tags added through the
// replica reach the Space, a credential added directly reaches the
// replica, and the Trash flow round-trips through it.
//
// The stand-in passkey's secret and the client it enrolled are kept in
// tests/.replica-client.json, so later runs open the same remembered client
// and add nothing to the account's logs; `--remove` retires the passkey and
// disconnects the client at the end (two user-key rotations, each of which
// appends a whole descriptor to the roster log and to every encrypted
// collection's log) and deletes the file.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/replica-demo.ts [--remove]
import '@interop/http-client'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { agentsFromSeed } from '@interop/pws-client/identity'
import { decodeClientKeyRecord, encodeClientKeyRecord } from '@interop/wallet-core/keys'
import { clientSigningKeyMultibase } from '@interop/wallet-core/webvh'
import {
  addPasskeyCredential,
  disconnectWallet,
  listConnectedWallets,
  listSignInMethods,
  loginWithPassphrase,
  loginWithPasskeySecret,
  removeSignInMethod,
  requireTransient,
  setSession,
  type Session,
} from '../../src/lib/identity'
import { pendingAnnexCollection } from '../../src/lib/identity/annexGc'
import { randomBytes } from '../../src/lib/identity/bytes'
import type { ClientKeyStore } from '../../src/lib/identity/clientKeyRecord'
import { directCredentialStore, discardTrashItem, listTrash, restoreFromTrash, sessionStores, trashCredential, type CredentialBody } from '../../src/lib/credentialStore'
import { replicaFor, setReplicaStorage, stopReplica } from '../../src/lib/replica/replica'
import { credentialFrom } from '../../src/lib/linkedin'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const remove = process.argv.includes('--remove')
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
const nameOf = (body: CredentialBody | null | undefined) => body?.name
// A credential of its own: the badge credential (inside the fixture's
// presentation) under another name
function fixtureNamed(name: string): CredentialBody {
  const credential = credentialFrom(JSON.parse(readFileSync(new URL('../fixtures/PlaywrightUpload.json', import.meta.url), 'utf8'))) as CredentialBody
  return { ...credential, name }
}

// --- the stand-in passkey and its client, kept between runs ---------------
const STATE_FILE = new URL('../.replica-client.json', import.meta.url)
interface State {
  // The passkey's PRF output, base64url
  prf: string
  // The client-key records by unlock Space id, as wallet-core encodes them
  records: Record<string, unknown>
}
const saveState = (state: State) => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
const fileClientKeyStore = (state: State): ClientKeyStore => ({
  load: async (unlock) => {
    const contents = state.records[unlock.spaceId]
    return contents ? decodeClientKeyRecord({ contents }) : null
  },
  save: async (unlock, record) => {
    state.records[unlock.spaceId] = encodeClientKeyRecord(record)
    saveState(state)
  },
  remove: async (unlockSpaceId) => {
    delete state.records[unlockSpaceId]
    saveState(state)
  },
})

// --- a remembered session, its replica in memory ---------------------------
let state: State | null = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : null
let remembered: Session
if (state) {
  remembered = await loginWithPasskeySecret({ prfOutput: new Uint8Array(Buffer.from(state.prf, 'base64url')), config, store: fileClientKeyStore(state), email })
  check('the kept passkey opens the same remembered client again', remembered.kind === 'remembered')
} else {
  const password = await loginWithPassphrase({ email, passphrase, config })
  const prf = randomBytes(32)
  state = { prf: Buffer.from(prf).toString('base64url'), records: {} }
  remembered = await addPasskeyCredential({ session: requireTransient(password), prfOutput: prf, config, store: fileClientKeyStore(state), label: 'Replica script passkey' })
  saveState(state)
  check('the passkey opens a remembered session', remembered.kind === 'remembered')
}
if (remembered.kind !== 'remembered') {
  throw new Error('no remembered session')
}
const prf = new Uint8Array(Buffer.from(state.prf, 'base64url'))
const store = fileClientKeyStore(state)
const collection = await pendingAnnexCollection()
check('the stale client-annex generations were collected at login', collection !== null, collection && { collected: collection.collected.length, deferred: collection.deferred.length, failed: collection.failed.length })
setReplicaStorage(getRxStorageMemory())
setSession(remembered)
const stores = await sessionStores()
if (!stores) {
  throw new Error('no stores')
}
check('a remembered session reads through the replica', stores.store.kind === 'replica', stores.store.kind)
const replica = replicaFor(remembered)
check('the replica is running for the session', replica !== null)
// The Space read directly, as a password session reads it
const direct = directCredentialStore(stores.space)

// --- the first pull ---------------------------------------------------------
const listed = await stores.store.loadCredentials()
check('the replica lists the demo credential after its first pull', listed.some((c) => nameOf(c.body) === 'LCW Experience Badge'), listed.map((c) => nameOf(c.body)))
check('the demo credential carries its tag', listed.find((c) => nameOf(c.body) === 'LCW Experience Badge')?.tags.includes('University of Toronto'))

// --- a credential and its tags added through the replica reach the Space ---
const added = await stores.store.addCredential({ body: fixtureNamed('Replica script credential'), tags: ['Replica'] })
check('the replica stores the credential under its content cid', added.created && added.cid.length > 10 && added.rid !== added.cid, added)
check('the same credential added again is the one already there', (await stores.store.addCredential({ body: fixtureNamed('Replica script credential') })).created === false)
const pushed = await until('the credential is pushed', () => direct.readCredential(added.cid))
check('the credential added through the replica is readable directly', pushed !== null && nameOf(pushed) === 'Replica script credential')
const pushedTags = await until('its tags are pushed', async () => {
  const tags = await direct.readTags(added.cid)
  return tags.includes('Replica') ? tags : null
})
check('its tags reached the Space', pushedTags?.includes('Replica'), pushedTags)
await stores.store.setTags(added.cid, ['Replica', 'Second'])
const retagged = await until('the changed tags are pushed', async () => {
  const tags = await direct.readTags(added.cid)
  return tags.includes('Second') ? tags : null
})
check('tags changed through the replica reached the Space', retagged?.includes('Second'), retagged)

// --- a credential added directly reaches the replica ------------------------
const directAdded = await direct.addCredential({ body: fixtureNamed('Direct credential'), tags: ['Direct'] })
replica?.reSync()
const pulled = await until('the direct credential is pulled', () => stores.store.readCredential(directAdded.cid))
check('a credential added directly is readable through the replica', pulled !== null && nameOf(pulled) === 'Direct credential')
check('its tags came with it', (await stores.store.readTags(directAdded.cid)).includes('Direct'), await stores.store.readTags(directAdded.cid))

// --- Trash through the replica ------------------------------------------------
await trashCredential({ ...stores, cid: added.cid })
const gone = await until('the deletion is pushed', async () => ((await direct.readCredential(added.cid)) === null ? true : null))
check('a credential trashed through the replica is deleted from the Space', gone === true)
const trashed = (await listTrash(stores.space)).find((item) => item.cid === added.cid)
check('the Trash record holds its body and tags', trashed !== undefined && nameOf(trashed.body) === 'Replica script credential' && trashed.tags.includes('Second'))
if (trashed) {
  const restored = await restoreFromTrash({ ...stores, item: trashed })
  const back = await until('the restored credential is pushed', () => direct.readCredential(restored.cid))
  check('a credential restored through the replica is readable directly, in a new resource under the same cid', back !== null && restored.cid === added.cid && restored.rid !== added.rid)
  // Both script credentials go, so the account is left with the badge alone
  for (const cid of [restored.cid, directAdded.cid]) {
    await trashCredential({ ...stores, cid })
    const item = (await listTrash(stores.space)).find((entry) => entry.cid === cid)
    if (item) {
      await discardTrashItem(stores.space, item)
    }
  }
  await until('the cleanup is pushed', async () => ((await direct.readCredential(directAdded.cid)) === null ? true : null))
}
await stopReplica()

// --- the passkey and its client: kept for the next run, or removed ----------
if (!remove) {
  console.log('     the passkey and its client are kept for the next run (tests/.replica-client.json); pass --remove to retire them')
} else {
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
  check('the removed passkey no longer opens the client that held its record', refused !== 'signed in', refused)
  unlinkSync(STATE_FILE)
}
console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
