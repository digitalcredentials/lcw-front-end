import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// What the tests against a deployed wallet share: the demo account, the
// sign-ins, and the credential list's controls.

export const DEPLOYED_URL = (process.env.DEPLOYED_URL ?? '').replace(/\/+$/, '');
export const DEMO_EMAIL = 'jc.chartrand@gmail.com';
export const DEMO_PASSPHRASE = 'my-secret-seed-that-is-long-enou';

// Surface everything the browser complains about: console errors, page
// errors, and requests that fail or come back >= 400.
export function capture(page: Page): string[] {
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

// A credential card, found by its title: credential ids are opaque content
// ids, so the card's text is what identifies it.
export function credentialCard(page: Page, title: string) {
  return page.locator('[data-credential-id]').filter({ hasText: title });
}

export async function logIn(page: Page) {
  // The test browser never has the CHAPI wallet enabled, so suppress the
  // enable-browser-wallet prompt (same flag its "Not now" button sets) or its
  // overlay would intercept the tests' clicks. A password sign-in offers a
  // passkey once per account on a browser with WebAuthn; the offer is
  // dismissed up front the way its "Not now" button does.
  await page.addInitScript((email) => {
    sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true');
    localStorage.setItem(`lcw_passkey_offer_dismissed:${email}`, 'true');
  }, DEMO_EMAIL);
  await page.goto(`${DEPLOYED_URL}/`);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Login lands on the credentials list. Signing in runs the account's
  // ceremonies against the live server and back end, which take longer
  // than the default expectation allows right after a deploy.
  await expect(page.getByRole('heading', { name: 'My Credentials' })).toBeVisible({ timeout: 60_000 });
}

// A virtual authenticator with the PRF extension, so a passkey can be
// registered and asserted without a device. Chromium only.
export async function virtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
}

// Signs in with the password and adds a passkey in the offer step, which
// continues the session as a remembered client: what managing spaces (the
// batch tests) and staying signed in need.
export async function logInWithPasskey(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
  await virtualAuthenticator(page);
  await page.goto(`${DEPLOYED_URL}/`);
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'My Credentials' })).toBeVisible({ timeout: 60_000 });
}

// The badge credential (the one inside the fixture's presentation) under
// another title: its own name and its achievement's, which the card shows
export async function titled(title: string): Promise<Buffer> {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/PlaywrightUpload.json', import.meta.url), 'utf8'));
  const credential = fixture.verifiableCredential[0];
  credential.name = title;
  credential.credentialSubject.achievement.name = title;
  return Buffer.from(JSON.stringify(credential));
}

// Adds a credential under the title through the Add Credential dialog's
// file input, and waits for its card
export async function addThrough(tab: Page, title: string) {
  await tab.getByRole('button', { name: 'Add Credential' }).click();
  const dialog = tab.getByRole('dialog', { name: 'Add Credential' });
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'replica-test.json', mimeType: 'application/json', buffer: await titled(title) });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(credentialCard(tab, title)).toBeVisible();
}

// Whether a list read afresh from the Space shows the title: leaving the
// list and coming back mounts the page again, which reads the Space
export async function listedAfresh(tab: Page, title: string): Promise<boolean> {
  await tab.goto(`${DEPLOYED_URL}/#/settings/credentials`);
  await tab.goto(`${DEPLOYED_URL}/#/files`);
  await expect(credentialCard(tab, 'LCW Experience Badge')).toBeVisible({ timeout: 30_000 });
  return (await credentialCard(tab, title).count()) > 0;
}

export async function confirmDelete(tab: Page) {
  const dialog = tab.getByRole('dialog', { name: 'Delete Credential' });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

// Moves the credential to Trash from its detail view
export async function trashCard(tab: Page, title: string) {
  await credentialCard(tab, title).getByRole('button', { name: 'Open' }).click();
  await tab.getByRole('button', { name: 'Delete', exact: true }).click();
  await confirmDelete(tab);
  await expect(credentialCard(tab, title)).toBeHidden();
}

// Deletes the titles for good from the Trash view
export async function discardFromTrash(tab: Page, titles: string[]) {
  await tab.getByRole('button', { name: /^Trash \(\d+\)$/ }).click();
  for (const title of titles) {
    await credentialCard(tab, title).getByRole('button', { name: 'Delete', exact: true }).click();
    await confirmDelete(tab);
    await expect(credentialCard(tab, title)).toBeHidden();
  }
}
