// Exercises account recovery against the deployed back end and PWS server on
// the demo account: mints its recovery credential, recovers with that code
// (setting the passphrase back to the same value), and checks that the used
// code no longer opens anything and that a replacement is stored. Run once
// on a freshly registered account, since only a freshly minted code is known
// to the script (afterwards it is only in the stored copy and the mailbox).
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/recovery-demo.ts
import '@interop/http-client'
import { deriveUnlockIdentity } from '@interop/wallet-core/keyring'
import { ensureRecoveryCredential, openWithPassphrase, recoverAccount, sessionAgents } from '../../src/lib/identity'
import { readCredential } from '../../src/lib/identity/unlock'
import { RECOVERY_KDF, recoverySecretOf } from '../../src/lib/identity/recoveryCode'

const email = process.env.DEMO_EMAIL
if (!email) {
  console.error("Set DEMO_EMAIL to the demo account's email.")
  process.exit(2)
}
const passphrase = process.env.DEMO_PASSPHRASE ?? 'my-secret-seed-that-is-long-enou'
const config = {
  apiBase: (process.env.API_BASE ?? 'https://api.lcw-sandbox.org').replace(/\/+$/, ''),
  serverUrl: (process.env.WAS_URL ?? 'https://was.lcw-sandbox.org').replace(/\/+$/, ''),
  idDomain: process.env.ID_DOMAIN ?? 'id.lcw-sandbox.org',
}
let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${String(detail)})` : ''}`)
  if (!ok) failures++
}

const { session, keys } = await openWithPassphrase({ email, passphrase, config })
const code = await ensureRecoveryCredential({ session, acting: keys.credential, config })
check('a recovery credential is minted and its code stored', typeof code === 'string' && recoverySecretOf(code) !== null, code ? `${code.slice(0, 9)}…` : 'none (already stored)')
if (!code) {
  console.error('A recovery code is already stored for this account; this script needs a freshly registered one.')
  process.exit(1)
}
const again = await ensureRecoveryCredential({ session, acting: keys.credential, config })
check('ensure is idempotent once a code is stored', again === null)

const oldUnlock = await deriveUnlockIdentity({ secret: recoverySecretOf(code)!, kdf: RECOVERY_KDF })
check('the recovery credential opens before use', (await readCredential({ unlock: oldUnlock, serverUrl: config.serverUrl })) !== null)

const recovered = await recoverAccount({ email, code, newPassphrase: passphrase, config })
check('recovery signs in with the new passphrase', recovered.email === email && recovered.did === session.did)
// Removing the used recovery credential rotates the user key the code could reach
check('the recovered session is on a new user key', recovered.userKey.id !== session.userKey.id)
check('the used code no longer opens an account', (await readCredential({ unlock: oldUnlock, serverUrl: config.serverUrl })) === null)
const reopened = await openWithPassphrase({ email, passphrase, config })
check('the passphrase signs in afterwards', reopened.session.did === session.did)
const { asAccount } = await sessionAgents(reopened.session)
const status = await asAccount.zcapClient.request({
  url: `${config.apiBase}/recovery?email=${encodeURIComponent(email)}`,
  method: 'GET',
  action: 'read',
})
check('a replacement recovery code is stored', (status.data as { stored?: boolean }).stored === true)
process.exit(failures ? 1 : 0)
