// The account the browser tests against a deployed wallet run on, made and
// deleted from the shell (tests/helpers/testAccount.ts). Playwright's global
// setup and teardown run `create` and `delete` (playwright.config.ts): this
// is a process of its own because Playwright's module loader cannot load
// the identity layer's dependency graph, and tsx can.
//
//   REGISTRATION_CODE=... npx tsx tests/scripts/test-account.ts create [name]
//   npx tsx tests/scripts/test-account.ts delete [name]
//   npx tsx tests/scripts/test-account.ts show [name]
//
// `name` tells one user of the helper from another (default `suite`, the
// browser tests'). `create` first deletes whatever an earlier run under the
// name left behind. Both need AWS access to the deployment.
import '@interop/http-client'
import { createTestAccount, deleteTestAccount, recordedAccount } from '../helpers/testAccount'

const [command, name = 'suite'] = process.argv.slice(2)

if (command === 'create') {
  const account = await createTestAccount({ name })
  console.log(`created ${account.email}`)
} else if (command === 'delete') {
  const report = await deleteTestAccount({ name })
  // A Space or a row left behind fails the run that made it, so it is seen
  process.exit(report.left.length ? 1 : 0)
} else if (command === 'show') {
  const account = recordedAccount(name)
  console.log(account ? `${account.email} (Space ${account.spaceId ?? 'not created yet'})` : 'no account is recorded')
} else {
  console.error('Usage: test-account.ts create|delete|show [name]')
  process.exit(2)
}
// The identity layer leaves timers running
process.exit(0)
