import { execFileSync } from 'node:child_process';

// Deletes the account global-setup.ts made: its Spaces on the PWS server
// and its rows on the back end. A Space or a row it could not delete fails
// the run, so that it is seen.
export default function globalTeardown() {
  if (!process.env.DEPLOYED_URL) {
    return;
  }
  if (process.env.KEEP_TEST_ACCOUNT) {
    console.log("the tests' account is kept (KEEP_TEST_ACCOUNT); `npx tsx tests/scripts/test-account.ts delete` deletes it");
    return;
  }
  execFileSync('npx', ['tsx', 'tests/scripts/test-account.ts', 'delete', 'suite'], { stdio: 'inherit' });
}
