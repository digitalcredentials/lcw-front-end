// Registers an account kept by hand (one to show the wallet with) the way
// the wallet's register page does (src/lib/identity): creates the account
// Space with the registration code and the client-annex Space under it, runs
// the credential-anchored genesis on the passphrase, records the email with
// the back end (which emails the confirmation link), and promotes the Spaces
// to the account's did:webvh. The confirmation link still has to be clicked
// before login works.
//
// The tests do not use it: each run makes and deletes an account of its own
// (tests/helpers/testAccount.ts).
//
//   DEMO_EMAIL=... DEMO_PASSPHRASE=... REGISTRATION_CODE=... npx tsx tests/scripts/register-demo.ts
//
// Environment: DEMO_EMAIL, DEMO_PASSPHRASE and REGISTRATION_CODE (required),
// API_BASE and WAS_URL (default to the sandbox).
import '@interop/http-client'
import { registerAccount } from '../../src/lib/identity'

const email = process.env.DEMO_EMAIL
const passphrase = process.env.DEMO_PASSPHRASE
const registrationCode = process.env.REGISTRATION_CODE
if (!email || !passphrase || !registrationCode) {
  console.error('Set DEMO_EMAIL, DEMO_PASSPHRASE and REGISTRATION_CODE.')
  process.exit(2)
}
const message = await registerAccount({
  email,
  passphrase,
  registrationCode,
  config: {
    apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
    serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
  },
  onStage: (stage) => console.log(`${stage}…`),
})
console.log(message)
