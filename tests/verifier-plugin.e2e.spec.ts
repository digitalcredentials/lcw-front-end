import { test, expect, type Page } from '@playwright/test';

// The verifier-plugin card in the credential detail view, end to end against
// the local stack (prerequisites as for tests/e2e.spec.ts): the lcw-back-end
// sam local API on :3001,
// was-server-aws on :3000, and the demo account with the LCWExperience and
// Bachelors credentials in its UniversityOfToronto collection.
//
// Registry lookups go to the real DCC known-registries list, so this needs
// the network as well.

const DEMO_EMAIL = 'jc.chartrand@gmail.com';
const DEMO_PASSPHRASE = 'my-secret-seed-that-is-long-enou';

async function logIn(page: Page) {
  // The browser-wallet prompt covers the page whenever it lands, in a test
  // browser where the wallet is never enabled
  await page.addLocatorHandler(
    page.getByRole('dialog', { name: 'Enable Browser Wallet' }),
    () => page.getByRole('button', { name: 'Not now' }).click()
  );
  await page.goto('/');
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The demo space's name differs between how main seeds it and how
  // registration names spaces now
  await page.getByRole('button', { name: /Verifiable Credentials Collection|'s Space/ }).first().click();
}

const verifier = (page: Page) => page.locator('section[aria-label="Credential verification"]');

/** The card's text once its check has finished, and how many checks ran. */
async function cardOnceChecked(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __checked?: number }).__checked, null, { timeout: 45_000 });
  // Long enough for a second, unwanted check to have started
  await page.waitForTimeout(1_000);
  return {
    checks: await page.evaluate(() => (window as unknown as { __started: number }).__started),
    text: await verifier(page)
      .locator('verifier-credential')
      .evaluate((el) => el.shadowRoot?.querySelector('.card')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __started: number; __checked: number };
    w.__started = 0;
    w.__checked = 0;
    document.addEventListener('verification-started', () => w.__started++);
    document.addEventListener('verification-complete', () => w.__checked++);
    document.addEventListener('verification-failed', () => w.__checked++);
  });
});

test('verifier-plugin checks a credential opened from a collection', async ({ page }) => {
  await logIn(page);
  await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
  // Cards carry their resource id
  await page.locator('[data-resource-id*="LCWExperience"]').getByRole('button', { name: 'Open', exact: true }).click();

  const card = await cardOnceChecked(page);
  expect(card.text).toContain('LCW Experience Badge');
  expect(card.text).toContain('Verified');
  expect(card.checks).toBe(1);
});

test('the verifier shows only in the credential detail view', async ({ page }) => {
  await logIn(page);

  // not in the space…
  await expect(page.getByRole('button', { name: /UniversityOfToronto/ })).toBeVisible();
  await expect(verifier(page)).toBeHidden();

  // …not in the collection before a credential is opened…
  await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
  await expect(page.getByRole('button', { name: 'Open', exact: true }).first()).toBeVisible();
  await expect(verifier(page)).toBeHidden();

  // …only once one is
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(verifier(page)).toBeVisible();
  await cardOnceChecked(page);

  // and it hides again on going back, with one card throughout
  await page.getByRole('button', { name: 'Back to list' }).click();
  await expect(verifier(page)).toBeHidden();
  await expect(page.locator('verifier-credential')).toHaveCount(1);
});
