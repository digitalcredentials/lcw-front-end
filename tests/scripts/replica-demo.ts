// Exercises the local replica against the deployed back end and PWS server,
// outside a browser (the replica runs in memory), on an account the run
// makes and deletes (tests/helpers/testAccount.ts): a stand-in passkey opens
// a remembered session, the replica pulls the account's credentials, a
// credential and its tags added through the replica reach the Space, a
// credential added directly reaches the replica, the Trash flow
// round-trips through it, and after a user-key rotation run from the
// session the replica seals what it writes under the new key epoch.
//
//   REGISTRATION_CODE=... npx tsx tests/scripts/replica-demo.ts
import '@interop/http-client'
import { readFileSync } from 'node:fs'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import { PwsClient } from '@interop/pws-client'
import { mintEnrollmentRequest } from '@interop/wallet-core/enrollment'
import { plaintextCollection } from '@interop/wallet-core/space'
import { addPasskeyCredential, approveConnectCode, disconnectWallet, getSession, listConnectedWallets, loginWithPassphrase, memoryClientKeyStore, requireTransient, sessionAgents, setSession } from '../../src/lib/identity'
import { serviceDescriptionFor } from '../../src/lib/identity/service'
import { pendingAnnexCollection } from '../../src/lib/identity/annexGc'
import { randomBytes } from '../../src/lib/identity/bytes'
import { directCredentialStore, discardTrashItem, listTrash, restoreFromTrash, sessionStores, trashCredential, type CredentialBody } from '../../src/lib/credentialStore'
import { replicaFor, setReplicaStorage, stopReplica } from '../../src/lib/replica/replica'
import { credentialFrom } from '../../src/lib/linkedin'
import { withTestAccount } from '../helpers/testAccount'

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

await withTestAccount('replica', async ({ email, passphrase, config }) => {
  // --- a remembered session, its replica in memory ---------------------------
  const password = await loginWithPassphrase({ email, passphrase, config })
  const remembered = await addPasskeyCredential({ session: requireTransient(password), prfOutput: randomBytes(32), config, store: memoryClientKeyStore(), label: 'Replica script passkey' })
  check('the passkey opens a remembered session', remembered.kind === 'remembered')
  if (remembered.kind !== 'remembered') {
    throw new Error('no remembered session')
  }
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
  check('the replica lists the seeded credential after its first pull', listed.some((c) => nameOf(c.body) === 'LCW Experience Badge'), listed.map((c) => nameOf(c.body)))
  check('the seeded credential carries its tag', listed.find((c) => nameOf(c.body) === 'LCW Experience Badge')?.tags.includes('University of Toronto') === true)

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
  check('its tags reached the Space', pushedTags?.includes('Replica') === true, pushedTags)
  await stores.store.setTags(added.cid, ['Replica', 'Second'])
  const retagged = await until('the changed tags are pushed', async () => {
    const tags = await direct.readTags(added.cid)
    return tags.includes('Second') ? tags : null
  })
  check('tags changed through the replica reached the Space', retagged?.includes('Second') === true, retagged)

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

  // --- a user-key rotation run from this session ------------------------------
  // Another wallet is connected and disconnected: the disconnection rotates
  // the user key, this session adopts the new key part-way through, and each
  // collection takes a key epoch under it afterwards. The replica has to seal
  // what it writes from then on under the new epoch.
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
    warn(...args)
  }
  const joiner = await mintEnrollmentRequest()
  await approveConnectCode({ session: getSession()!, code: joiner.code, name: 'Second wallet' })
  const joined = (await listConnectedWallets(getSession()!)).find((wallet) => wallet.did === joiner.clientDid)
  check('a second wallet is connected', joined !== undefined)
  if (joined) {
    const outcome = await disconnectWallet({ session: getSession()!, wallet: joined })
    check('the disconnection completed and rotated the user key', outcome.completion === 'complete' && outcome.rotated, outcome)
    const rotated = getSession()!
    check('the session adopted the rotated user key', rotated.userKey.id !== remembered.userKey.id)
    // The key epoch a stored credential is sealed under, read from the Space as stored
    const { signer } = await sessionAgents(rotated)
    const raw = plaintextCollection({ pws: PwsClient.fromSigner({ baseServerUrl: rotated.serverUrl, signer, serviceDescription: await serviceDescriptionFor(rotated.serverUrl) }), spaceId: rotated.spaceId, collectionId: 'private-credentials' })
    const sealedUnder = async (rid: string) => {
      const envelope = (await raw.resource(rid).get()) as { jwe?: { recipients?: { header?: { kid?: string } }[] } } | null
      return envelope?.jwe?.recipients?.[0]?.header?.kid ?? null
    }
    const after = await sessionStores()
    if (!after) {
      throw new Error('no stores after the rotation')
    }
    const directAfter = await directCredentialStore(after.space).addCredential({ body: fixtureNamed('Direct, after the rotation') })
    const currentEpoch = await sealedUnder(directAfter.rid)
    const viaReplica = await after.store.addCredential({ body: fixtureNamed('Replica, after the rotation') })
    const replicaEpoch = await until('the credential added after the rotation is pushed', () => sealedUnder(viaReplica.rid))
    check('a direct write after the rotation names a key epoch', currentEpoch !== null, currentEpoch)
    check('the replica seals a credential added after the rotation under the same key epoch', replicaEpoch !== null && replicaEpoch === currentEpoch, { replica: replicaEpoch, direct: currentEpoch })
    const pulledAfter = await until('the direct credential is pulled after the rotation', () => after.store.readCredential(directAfter.cid))
    check('the replica reads a credential sealed under the new key epoch', pulledAfter !== null && nameOf(pulledAfter) === 'Direct, after the rotation')
    check('the replica reported no failure to rebuild its ciphers', !warnings.some((line) => line.includes('could not be rebuilt')), warnings.filter((line) => line.includes('could not be rebuilt')).map((line) => line.slice(0, 160)))
    for (const cid of [directAfter.cid, viaReplica.cid]) {
      await trashCredential({ ...after, cid })
      const item = (await listTrash(after.space)).find((entry) => entry.cid === cid)
      if (item) {
        await discardTrashItem(after.space, item)
      }
    }
  }
  console.warn = warn
  await stopReplica()
})
console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
