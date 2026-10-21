// Registers the deployed demo account the way the wallet's register page
// does (src/lib/identity): mints its keys, records the email with the back
// end (which emails the confirmation link), creates the Main Space, publishes
// and promotes the did:webvh, and binds the passphrase. The confirmation
// link still has to be clicked before login works.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com REGISTRATION_CODE=... npx tsx tests/scripts/register-demo.ts
//
// Environment: DEMO_EMAIL and REGISTRATION_CODE (required), DEMO_PASSPHRASE
// (defaults to the deployed tests' passphrase), API_BASE, WAS_URL, ID_DOMAIN
// (default to the sandbox).
import '@interop/http-client'
import { registerAccount } from '../../src/lib/identity'

const email = process.env.DEMO_EMAIL
const registrationCode = process.env.REGISTRATION_CODE
if (!email || !registrationCode) {
  console.error('Set DEMO_EMAIL and REGISTRATION_CODE.')
  process.exit(2)
}
const message = await registerAccount({
  email,
  passphrase: process.env.DEMO_PASSPHRASE ?? 'my-secret-seed-that-is-long-enou',
  registrationCode,
  config: {
    apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
    serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
    idDomain: process.env.ID_DOMAIN ?? 'id.lcw-sandbox.org',
  },
  onStage: (stage) => console.log(`${stage}…`),
})
console.log(message)
