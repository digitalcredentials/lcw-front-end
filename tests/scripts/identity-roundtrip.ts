// The identity layer against a PWS server, end to end and without the back
// end: signup (the credential-anchored genesis), the transient login on the
// passphrase, a passkey credential added from it (a random secret under the
// passkey KDF stands in for the PRF output), the remembered login that
// self-enrolls this "browser" and the one that reuses its record, a
// recovery code issued from each session kind and used, and the passphrase
// again at the end.
//
//   WAS_URL=https://was.lcw-sandbox.org COUPON=... npx tsx tests/scripts/identity-roundtrip.ts
//   WAS_URL=http://localhost:3002 PROVISIONING=open npx tsx tests/scripts/identity-roundtrip.ts
//
// With a COUPON every Space (the account and annex Spaces, each
// credential's unlock Space) is created through POST /spaces/ with it (this
// server); with PROVISIONING=open the ceremonies create them by id (the
// reference server). The account it creates is left behind.
import '@interop/http-client'
import { PwsClient } from '@interop/pws-client'
import { signUp } from '../../src/lib/identity/signup'
import { deriveUnlockCredential, passphraseCredential } from '../../src/lib/identity/credential'
import { PASSKEY_KDF } from '../../src/lib/identity/passkey'
import { fetchStandingRecord } from '../../src/lib/identity/records'
import { openTransientSession } from '../../src/lib/identity/transient'
import { addStandingCredential } from '../../src/lib/identity/standing'
import { openRememberedSession } from '../../src/lib/identity/remembered'
import { memoryClientKeyStore } from '../../src/lib/identity/clientKeyRecord'
import { issueRecoveryCode, recoverWithCode } from '../../src/lib/identity/recovery'
import { readUnlockMethods, updateUnlockMethods, upsertMethod } from '../../src/lib/identity/unlockMethods'
import { getSession, sessionAgents, setSession, type TransientSession, type RememberedSession } from '../../src/lib/identity/session'
import { serviceDescriptionFor } from '../../src/lib/identity/service'
import { pointerOf } from '../../src/lib/identity/records'
import { CLIENT_NAME, approveConnectCode, disconnectWallet, listConnectedWallets, nameOwnClient, renameConnectedWallet } from '../../src/lib/identity/clients'
import { MethodNotRemovableError, retireMethod } from '../../src/lib/identity/retire'
import { completeEnrollmentCore, mintEnrollmentRequest } from '@interop/wallet-core/enrollment'
import { randomBytes, toBase64url } from '../../src/lib/identity/bytes'

const WAS = (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, '')
const PROVISIONING = (process.env.PROVISIONING as 'open' | 'coupon' | undefined) ?? (process.env.COUPON ? 'coupon' : 'open')
const COUPON = process.env.COUPON ?? 'no-coupon'
// What a session carries as its coupon (the registration token, after a
// back-end login): here the coupon given, so the unlock Spaces the later
// steps create redeem it too
const coupon = PROVISIONING === 'coupon' ? COUPON : undefined
const passphrase = `roundtrip-passphrase-${Date.now()}-${Math.random().toString(36).slice(2)}`
const email = `roundtrip-${Date.now()}@example.test`

let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
  const started = Date.now()
  try {
    return await fn()
  } finally {
    console.log(`     ${label}: ${Date.now() - started} ms`)
  }
}

async function registryOf(session: TransientSession | RememberedSession) {
  const { signer, capabilityFor } = await sessionAgents(session)
  const pws = PwsClient.fromSigner({ baseServerUrl: WAS, signer, serviceDescription: await serviceDescriptionFor(WAS) })
  return { pws, capability: capabilityFor(session.spaceId) }
}

console.log(`server ${WAS}, provisioning ${PROVISIONING}`)
const signup = await time('signup', () => signUp({ email, passphrase, registrationCode: COUPON, config: { serverUrl: WAS, provisioning: PROVISIONING } }))
check('signup publishes a did:webvh', signup.establishment.did.startsWith('did:webvh:'), signup.establishment.did)
check('signup reports no failed stages', signup.establishment.failed.length === 0, signup.establishment.failed)

// --- the transient login on the passphrase ---
const credential = await time('passphrase derivation', () => passphraseCredential(passphrase))
const found = await fetchStandingRecord({ credential, serverUrl: WAS })
check('the standing record points at the account', found?.pointer.did === signup.establishment.did)
check('the record proof verified', found?.proofState === 'verified', found?.proofState)
if (!found) {
  throw new Error('no record')
}
const entry = await time('transient login', () => openTransientSession({ credential, found, serverUrl: WAS }))
const session: TransientSession = { ...entry.session, email, coupon }
check('the session signs as the client annex', session.clientAnnexDid.startsWith('did:webvh:') && session.clientAnnexDid !== session.did)
const first = await registryOf(session)
const registry = await readUnlockMethods({ pws: first.pws, spaceId: session.spaceId, userKey: session.userKey, capability: first.capability })
check('the registry lists the passphrase', registry?.record.methods.some((m) => m.type === 'passphrase'), registry?.record.methods.map((m) => m.type))

