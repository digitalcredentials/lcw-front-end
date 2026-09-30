import { test, expect, type Page } from '@playwright/test';

// Smoke tests against a deployed instance. Opt-in: they run only when
// DEPLOYED_URL is set, so the regular local suite never touches production.
//
//   DEPLOYED_URL=https://lcw-sandbox.org npx playwright test tests/deployed.spec.ts
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
    // The header is the static product title now, not the space's name
    await expect(page.getByText('Digital Credentials Commons')).toBeVisible();
    await expect(page.getByText('Learner Credential Wallet').first()).toBeVisible();
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
    // Open replaces the per-row Verify/View Source/Share/Delete buttons: the
    // detail view shows the summary, source, and verification side by side
    // Cards no longer show file names; the card carries its resource id
    await page.locator('[data-resource-id*="LCWExperience"]')
      .getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('Credential Source')).toBeVisible();
    await expect(page.getByText('Signature is valid.')).toBeVisible();
    await expect(page.getByText('Has not been revoked')).toBeVisible();
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});

test('opens the batch issuer screen', async ({ page }) => {
  const noise = capture(page);
  await logIn(page);
  try {
    await page.getByRole('link', { name: 'Batch issuer' }).click();
    // The panel is a linked (file:) package; if the bundle picks up its own
    // React copy the screen white-screens with an invalid-hook TypeError, so
    // assert both the render and the absence of page errors.
    await expect(page.getByRole('heading', { name: 'Credential batches' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New batch' })).toBeVisible();
    const pageErrors = noise.filter((line) => line.startsWith('[pageerror]'));
    expect(pageErrors).toEqual([]);
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});

test('shares a credential to LinkedIn', async ({ page }) => {
  const noise = capture(page);
  await logIn(page);
  try {
    await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
    // Sharing now goes through the credential detail view's bottom buttons
    // Cards no longer show file names; the card carries its resource id
    await page.locator('[data-resource-id*="LCWExperience"]')
      .getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    // Record the URL at the moment the page calls window.open, instead of
    // opening a real popup: reading popup.url() after waitForEvent('page')
    // races LinkedIn's redirect to its login wall and fails intermittently.
    await page.evaluate(() => {
      (window as unknown as { __openedUrl?: string }).__openedUrl = undefined;
      window.open = ((url: string | URL) => {
        (window as unknown as { __openedUrl?: string }).__openedUrl = String(url);
        return null;
      }) as typeof window.open;
    });
    await page.getByRole('button', { name: 'Add to LinkedIn' }).click();
    // The confirm step; its button carries the same label as the opener.
    await page.getByRole('dialog').getByRole('button', { name: 'Add to LinkedIn' }).last().click();
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __openedUrl?: string }).__openedUrl))
      .toBeTruthy();
    const opened = await page.evaluate(() => (window as unknown as { __openedUrl?: string }).__openedUrl);
    const url = new URL(opened!);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.linkedin.com/profile/add');
    expect(url.searchParams.get('startTask')).toBe('CERTIFICATION_NAME');
    expect(url.searchParams.get('name')).toBeTruthy();
    expect(url.searchParams.get('certUrl')).toContain('verifierplus.org');
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});
