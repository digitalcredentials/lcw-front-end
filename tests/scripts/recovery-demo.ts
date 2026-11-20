// Exercises account recovery against the deployed back end and PWS server, on
// an account the run makes and deletes (tests/helpers/testAccount.ts): issues
// a recovery code (a standing credential of the account, handed to the back
// end; first as a replacement interrupted before the earlier code is
// retired), recovers with that code under an interim passphrase (which retires
// the first passphrase's credential and the used code, and stores a
// replacement code), then sets the first passphrase back (which retires the
// interim one). Each retirement rotates the user key.
//
//   REGISTRATION_CODE=... npx tsx tests/scripts/recovery-demo.ts
import '@interop/http-client'
import { ensureRecoveryCode, hasStoredRecoveryCode, listSignInMethods, loginWithPassphrase, loginWithRecoveryCode, recoverAccount, replacePassphrase, replaceRecoveryCode } from '../../src/lib/identity'
import { recordPassphrase, withTestAccount } from '../helpers/testAccount'

let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` (${String(detail)})` : ''}`)
  if (!ok) failures++
}
// How a sign-in attempt ends: its HTTP status, or its message
const attempt = (run: () => Promise<unknown>) => run().then(() => 'signed in', (err: { status?: number; message?: string }) => err.status ?? err.message ?? String(err))

await withTestAccount('recovery', async ({ email, passphrase, config }) => {
  // A fresh code, every code listed before it retired (the one the account
  // was given when it was made), so the account carries one code
  // First, a replacement interrupted after its new code is handed to the
  // back end and before the earlier code is retired (the replacement's first
  // step alone): the stored code is the new one and it opens the account
  const starting = await loginWithPassphrase({ email, passphrase, config })
  const halfway = await ensureRecoveryCode({ session: starting, config, force: true })
  const listedHalfway = await listSignInMethods({ session: starting })
  check('an interrupted replacement leaves the earlier code listed beside the new one', listedHalfway.filter((m) => m.kind === 'recovery-code').length === 2, listedHalfway.map((m) => m.kind).join(', '))
  const opened = await attempt(() => loginWithRecoveryCode({ email, code: halfway.code!, config }))
  check('the code the back end holds after the interruption opens the account', opened === 'signed in', opened)
  // The complete replacement: both of those codes are retired
  const first = await loginWithPassphrase({ email, passphrase, config })
  const issued = await replaceRecoveryCode({ session: first, config })
  const session = issued.session
  check('a recovery code is issued and handed to the back end', typeof issued.code === 'string', issued.code ? `${issued.code.slice(0, 9)}…` : 'none')
  const listed = await listSignInMethods({ session })
  check('the registry lists one recovery code', listed.filter((m) => m.kind === 'recovery-code').length === 1, listed.map((m) => m.kind).join(', '))

  // Recovery: the code opens the account, an interim passphrase replaces the
  // first one, the used code is retired and a replacement stored
  const interim = `${passphrase}-recovered-${Date.now()}`
  const recovered = await recoverAccount({ email, code: issued.code!, passphrase: interim, config })
  // What opens the account now, should the run end here: the account is
  // deleted with the passphrase on record
  recordPassphrase('recovery', interim)
  check('recovery signs in on the new passphrase', recovered.did === session.did && recovered.kind === 'transient' && recovered.unlockSpaceId !== session.unlockSpaceId)
  check('recovery rotated the user key', recovered.userKey.id !== session.userKey.id)
  const reopened = await loginWithPassphrase({ email, passphrase: interim, config })
  check('the new passphrase signs in', reopened.did === session.did)
  // A retired credential's unlock Space is deleted with it, so it finds no
  // record: invalid credentials (401)
  const previous = await attempt(() => loginWithPassphrase({ email, passphrase, config }))
  check('the previous passphrase no longer signs in', previous === 401, previous)
  const spent = await attempt(() => loginWithRecoveryCode({ email, code: issued.code!, config }))
  check('the used recovery code no longer signs in', spent === 401, spent)
  check('the back end holds a replacement code', await hasStoredRecoveryCode({ session: reopened, config }))
  const afterRecovery = await listSignInMethods({ session: reopened })
  check('the registry lists one passphrase and one recovery code', afterRecovery.map((m) => m.kind).sort().join(',') === 'passphrase,recovery-code', afterRecovery.map((m) => m.kind).join(', '))

  // ... and the passphrase is set back to the first one, which retires the
  // interim credential
  const restored = await replacePassphrase({ session: reopened, passphrase, config })
  recordPassphrase('recovery', passphrase)
  check('the first passphrase signs in again', restored.did === session.did && restored.kind === 'transient')
  const interimAfter = await attempt(() => loginWithPassphrase({ email, passphrase: interim, config }))
  check('the interim passphrase no longer signs in', interimAfter === 401, interimAfter)
  const listedAfter = await listSignInMethods({ session: restored })
  check('the first passphrase is the listed passphrase again', listedAfter.find((m) => m.kind === 'passphrase')?.current === true)
})
process.exit(failures ? 1 : 0)