// --- a passkey credential, added from the transient session ---
const prf = randomBytes(32)
const passkey = await deriveUnlockCredential({ secret: prf, kdf: PASSKEY_KDF })
const established = await time('add a passkey credential (ladder branch)', () => addStandingCredential({ session, credential: passkey, lowEntropy: false, email }))
check('the passkey credential has its own unlock Space', established.unlockSpaceId === passkey.unlock.spaceId)
await updateUnlockMethods({
  pws: first.pws,
  spaceId: session.spaceId,
  userKey: session.userKey,
  capability: first.capability,
  mutate: (existing) =>
    upsertMethod({
      record: existing!,
      entry: {
        type: 'passkey',
        label: 'Round-trip passkey',
        createdAt: new Date().toISOString(),
        credentialId: toBase64url(randomBytes(16)),
        transports: ['internal'],
        backupEligibility: false,
        backupState: false,
        unlockSpaceId: established.unlockSpaceId,
        ...(established.manageCapability && { manageCapability: established.manageCapability }),
        ...established.standingFields,
      },
    }),
})

// --- the remembered login on the passkey: a fresh "browser" self-enrolls ---
const store = memoryClientKeyStore()
const passkeyFound = await fetchStandingRecord({ credential: passkey, serverUrl: WAS })
check('the passkey record carries the standing layout', Boolean(passkeyFound?.ladderSeed && passkeyFound.delegation && passkeyFound.delegatedClients))
if (!passkeyFound) {
  throw new Error('no passkey record')
}
const remembered = await time('remembered login (self-enrollment)', () => openRememberedSession({ credential: passkey, found: passkeyFound, serverUrl: WAS, store }))
check('the fresh browser enrolled a client', remembered.enrolled)
check('the remembered session signs as the account', remembered.session.did === session.did)
check('the remembered session reads the same user key', remembered.session.userKey.id === session.userKey.id)
const again = await time('remembered login (record present)', () => openRememberedSession({ credential: passkey, found: passkeyFound, serverUrl: WAS, store }))
check('a second remembered login reuses the record', !again.enrolled && toBase64url(again.session.clientSeed) === toBase64url(remembered.session.clientSeed))
const rememberedSession: RememberedSession = { ...again.session, email, coupon }
await time('name this browser in the connections directory', () => nameOwnClient(rememberedSession))
const second = await registryOf(rememberedSession)
const registry2 = await readUnlockMethods({ pws: second.pws, spaceId: session.spaceId, userKey: rememberedSession.userKey, capability: second.capability })
check('the registry lists both methods', registry2?.record.methods.map((m) => m.type).sort().join(',') === 'passkey,passphrase', registry2?.record.methods.map((m) => m.type))

// --- a recovery code, issued from the remembered session, then used ---
const issued = await time('issue a recovery code (enrolled branch)', () => issueRecoveryCode({ session: rememberedSession }))
check('the code entry names its unlock Space', issued.entry.unlockSpaceId.length > 0)
await updateUnlockMethods({ pws: second.pws, spaceId: session.spaceId, userKey: rememberedSession.userKey, mutate: (existing) => upsertMethod({ record: existing!, entry: issued.entry }) })
const recovered = await time('recovery login (transient)', () => recoverWithCode({ code: issued.code, serverUrl: WAS }))
check('the recovery code opens the account', recovered?.session.did === session.did)
check('the recovery session holds the user key', recovered?.session.userKey.id === session.userKey.id)

// --- a second recovery code, issued from the recovery (transient) session ---
if (recovered) {
  const transientRecovery: TransientSession = { ...recovered.session, email, coupon }
  const issuedAgain = await time('issue a recovery code (ladder branch)', () => issueRecoveryCode({ session: transientRecovery, label: 'Second code' }))
  const recoveredAgain = await time('second code login', () => recoverWithCode({ code: issuedAgain.code, serverUrl: WAS }))
  check('the second code opens the account', recoveredAgain?.session.did === session.did)
}

// --- connected wallets: a joiner (another wallet, minting its own keys and
// showing a connect code) approved from the transient session, listed,
// renamed, and disconnected (the ladder arm) ---
const pointer = pointerOf({ serverUrl: WAS, spaceId: session.spaceId, did: session.did })
const serviceDescription = await serviceDescriptionFor(WAS)
const complete = (joiner: Awaited<ReturnType<typeof mintEnrollmentRequest>>) =>
  completeEnrollmentCore({ clientSeed: joiner.clientSeed, webvhUpdateKeys: joiner.webvhUpdateKeys, pointer, serviceDescription })
