import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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

const FIXTURE_PATH = new URL('./fixtures/PlaywrightUpload.json', import.meta.url).pathname;

async function openUploadModal(page: Page) {
  // Upload Credential appears only on the collection page
  await page.getByRole('button', { name: 'Upload Credential' }).click();
  return page.getByRole('dialog', { name: 'Upload Credential' });
}

test('uploads a credential from a picked file', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);
  const modal = await openUploadModal(page);

  const chooser = page.waitForEvent('filechooser');
  await modal.getByRole('button', { name: 'Choose File' }).click();
  await (await chooser).setFiles(FIXTURE_PATH);

  // picking a file stages it: the name field takes the file's name (still
  // editable) and the JSON fills the editor
  await expect(modal.getByLabel('Name')).toHaveValue('PlaywrightUpload.json');
  await expect(modal.locator('.cm-content')).toContainText('VerifiablePresentation');
  await modal.getByRole('button', { name: 'Upload', exact: true }).click();

  // the refreshed list contains the uploaded credential, and it verifies
  const row = page.getByRole('row').filter({ hasText: 'PlaywrightUpload' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText('Signature is valid.')).toBeVisible();
});

test('uploads a credential from pasted JSON under a chosen name', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);
  const modal = await openUploadModal(page);

  await modal.locator('.cm-content').fill(readFileSync(FIXTURE_PATH, 'utf8'));
  await modal.getByLabel('Name').fill('PastedUpload.json');
  await modal.getByRole('button', { name: 'Upload', exact: true }).click();

  await expect(page.getByRole('row').filter({ hasText: 'PastedUpload' })).toBeVisible();
});

test('uploads a credential dropped onto the drop zone', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);
  const modal = await openUploadModal(page);

  const dataTransfer = await page.evaluateHandle((content) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], 'DraggedUpload.json', { type: 'application/json' }));
    return dt;
  }, readFileSync(FIXTURE_PATH, 'utf8'));
  await modal.getByTestId('credential-drop-zone').dispatchEvent('drop', { dataTransfer });

  await expect(modal.getByLabel('Name')).toHaveValue('DraggedUpload.json');
  await modal.getByRole('button', { name: 'Upload', exact: true }).click();

  await expect(page.getByRole('row').filter({ hasText: 'DraggedUpload' })).toBeVisible();
});

test('flags invalid JSON and blocks the upload', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);
  const modal = await openUploadModal(page);

  await modal.locator('.cm-content').fill('{"type": ["VerifiablePresentation"');
  await modal.getByLabel('Name').fill('bad.json');

  // the editor highlights the parse error dynamically, and the upload is
  // blocked until the JSON parses
  await expect(modal.locator('.cm-lint-marker-error').first()).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();

  // repairing the JSON re-enables the upload
  await modal.locator('.cm-content').fill('{"type": ["VerifiablePresentation"]}');
  await expect(modal.getByRole('button', { name: 'Upload', exact: true })).toBeEnabled();
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
