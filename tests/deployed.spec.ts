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
  // The test browser never has the CHAPI wallet enabled, so suppress the
  // enable-browser-wallet prompt (same flag its "Not now" button sets) or its
  // overlay would intercept the tests' clicks.
  await page.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
  await page.goto(`${DEPLOYED_URL}/`);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Login lands on the spaces card view; every test works inside the demo
  // account's credential space (a batch space's card opens a batch-view or
  // space-view prompt instead of the space)
  await page.locator('[data-space-type="credential"]').first().click();
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
    await page.getByRole('link', { name: 'Credential issuer' }).click();
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

test('My Spaces and the title link back to the spaces view', async ({ page }) => {
  const noise = capture(page);
  await logIn(page);
  try {
    // Deep into a credential's detail view
    await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
    await page.locator('[data-resource-id*="LCWExperience"]')
      .getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('Credential Source')).toBeVisible();

    // The sidebar nav link resets to the spaces cards
    await page.getByRole('link', { name: 'My Spaces' }).click();
    await expect(page.locator('[data-space-type]').first()).toBeVisible();

    // Back into the detail view, then the wallet title resets too
    await page.locator('[data-space-type="credential"]').first().click();
    await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
    await page.locator('[data-resource-id*="LCWExperience"]')
      .getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('Credential Source')).toBeVisible();
    await page.getByRole('link', { name: /Digital Credentials Commons/ }).click();
    await expect(page.locator('[data-space-type]').first()).toBeVisible();
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});

test('offers the welcome credential on first open after registration', async ({ page }) => {
  const noise = capture(page);
  // Simulate this browser having just registered the demo account
  await page.addInitScript((email) => {
    sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true');
    localStorage.setItem('lcw_welcome_pending', email);
  }, DEMO_EMAIL);
  await page.goto(`${DEPLOYED_URL}/`);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  try {
    // The offer, with the name that goes on the credential
    const dialog = page.getByRole('dialog', { name: 'Welcome Credential' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill('Deployed Test');
    await dialog.getByRole('button', { name: 'Issue my credential' }).click();

    // The CHAPI step explains receiving credentials from other issuers.
    // Stop here: going further would send a real email.
    await expect(dialog.getByText(/credentials from other issuers/)).toBeVisible();

    // The offer is still pending after a reload (nothing sent, nothing cleared)
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Welcome Credential' })).toBeVisible();

    // Declining clears it and the wallet is usable
    await page.getByRole('button', { name: 'No thanks' }).click();
    await expect(page.getByRole('dialog', { name: 'Welcome Credential' })).toBeHidden();
    await expect(page.locator('[data-space-type]').first()).toBeVisible();
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});