const joiner = await mintEnrollmentRequest()
// A fresh transient session: the recovery logins above each minted a new
// annex generation (a code's rung is not committed in advance), so the
// first session's generation delegation no longer names the pointed one
const freshEntry = await time('passphrase login before the approvals', () => openTransientSession({ credential, found, serverUrl: WAS }))
const session2: TransientSession = { ...freshEntry.session, email, coupon }
// The clients module adopts a rotated user key into the stored session
setSession(session2)
const approved = await time('approve a connect code (ladder arm)', () => approveConnectCode({ session: session2, code: joiner.code, name: 'Wallet 2', label: 'Phone' }))
check('the approval names the joiner', approved.clientDid === joiner.clientDid)
const joined = await time('the joiner completes its enrollment', () => complete(joiner))
check('the joiner reads the user key', joined.userKey.id === session.userKey.id)
let wallets = await time('list the connected wallets (transient)', () => listConnectedWallets(session2))
check('the list shows this browser and the joiner', wallets.length === 2, wallets.map((w) => `${w.displayName}:${w.canDisconnect}`))
check('this browser is listed under the wallet name', wallets.some((w) => w.name === CLIENT_NAME), wallets.map((w) => w.name))
const joinerRow = wallets.find((w) => w.did === joiner.clientDid)
check('the joiner is listed under its label', joinerRow?.label === 'Phone' && joinerRow.name === 'Wallet 2', joinerRow && { name: joinerRow.name, label: joinerRow.label })
check('a transient session marks no row as its own', wallets.every((w) => !w.isCurrent))
if (!joinerRow) {
  throw new Error('the joiner is not listed')
}
await renameConnectedWallet({ session: session2, signingKeyMultibase: joinerRow.signingKeyMultibase, label: 'Old phone' })
wallets = await listConnectedWallets(session2)
check('the joiner is renamed', wallets.find((w) => w.did === joiner.clientDid)?.label === 'Old phone')
const outcome = await time('disconnect the joiner (ladder arm)', () => disconnectWallet({ session: session2, wallet: wallets.find((w) => w.did === joiner.clientDid)! }))
check('the disconnection completed and rotated the user key', outcome.completion === 'complete' && outcome.rotated, outcome)
const rotated = getSession()
check('the session adopted the rotated user key', rotated !== null && rotated.userKey.id !== session.userKey.id)
if (!rotated) {
  throw new Error('no session after the rotation')
}
wallets = await listConnectedWallets(rotated)
check('the joiner is no longer listed', !wallets.some((w) => w.did === joiner.clientDid), wallets.map((w) => w.displayName))
const refused = await complete(joiner).then(
  () => 'completed',
  (err: { name?: string }) => err.name
)
check('the disconnected joiner is refused', refused === 'EnrollmentPendingError', refused)
const third = await registryOf(rotated)
const registry3 = await readUnlockMethods({ pws: third.pws, spaceId: session.spaceId, userKey: rotated.userKey, capability: third.capability })
check('the registry is re-sealed under the rotated key', registry3 !== null && registry3.record.methods.some((m) => m.type === 'recovery-code'), registry3?.record.methods.map((m) => m.type))

// --- the remembered browser adopts the rotation, then approves and
// disconnects a joiner itself (the enrolled arm) ---
const afterRotation = await time('remembered login after the rotation', () => openRememberedSession({ credential: passkey, found: passkeyFound, serverUrl: WAS, store }))
check('the remembered browser adopts the rotated user key', afterRotation.session.userKey.id === rotated.userKey.id)
const rememberedNow: RememberedSession = { ...afterRotation.session, email, coupon }
setSession(rememberedNow)
const joiner2 = await mintEnrollmentRequest()
await time('approve a connect code (enrolled arm)', () => approveConnectCode({ session: rememberedNow, code: joiner2.code, name: 'Wallet 3' }))
const joined2 = await time('the second joiner completes', () => complete(joiner2))
check('the second joiner reads the current user key', joined2.userKey.id === rememberedNow.userKey.id)
wallets = await time('list the connected wallets (remembered)', () => listConnectedWallets(rememberedNow))
const own = wallets.find((w) => w.isCurrent)
check('this browser is marked as the current wallet', own?.name === CLIENT_NAME, own && { name: own.name, label: own.label })
check('a browser cannot disconnect itself', own?.canDisconnect === false && own.refusal === 'self', own?.refusal)
check('the second joiner is listed under its name', wallets.find((w) => w.did === joiner2.clientDid)?.name === 'Wallet 3')
const outcome2 = await time('disconnect the second joiner (enrolled arm)', () => disconnectWallet({ session: rememberedNow, wallet: wallets.find((w) => w.did === joiner2.clientDid)! }))
check('the second disconnection completed and rotated the user key', outcome2.completion === 'complete' && outcome2.rotated, outcome2)
const current = getSession()
if (!current) {
  throw new Error('no session after the second rotation')
}
check('the remembered session adopted the rotated user key', current.userKey.id !== rememberedNow.userKey.id)

