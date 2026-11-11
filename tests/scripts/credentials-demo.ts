// Exercises sign-in methods against the deployed back end and PWS server on
// the demo account: signs in with the passphrase (a transient session),
// lists the account's sign-in methods, adds a passkey credential (a
// stand-in: a random secret under the passkey KDF, with the client-key
// record kept in memory), signs in with it as a remembered client, and
// lists the methods again. The passkey credential stays listed: removing a
// method is not part of this wallet yet.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/credentials-demo.ts
import '@interop/http-client'
import { addPasskeyCredential, listSignInMethods, loginWithPassphrase, loginWithPasskeySecret, memoryClientKeyStore, requireTransient } from '../../src/lib/identity'
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

process.exit(failures ? 1 : 0)
