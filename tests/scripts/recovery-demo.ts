// Exercises account recovery against the deployed back end and PWS server on
// the demo account: issues a recovery code (a standing credential of the
// account, handed to the back end), recovers with that code under an interim
// passphrase (which retires the demo passphrase's credential and the used
// code, and stores a replacement code), then sets the demo passphrase back
// (which retires the interim one). Each retirement rotates the user key.
//
//   DEMO_EMAIL=jc.chartrand@gmail.com npx tsx tests/scripts/recovery-demo.ts
import '@interop/http-client'
import { ensureRecoveryCode, hasStoredRecoveryCode, listSignInMethods, loginWithPassphrase, loginWithRecoveryCode, recoverAccount, replacePassphrase } from '../../src/lib/identity'

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
// How a sign-in attempt ends: its HTTP status, or its message
const attempt = (run: () => Promise<unknown>) => run().then(() => 'signed in', (err: { status?: number; message?: string }) => err.status ?? err.message ?? String(err))

const session = await loginWithPassphrase({ email, passphrase, config })
const issued = await ensureRecoveryCode({ session, config, force: true })
check('a recovery code is issued and handed to the back end', issued.issued && typeof issued.code === 'string', issued.code ? `${issued.code.slice(0, 9)}…` : 'none')
const listed = await listSignInMethods({ session })
check('the registry lists a recovery code', listed.some((m) => m.kind === 'recovery-code'), listed.map((m) => m.kind).join(', '))

// Recovery: the code opens the account, an interim passphrase replaces the
// demo one, the used code is retired and a replacement stored
const interim = `${passphrase}-recovered-${Date.now()}`
const recovered = await recoverAccount({ email, code: issued.code!, passphrase: interim, config })
check('recovery signs in on the new passphrase', recovered.did === session.did && recovered.kind === 'transient' && recovered.unlockSpaceId !== session.unlockSpaceId)
check('recovery rotated the user key', recovered.userKey.id !== session.userKey.id)
const reopened = await loginWithPassphrase({ email, passphrase: interim, config })
check('the new passphrase signs in', reopened.did === session.did)
// A retired credential finds no record once its unlock Space is deleted
// (401), and is refused as no longer standing while this server leaves the
// Space behind (its Delete Space is root-only)
const previous = await attempt(() => loginWithPassphrase({ email, passphrase, config }))
check('the previous passphrase no longer signs in', previous !== 'signed in', previous)
const spent = await attempt(() => loginWithRecoveryCode({ email, code: issued.code!, config }))
check('the used recovery code no longer signs in', spent !== 'signed in', spent)
check('the back end holds a replacement code', await hasStoredRecoveryCode({ session: reopened, config }))
const afterRecovery = await listSignInMethods({ session: reopened })
check('the registry lists one passphrase and one recovery code', afterRecovery.map((m) => m.kind).sort().join(',') === 'passphrase,recovery-code', afterRecovery.map((m) => m.kind).join(', '))

// ... and the passphrase is set back to the demo one, which retires the
// interim credential
const restored = await replacePassphrase({ session: reopened, passphrase, config })
check('the demo passphrase signs in again', restored.did === session.did && restored.kind === 'transient')
const interimAfter = await attempt(() => loginWithPassphrase({ email, passphrase: interim, config }))
check('the interim passphrase no longer signs in', interimAfter !== 'signed in', interimAfter)
const listedAfter = await listSignInMethods({ session: restored })
check('the demo passphrase is the listed passphrase again', listedAfter.find((m) => m.kind === 'passphrase')?.current === true)
process.exit(failures ? 1 : 0)
