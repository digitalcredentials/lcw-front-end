import { test, expect, type Page } from '@playwright/test';

// Smoke tests against a deployed instance. Opt-in: they run only when
// DEPLOYED_URL is set, so the regular local suite never touches production.
//
//   DEPLOYED_URL=https://lcw-sandbox.org npx playwright test tests/deployed.spec.ts
//
// They use the deployed demo account, seeded by tests/scripts/seed-demo.mjs
// (a UniversityOfToronto collection holding the LCW Experience Badge), and
// only read it -- the batch test creates and deletes a space of its own.

const DEPLOYED_URL = process.env.DEPLOYED_URL ?? '';
const DEMO_EMAIL = 'jc.chartrand@gmail.com';
const DEMO_PASSPHRASE = 'my-secret-seed-that-is-long-enou';

test.skip(!DEPLOYED_URL, 'set DEPLOYED_URL to run the deployed smoke tests');

// Signing in on a browser with passkey support offers to add a passkey
// before continuing; the suite signs in with the passphrase alone, so the
// offer is marked dismissed for the demo account, as "Not now" does.
test.beforeEach(async ({ page }) => {
  await page.addInitScript((email) => {
    localStorage.setItem(`lcw_passkey_offer_dismissed:${email.toLowerCase()}`, 'true');
  }, DEMO_EMAIL);
});

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

// A credential card, found by its title: resource ids in an encrypted
// collection are opaque, so the card's text is what identifies it.
function credentialCard(page: Page, title: string) {
  return page.locator('[data-resource-id]').filter({ hasText: title });
}

async function logIn(page: Page) {
  // The test browser never has the CHAPI wallet enabled, so suppress the
  // enable-browser-wallet prompt (same flag its "Not now" button sets) or its
  // overlay would intercept the tests' clicks.
  await page.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
  await page.goto(`${DEPLOYED_URL}/`);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
    // The sidebar names the signed-in account
    await expect(page.getByTestId('signed-in-as')).toContainText(DEMO_EMAIL);
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
    await credentialCard(page, 'LCW Experience Badge')
      .getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('Credential Source')).toBeVisible();
    // The verifier-plugin card: the verdict and the Tampering row of its
    // Details view. The demo issuer is on none of DCC's known registries that
    // a browser can read, and four on the list can't be read from a browser
    // at all, so "We couldn't confirm who issued this" is expected; the other
    // two are what it would say were those readable ("Genuine, but…") or the
    // issuer listed ("Verified"). The headline carries a visually hidden
    // severity prefix, so match the sentence, not the whole text.
    await expect(page.getByText(/We couldn't confirm who issued this|Genuine, but we can't confirm who issued it|Verified/).first())
      .toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Tampering')).toBeVisible();
    await expect(page.getByText('none detected')).toBeVisible();
    // The list itself loaded: whichever verdict, it isn't the one for a list
    // that never arrived.
    await expect(page.getByText(/list of known issuers didn't load/)).toHaveCount(0);
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
    await credentialCard(page, 'LCW Experience Badge')
      .getByRole('button', { name: 'Open' }).click();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const modal = page.getByRole('dialog', { name: /^Share / });
    await expect(modal).toBeVisible();
    // The dialog first finds out who can see the credential
    await expect(modal.getByRole('group', { name: 'Who can see it' })).toHaveAttribute('aria-busy', 'false');
    // Record the URL at the moment the page calls window.open, instead of
    // opening a real popup: reading popup.url() after waitForEvent('page')
    // races LinkedIn's redirect to its login wall and fails intermittently.
    // The dialog opens a blank tab in the click and points it at the form
    // once the link exists; with the stub returning null it treats the tab
    // as blocked and opens the form URL itself, which the stub records.
    await page.evaluate(() => {
      (window as unknown as { __openedUrl?: string }).__openedUrl = undefined;
      window.open = ((url?: string | URL) => {
        if (url && String(url) !== '') {
          (window as unknown as { __openedUrl?: string }).__openedUrl = String(url);
        }
        return null;
      }) as typeof window.open;
    });
    await modal.getByRole('button', { name: 'LinkedIn' }).click();
    // While the credential is private the dialog asks before switching it to
    // Anyone with the link; once shared (as it stays between runs) it opens
    // the form at once. A nameless issuer would add one more question.
    for (const name of ['Switch and continue', 'Continue to LinkedIn']) {
      const button = modal.getByRole('button', { name });
      await button.waitFor({ state: 'visible', timeout: 3000 }).then(() => button.click(), () => undefined);
    }
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __openedUrl?: string }).__openedUrl))
      .toBeTruthy();
    const opened = await page.evaluate(() => (window as unknown as { __openedUrl?: string }).__openedUrl);
    const url = new URL(opened!);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.linkedin.com/profile/add');
    expect(url.searchParams.get('startTask')).toBe('CERTIFICATION_NAME');
    expect(url.searchParams.get('name')).toBeTruthy();
    expect(url.searchParams.get('certUrl')).toContain('verifierplus.org');
    // The seeded credential carries an id short enough for LinkedIn's field,
    // so it reaches the form as the certification id.
    expect(url.searchParams.get('certId')).toBeTruthy();
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
    await credentialCard(page, 'LCW Experience Badge')
      .getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText('Credential Source')).toBeVisible();

    // At laptop width the links show in the sidebar, with no phone Menu button
    await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();

    // The sidebar nav link resets to the spaces cards
    await page.getByRole('link', { name: 'My Spaces' }).click();
    await expect(page.locator('[data-space-type]').first()).toBeVisible();

    // Back into the detail view, then the wallet title resets too
    await page.locator('[data-space-type="credential"]').first().click();
    await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
    await credentialCard(page, 'LCW Experience Badge')
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
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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

