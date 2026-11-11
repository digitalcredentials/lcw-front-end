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
import { sessionAgents, type TransientSession, type RememberedSession } from '../../src/lib/identity/session'
import { serviceDescriptionFor } from '../../src/lib/identity/service'
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

// --- the passphrase still works after all of it ---
const later = await time('passphrase login after the changes', () => openTransientSession({ credential, found, serverUrl: WAS }))
check('the passphrase still opens the account', later.session.userKey.id === session.userKey.id)
const wrong = await fetchStandingRecord({ credential: await passphraseCredential(`${passphrase}-wrong`), serverUrl: WAS })
check('a wrong passphrase finds no record', wrong === null)

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
