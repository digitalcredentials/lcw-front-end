import { test, expect, type Page } from '@playwright/test';

// End-to-end tests against the local stack. Prerequisites:
// - the lcw-back-end sam local API on :3001 (the login endpoint)
// - the was-server-aws sam local API on :3000 (the space)
// - the demo account registered in the wallet-test DynamoDB table, with the
//   LCWExperience and Bachelors credentials in its UniversityOfToronto
//   collection
// The Vite dev server is started automatically (or reused if already up).

const DEMO_EMAIL = 'jc.chartrand@gmail.com';
const DEMO_PASSPHRASE = 'my-secret-seed-that-is-long-enou';

async function logIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function openUniversityCollection(page: Page) {
  await page.getByRole('button', { name: /UniversityOfToronto/ }).click();
}

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill('not the passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
});

test('logs in and lists the space collections', async ({ page }) => {
  await logIn(page);
  await expect(page.getByText('Verifiable Credentials Collection')).toBeVisible();
  await expect(page.getByText('UniversityOfToronto').first()).toBeVisible();
});

test('verifies a clicked credential and highlights its row', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  const row = page.getByRole('row').filter({ hasText: 'LCWExperience' });
  await row.click();

  await expect(page.getByText('Signature is valid.')).toBeVisible();
  await expect(page.getByText('Has not been revoked')).toBeVisible();
  // the credential's own name renders in the verifier
  await expect(page.getByText('LCW Experience Badge').first()).toBeVisible();
  await expect(row).toHaveClass(/bg-indigo-50/);
});

test('shows the verifier only after a credential is selected', async ({ page }) => {
  await logIn(page);
  const verifier = page.locator('section[aria-label="Credential verification"]');

  // not on the collections page…
  await expect(page.getByText('UniversityOfToronto').first()).toBeVisible();
  await expect(verifier).toBeHidden();

  // …not on the collection page before a click…
  await openUniversityCollection(page);
  await expect(page.getByRole('row').filter({ hasText: 'LCWExperience' })).toBeVisible();
  await expect(verifier).toBeHidden();

  // …only once a credential is selected
  await page.getByRole('row').filter({ hasText: 'LCWExperience' }).click();
  await expect(verifier).toBeVisible();

  // and it hides again on leaving the collection
  await page.getByRole('button', { name: 'Collections' }).click();
  await expect(verifier).toBeHidden();
});

test('uploads a credential to the collection', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  // Upload Credential appears only on the collection page
  const upload = page.getByRole('button', { name: 'Upload Credential' });
  await expect(upload).toBeVisible();

  const chooser = page.waitForEvent('filechooser');
  await upload.click();
  await (await chooser).setFiles(
    new URL('./fixtures/PlaywrightUpload.json', import.meta.url).pathname
  );

  // the refreshed list contains the uploaded credential, and it verifies
  const row = page.getByRole('row').filter({ hasText: 'PlaywrightUpload' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText('Signature is valid.')).toBeVisible();
});

test('verifies a second credential after the first', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  const experience = page.getByRole('row').filter({ hasText: 'LCWExperience' });
  await experience.click();
  await expect(page.getByText('LCW Experience Badge').first()).toBeVisible();
  await expect(page.getByText('Signature is valid.')).toBeVisible();

  const bachelors = page.getByRole('row').filter({ hasText: 'Bachelors' });
  await bachelors.click();
  // the verifier re-renders with the second credential's content, and the
  // highlight moves to its row
  await expect(page.getByText('Bachelors in Computer Science').first()).toBeVisible();
  await expect(page.getByText('Signature is valid.')).toBeVisible();
  await expect(bachelors).toHaveClass(/bg-indigo-50/);
  await expect(experience).not.toHaveClass(/bg-indigo-50/);
});
