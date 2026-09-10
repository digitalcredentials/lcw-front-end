import { test, expect, type Page } from '@playwright/test';

// Smoke tests against a deployed instance. Opt-in: they run only when
// DEPLOYED_URL is set, so the regular local suite never touches production.
//
//   DEPLOYED_URL=https://dk59u8ewdxjcs.cloudfront.net npx playwright test tests/deployed.spec.ts
//
// They use the deployed demo account (its registered spaceURL points at the
// deployed WAS API) and only read -- no uploads or deletes against the real
// space.

const DEPLOYED_URL = process.env.DEPLOYED_URL ?? '';
const DEMO_EMAIL = 'jc.chartrand+aws@gmail.com';
const DEMO_PASSPHRASE = 'my-secret-seed-that-is-long-enou';

test.skip(!DEPLOYED_URL, 'set DEPLOYED_URL to run the deployed smoke tests');

// Surface everything the browser complains about: console errors, page
// errors, and requests that fail or come back >= 400.
function capture(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      lines.push(`[console.${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => lines.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', (req) =>
    lines.push(`[requestfailed] ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`)
  );
  page.on('response', (res) => {
    if (res.status() >= 400) {
      lines.push(`[response ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });
  return lines;
}

async function logIn(page: Page) {
  await page.goto(`${DEPLOYED_URL}/`);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('logs in and lists the space collections', async ({ page }) => {
  const noise = capture(page);
  await logIn(page);
  try {
    await expect(page.getByText('Verifiable Credentials Collection')).toBeVisible();
    await expect(page.getByText('UniversityOfToronto').first()).toBeVisible();
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});

test('verifies a credential from the deployed space', async ({ page }) => {
  const noise = capture(page);
  await logIn(page);
  try {
    await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
    await page.getByRole('row').filter({ hasText: 'LCWExperience' })
      .getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByText('Signature is valid.')).toBeVisible();
    await expect(page.getByText('Has not been revoked')).toBeVisible();
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});
