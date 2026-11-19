import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The tests against a deployed wallet (those that need DEPLOYED_URL) run on
// an account of their own, made here before the first test and deleted in
// global-teardown.ts after the last: nothing is kept between runs. The
// account is made by a process of its own (tests/scripts/test-account.ts),
// and the tests read its email and passphrase from the environment
// (tests/helpers/lcw.ts).
//
// KEEP_TEST_ACCOUNT=1 leaves the account in place afterwards and takes it
// up again on the next run, for going over one test repeatedly.
export default function globalSetup() {
  if (!process.env.DEPLOYED_URL) {
    return;
  }
  const recorded = () => {
    try {
      return JSON.parse(readFileSync(new URL('./.test-account.suite.json', import.meta.url), 'utf8')) as { email: string; passphrase: string; spaceId?: string };
    } catch {
      return null;
    }
  };
  let account = process.env.KEEP_TEST_ACCOUNT ? recorded() : null;
  if (!account?.spaceId) {
    execFileSync('npx', ['tsx', 'tests/scripts/test-account.ts', 'create', 'suite'], { stdio: 'inherit' });
    account = recorded();
  } else {
    console.log(`using the account kept from an earlier run (${account.email})`);
  }
  if (!account) {
    throw new Error("The tests' account was not created.");
  }
  process.env.TEST_ACCOUNT_EMAIL = account.email;
  process.env.TEST_ACCOUNT_PASSPHRASE = account.passphrase;
}