test('creates, saves, and deletes a batch', async ({ page }) => {
  const noise = capture(page);
  await page.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
  await page.goto(`${DEPLOYED_URL}/`);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  try {
    await page.getByRole('link', { name: 'Credential issuer' }).click();
    await page.getByRole('button', { name: 'New batch' }).click();

    // Saving creates the batch's own space and writes batch.json into its
    // fresh (description-less) batch collection — the path that broke when
    // the client became encryption-capable.
    const name = `Deployed test batch ${Date.now()}`;
    await page.getByLabel('Batch name').fill(name);
    await page.getByRole('button', { name: 'Save batch' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 20000 });

    // Delete the batch (its whole space); confirm() is a browser dialog
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Credential batches' })).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(name)).toBeHidden();
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});

test('lists the sign-in credentials under Settings', async ({ page }) => {
  const noise = capture(page);
  await logIn(page);
  try {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('link', { name: 'Sign-in credentials' }).click();
    // The demo account signed in with its password, so that credential is
    // listed as the session's and cannot be removed from it
    const current = page.locator('[data-credential-current="true"]');
    await expect(current).toBeVisible();
    await expect(current).toContainText('Password');
    await expect(current).toContainText('This session');
    await expect(current.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});

test('stays signed in on this browser until sign-out', async ({ page, context }) => {
  const noise = capture(page);
  try {
    await page.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
    await page.goto(`${DEPLOYED_URL}/`);
    await page.getByLabel('Email').fill(DEMO_EMAIL);
    await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
    await page.getByLabel('Stay signed in on this browser').check();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('[data-space-type]').first()).toBeVisible();
    // The browser credential is made in the background after sign-in
    await expect.poll(() => page.evaluate(() => localStorage.getItem('lcw_browser_credential')), { timeout: 30_000 }).toBeTruthy();

    // A second tab has no session of its own; the browser credential opens
    // the account without the login form
    const second = await context.newPage();
    await second.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
    await second.goto(`${DEPLOYED_URL}/#/files`);
    await expect(second.locator('[data-space-type]').first()).toBeVisible();
    await expect(second.getByTestId('signed-in-as')).toContainText(DEMO_EMAIL);
    await second.close();

    // Sign Out forgets the browser credential: a fresh tab asks for a password
    await page.getByRole('button', { name: 'Sign Out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    const third = await context.newPage();
    await third.goto(`${DEPLOYED_URL}/#/files`);
    await expect(third.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await third.close();
  } finally {
    if (noise.length) {
      console.log(`--- browser noise ---\n${noise.join('\n')}`);
    }
  }
});

// A phone (#177): the page fits the screen, and the sidebar's links fold away
// behind a Menu button that folds them away again once one is followed
test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('fits the screen, with the links behind Menu', async ({ page }) => {
    await logIn(page);
    await expect(page.getByRole('button', { name: /UniversityOfToronto/ })).toBeVisible();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await fits()).toBe(true);
    // The title bar spans the screen, not the laptop sidebar's 240px
    expect((await page.locator('aside').boundingBox())?.width).toBe(375);

    // An icon rather than a word, in a 44px tap target: three lines while
    // folded, an X while open
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toHaveText('');
    const box = await menu.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await expect(menu.locator('svg')).toBeVisible();
    await expect(menu.locator('path')).not.toHaveCSS('stroke', 'none');
    const icon = () => menu.locator('path').getAttribute('d');
    const folded = await icon();
    // Screen readers hear the same name, "Menu", with collapsed or expanded
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'My Spaces' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sign Out' })).toBeHidden();
    await menu.click();
    await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(await icon()).not.toBe(folded);
    await page.getByRole('link', { name: 'My Spaces' }).click();
    await expect(page.locator('[data-space-type]').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'My Spaces' })).toBeHidden();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(await icon()).toBe(folded);
    expect(await fits()).toBe(true);
  });
});
