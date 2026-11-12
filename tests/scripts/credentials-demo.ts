// Exercises sign-in methods against the deployed back end and PWS server on
// the demo account: signs in with the passphrase (a transient session),
// lists the account's sign-in methods, adds a passkey credential (a
// stand-in: a random secret under the passkey KDF, with the client-key
// record kept in memory), signs in with it as a remembered client, lists
// the methods again, then removes the passkey from a password session and
// disconnects the client the passkey enrolled, leaving the account as it
// was (its user key rotated twice).
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/credentials-demo.ts
import '@interop/http-client'
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
} from '../../src/lib/identity'
import { randomBytes } from '../../src/lib/identity/bytes'

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
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${String(detail)})` : ''}`)
  if (!ok) failures++
}

const session = await loginWithPassphrase({ email, passphrase, config })
check('the password opens a transient session', session.kind === 'transient', session.kind)
const before = await listSignInMethods({ session })
check('the account lists its sign-in methods', before.length >= 1, before.map((m) => `${m.kind}${m.current ? '*' : ''}`).join(', '))
check("the session's method is the password, listed as current", before.find((m) => m.current)?.kind === 'passphrase')

// A passkey credential, standing in for a real passkey with a random PRF output
const prf = randomBytes(32)
const store = memoryClientKeyStore()
const remembered = await addPasskeyCredential({ session: requireTransient(session), prfOutput: prf, config, store, label: 'Script passkey' })
check('adding the passkey continues the session as a remembered client', remembered.kind === 'remembered' && remembered.did === session.did)
const during = await listSignInMethods({ session: remembered })
check('the passkey is listed with its label', during.some((m) => m.kind === 'passkey' && m.label === 'Script passkey'), during.map((m) => m.kind).join(', '))
check('the password is still listed', during.some((m) => m.kind === 'passphrase'))

// A later visit on the passkey: the remembered login reuses the record
const again = await loginWithPasskeySecret({ prfOutput: prf, config, store, email })
check('the passkey signs in as a remembered client', again.kind === 'remembered' && again.userKey.id === session.userKey.id)
check('the passkey session knows the email and the token', again.email === email && typeof again.coupon === 'string')

// Removing the passkey from a password session: its credential is retired
// (the user key rotates), its unlock Space is deleted, and it no longer
// signs in
const password = await loginWithPassphrase({ email, passphrase, config })
const passkeyMethod = (await listSignInMethods({ session: password })).find((m) => m.kind === 'passkey' && m.label === 'Script passkey')
check('the passkey is removable from a password session', passkeyMethod?.removable === true)
const removed = await removeSignInMethod({ session: password, unlockSpaceId: passkeyMethod!.unlockSpaceId })
check('the passkey credential is removed and its Space deleted', removed.completion === 'complete' && removed.unlockSpace === 'deleted', `${removed.completion}, ${removed.unlockSpace}`)
check('the session adopted the rotated user key', removed.session.userKey.id !== password.userKey.id)
const after = await listSignInMethods({ session: removed.session })
check('the registry no longer lists the passkey', !after.some((m) => m.unlockSpaceId === passkeyMethod!.unlockSpaceId), after.map((m) => m.kind).join(', '))
const refused = await loginWithPasskeySecret({ prfOutput: prf, config, store, email }).then(
  () => 'signed in',
  (err: { status?: number; message?: string }) => err.status ?? err.message
)
check('the removed passkey no longer signs in', refused === 401, refused)

// The client the passkey enrolled is still listed; the password session
// disconnects it
const { keyAgent } = await agentsFromSeed({ seed: (again as { clientSeed: Uint8Array }).clientSeed })
const ownKey = clientSigningKeyMultibase({ keyAgent })
const wallets = await listConnectedWallets(removed.session)
const own = wallets.find((w) => w.signingKeyMultibase === ownKey)
check('the client the passkey enrolled is listed under the wallet name', own?.name === 'Learner Credential Wallet', own && { name: own.name, canDisconnect: own.canDisconnect })
if (own) {
  const outcome = await disconnectWallet({ session: removed.session, wallet: own })
  check('the client is disconnected', outcome.completion === 'complete' && outcome.rotated, `${outcome.completion}, rotated ${outcome.rotated}`)
}

process.exit(failures ? 1 : 0)
