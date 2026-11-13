import { test, expect, type Page } from '@playwright/test';
import { DEMO_PASSPHRASE, DEPLOYED_URL, addThrough, capture, credentialCard, discardFromTrash, logInWithPasskey, titled, trashCard } from './helpers/lcw';

// The account Space shared with FreeWallet, demonstrated against both
// wallets: FreeWallet opens the demo account this wallet registered with
// the passphrase alone (the same unlock derivation; its login remembers the
// browser, which self-enrolls as a client of the account), lists the
// credential this wallet stored, and adds one that this wallet's replica
// pulls; one added here reaches FreeWallet's replica; then this wallet
// disconnects FreeWallet's client, whose next login is refused.
//
// Opt-in: needs a FreeWallet dev server pointed at the same PWS server
// (`VITE_WAS_SERVER_URL=https://was.lcw-sandbox.org/ pnpm run dev` in a
// FreeWallet checkout; the remember-this-browser seam its own tests use is a
// dev-build feature) and the deployed wallet.
//
//   FREEWALLET_URL=http://localhost:5174 DEPLOYED_URL=https://lcw-sandbox.org npx playwright test tests/freewallet.spec.ts
//
// Each run adds one passkey client of this wallet to the demo account and
// rotates its user key once (the disconnect).

const FREEWALLET_URL = (process.env.FREEWALLET_URL ?? '').replace(/\/+$/, '');

test.skip(!FREEWALLET_URL || !DEPLOYED_URL, 'set FREEWALLET_URL and DEPLOYED_URL to run the two-wallet demo');

// FreeWallet's login: the passphrase alone. The dev build's test seam makes
// the login remember the browser, as FreeWallet's own end-to-end tests do
// until its login form offers the choice.
async function logInToFreeWallet(page: Page, { remember }: { remember: boolean }) {
  await page.goto(`${FREEWALLET_URL}/#/login`);
  if (remember) {
    await page.evaluate(() => {
      (window as unknown as { __E2E_REMEMBER_BROWSER__?: boolean }).__E2E_REMEMBER_BROWSER__ = true;
    });
  }
  await page.locator('input[type="password"]').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}

// Adds a credential under the title through FreeWallet's Add Credential
// page (pasted JSON) and its accept step
async function addInFreeWallet(page: Page, title: string) {
  await page.getByRole('link', { name: 'Add Credential' }).click();
  await page.getByPlaceholder('Paste a URL or full credential JSON.').fill((await titled(title)).toString());
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page).toHaveURL(/#\/accept-credentials/);
  await page.getByRole('button', { name: 'Accept all' }).click();
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(page.getByText(title)).toBeVisible({ timeout: 60_000 });
}

// The signing keys of the clients this wallet lists under Connected wallets
async function connectedWalletKeys(lcw: Page): Promise<string[]> {
  const settings = lcw.getByRole('button', { name: 'Settings' });
  if ((await settings.getAttribute('aria-expanded')) !== 'true') {
    await settings.click();
  }
  await lcw.getByRole('link', { name: 'Connected wallets' }).click();
  const cards = lcw.locator('[data-wallet-key]');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  return cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-wallet-key') ?? ''));
}

test('FreeWallet and this wallet share the account Space', async ({ browser }) => {
  test.setTimeout(900_000);
  const stamp = Date.now();
  const fromFreeWallet = `Shared Space test ${stamp} from FreeWallet`;
  const fromHere = `Shared Space test ${stamp} from LCW`;
  const lcwContext = await browser.newContext();
  const freeWalletContext = await browser.newContext();
  const lcw = await lcwContext.newPage();
  const freeWallet = await freeWalletContext.newPage();
  const lcwNoise = capture(lcw);
  const freeWalletNoise = capture(freeWallet);
  try {
    await test.step('this wallet opens the account with a passkey', async () => {
      await logInWithPasskey(lcw);
    });
    const clientsBefore = await connectedWalletKeys(lcw);
    await lcw.getByRole('link', { name: 'My Credentials' }).click();
    await expect(credentialCard(lcw, 'LCW Experience Badge')).toBeVisible();

    await test.step('FreeWallet opens the same account with the passphrase and lists its credential', async () => {
      await logInToFreeWallet(freeWallet, { remember: true });
      await expect(freeWallet).toHaveURL(/#\/dashboard/, { timeout: 180_000 });
      await expect(freeWallet.getByText('LCW Experience Badge')).toBeVisible({ timeout: 120_000 });
    });

    await test.step('a credential added in FreeWallet reaches this wallet', async () => {
      await addInFreeWallet(freeWallet, fromFreeWallet);
      await expect(credentialCard(lcw, fromFreeWallet)).toBeVisible({ timeout: 150_000 });
    });

    await test.step('a credential added here reaches FreeWallet', async () => {
      await addThrough(lcw, fromHere);
      await expect(freeWallet.getByText(fromHere)).toBeVisible({ timeout: 150_000 });
    });

    await test.step('disconnecting FreeWallet here refuses its next login', async () => {
      const clientsAfter = await connectedWalletKeys(lcw);
      const enrolled = clientsAfter.filter((key) => !clientsBefore.includes(key));
      expect(enrolled, 'FreeWallet enrolled one client').toHaveLength(1);
      const card = lcw.locator(`[data-wallet-key="${enrolled[0]}"]`);
      lcw.once('dialog', (dialog) => void dialog.accept());
      await card.getByRole('button', { name: 'Disconnect' }).click();
      await expect(card).toBeHidden({ timeout: 240_000 });
      await logInToFreeWallet(freeWallet, { remember: false });
      await expect(freeWallet.getByRole('alert')).toBeVisible({ timeout: 120_000 });
      expect(freeWallet.url()).not.toMatch(/#\/dashboard/);
    });

    await test.step('both test credentials are removed', async () => {
      await lcw.getByRole('link', { name: 'My Credentials' }).click();
      await trashCard(lcw, fromFreeWallet);
      await trashCard(lcw, fromHere);
      await discardFromTrash(lcw, [fromFreeWallet, fromHere]);
    });
  } finally {
    for (const [label, lines] of [
      ['this wallet', lcwNoise],
      ['FreeWallet', freeWalletNoise],
    ] as const) {
      if (lines.length) {
        console.log(`--- browser noise (${label}) ---\n${lines.join('\n')}`);
      }
    }
    await freeWalletContext.close();
    await lcwContext.close();
  }
});
