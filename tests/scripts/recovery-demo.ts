// Exercises account recovery against the deployed back end and PWS server on
// the demo account: issues a recovery code (a standing credential of the
// account, handed to the back end), recovers with that code (setting the
// passphrase to a new value, then back), and checks that a replacement code
// is stored.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/recovery-demo.ts
import '@interop/http-client'
import { changePassphrase, ensureRecoveryCode, listSignInMethods, loginWithPassphrase, loginWithRecoveryCode, requireTransient } from '../../src/lib/identity'

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
const issued = await ensureRecoveryCode({ session, config, force: true })
check('a recovery code is issued and handed to the back end', issued.issued && typeof issued.code === 'string', issued.code ? `${issued.code.slice(0, 9)}…` : 'none')
const listed = await listSignInMethods({ session })
check('the registry lists a recovery code', listed.some((m) => m.kind === 'recovery-code'), listed.map((m) => m.kind).join(', '))

// Recovery: the code opens a transient session; a new passphrase is set
const recovered = await loginWithRecoveryCode({ email, code: issued.code!, config })
check('the code signs in', recovered.did === session.did && recovered.kind === 'transient')
const interim = `${passphrase}-recovered-${Date.now()}`
await changePassphrase({ session: requireTransient(recovered), passphrase: interim })
const reopened = await loginWithPassphrase({ email, passphrase: interim, config })
check('the new passphrase signs in', reopened.did === session.did)
// ... and back to the demo passphrase, which stays a credential of the account
check('the previous passphrase still signs in (its credential is not removed)', (await loginWithPassphrase({ email, passphrase, config })).did === session.did)
const replacement = await ensureRecoveryCode({ session: reopened, config, force: true })
check('a replacement code is issued', replacement.issued && replacement.code !== issued.code)
const status = await fetch(`${config.apiBase}/recovery?email=${encodeURIComponent(email)}`).then((res) => res.json() as Promise<{ stored?: boolean }>)
check('the back end holds a recovery code', status.stored === true)
process.exit(failures ? 1 : 0)