// --- removing sign-in methods: the recovery codes and the passkey retired
// from a passphrase session (the ladder arm), the session adopting each
// rotation; a credential cannot retire itself ---
const retiring = await time('passphrase login before the retirements', () => openTransientSession({ credential, found, serverUrl: WAS }))
let acting: TransientSession = { ...retiring.session, email, coupon }
setSession(acting)
check('the passphrase session adopted the rotated user key at sign-in', acting.userKey.id === current.userKey.id)
const before = await registryOf(acting)
const listed = (await readUnlockMethods({ pws: before.pws, spaceId: session.spaceId, userKey: acting.userKey, capability: before.capability }))?.record.methods ?? []
const selfRefusal = await retireMethod({ session: acting, method: listed.find((m) => m.type === 'passphrase')! }).then(
  () => 'retired',
  (err: unknown) => (err instanceof MethodNotRemovableError ? err.reason : String(err))
)
check('the acting passphrase refuses to retire itself', selfRefusal === 'acting', selfRefusal)
// Each retirement deletes the credential's unlock Space through a
// DELETE-only child of its management capability (the container rule's
// Space-delete exception), so a retired credential finds no record
for (const method of listed.filter((m) => m.type === 'recovery-code')) {
  const outcome = await time(`retire a recovery code (${method.label})`, () => retireMethod({ session: acting, method }))
  check(`the recovery code "${method.label}" is retired and its unlock Space deleted`, outcome.completion === 'complete' && outcome.unlockSpace === 'deleted', `${outcome.completion}, unlock Space ${outcome.unlockSpace}`)
  acting = outcome.session as TransientSession
}
const spent = await recoverWithCode({ code: issued.code, serverUrl: WAS }).then(
  (result) => (result === null ? 'no record' : 'opened'),
  (err: { name?: string }) => err.name ?? String(err)
)
check('a retired recovery code finds no record', spent === 'no record', spent)
const passkeyEntry = listed.find((m) => m.type === 'passkey')!
const passkeyOutcome = await time('retire the passkey credential', () => retireMethod({ session: acting, method: passkeyEntry }))
check('the passkey credential is retired and its unlock Space deleted', passkeyOutcome.completion === 'complete' && passkeyOutcome.unlockSpace === 'deleted', `${passkeyOutcome.completion}, unlock Space ${passkeyOutcome.unlockSpace}`)
acting = passkeyOutcome.session as TransientSession
check('the retired passkey finds no record', (await fetchStandingRecord({ credential: passkey, serverUrl: WAS })) === null)
const afterRetirements = await registryOf(acting)
const registryAfter = await readUnlockMethods({ pws: afterRetirements.pws, spaceId: session.spaceId, userKey: acting.userKey, capability: afterRetirements.capability })
check('the registry lists the passphrase alone', registryAfter?.record.methods.map((m) => m.type).join(',') === 'passphrase', registryAfter?.record.methods.map((m) => m.type))
wallets = await listConnectedWallets(acting)
check('the passkey-enrolled browser is still a client until it is disconnected', wallets.length === 1, wallets.map((w) => w.displayName))
const lastOutcome = await time('disconnect the passkey-enrolled browser', () => disconnectWallet({ session: acting, wallet: wallets[0] }))
check('the last client is disconnected from the passphrase session', lastOutcome.completion === 'complete', lastOutcome)
acting = getSession() as TransientSession

// --- the passphrase still works after all of it ---
const later = await time('passphrase login after the changes', () => openTransientSession({ credential, found, serverUrl: WAS }))
check('the passphrase still opens the account, on the rotated user key', later.session.userKey.id === acting.userKey.id)
const last = await registryOf({ ...later.session, email, coupon })
const registryLast = await readUnlockMethods({ pws: last.pws, spaceId: session.spaceId, userKey: later.session.userKey, capability: last.capability })
check('the registry opens under the rotated key at the next sign-in', registryLast !== null)
const wrong = await fetchStandingRecord({ credential: await passphraseCredential(`${passphrase}-wrong`), serverUrl: WAS })
check('a wrong passphrase finds no record', wrong === null)

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
