import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

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

test('shows the sandbox banner on the login and registration pages', async ({ page }) => {
  for (const path of ['/#/login', '/#/register']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Learner Credential Wallet' })).toBeVisible();
    await expect(page.getByText('THIS IS A SANDBOX FOR TESTING AND WILL BE RESET FREQUENTLY')).toBeVisible();
    await expect(page.getByText("DO NOT STORE ANYTHING YOU'D LIKE TO KEEP")).toBeVisible();
  }
});

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill('not the passphrase');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
});

test('rejects registration with an invalid registration code', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('Email').fill('someone@example.com');
  await page.getByLabel('Password', { exact: true }).fill('a brand new passphrase');
  await page.getByLabel('Confirm password').fill('a brand new passphrase');
  await page.getByLabel('Registration Code').fill('not-the-code');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    "Your registration code isn't valid. Please try again or obtain a new code."
  );
});

test('rejects registration when passwords do not match', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('Email').fill('someone@example.com');
  await page.getByLabel('Password', { exact: true }).fill('one passphrase');
  await page.getByLabel('Confirm password').fill('a different passphrase');
  await page.getByLabel('Registration Code').fill('anything');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toHaveText('Passwords do not match.');
});

test('logs in and lists the space collections', async ({ page }) => {
  await logIn(page);
  await expect(page.getByText('Verifiable Credentials Collection')).toBeVisible();
  await expect(page.getByText('UniversityOfToronto').first()).toBeVisible();
});

test('creates a new collection', async ({ page }) => {
  await logIn(page);
  await expect(page.getByText('UniversityOfToronto').first()).toBeVisible();

  // New Collection is offered on the collections page
  await page.getByRole('button', { name: 'New Collection' }).click();
  const modal = page.getByRole('dialog', { name: 'New Collection' });
  await modal.getByLabel('Name').fill('Playwright Made This');
  await modal.getByRole('button', { name: 'Create' }).click();

  // the refreshed list contains it (id = name with whitespace dashed), and it
  // opens as an empty collection
  const row = page.getByRole('row').filter({ hasText: 'Playwright-Made-This' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Playwright-Made-This/ }).click();
  await expect(page.getByText('This collection is empty.')).toBeVisible();

  // clean up so the next run can create it again
  execSync(
    'aws s3 rm s3://dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c/collections/Playwright-Made-This/description.json --region us-east-1',
    { stdio: 'ignore' }
  );
});

test('verifies a credential and highlights its row', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  const row = page.getByRole('row').filter({ hasText: 'LCWExperience' });
  await row.getByRole('button', { name: 'Verify' }).click();

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

  // …only once a credential is selected for verification
  await page.getByRole('row').filter({ hasText: 'LCWExperience' })
    .getByRole('button', { name: 'Verify' }).click();
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
  await row.getByRole('button', { name: 'Verify' }).click();
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

test('shows a credential source in the read-only editor', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  await page.getByRole('row').filter({ hasText: 'LCWExperience' })
    .getByRole('button', { name: 'View Source' }).click();

  const source = page.locator('section[aria-label="Credential source"]');
  await expect(source).toBeVisible();
  await expect(source.locator('.cm-content')).toContainText('VerifiablePresentation');
  // the verifier section stays hidden in source mode
  await expect(page.locator('section[aria-label="Credential verification"]')).toBeHidden();
});

test('creates a public link that serves the credential unsigned', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  await page.getByRole('row').filter({ hasText: 'LCWExperience' })
    .getByRole('button', { name: 'Share' }).click();
  const modal = page.getByRole('dialog', { name: 'Share Credential' });
  await modal.getByRole('button', { name: 'Create Public Link' }).click();

  const link = await modal.getByLabel('Public link').inputValue();
  expect(link).toContain('/UniversityOfToronto/LCWExperience.json');

  // the link works without any authorization
  const res = await page.request.get(link);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('VerifiablePresentation');

  // ...and only for this resource: a sibling stays private
  const sibling = link.replace('LCWExperience.json', 'Bachelors.json');
  expect((await page.request.get(sibling)).status()).not.toBe(200);

  // clean up the policy so the next run starts private
  execSync(
    'aws s3 rm s3://dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c/policies/UniversityOfToronto/LCWExperience.json.json --region us-east-1',
    { stdio: 'ignore' }
  );
});

test('offers the share options', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  await page.getByRole('row').filter({ hasText: 'LCWExperience' })
    .getByRole('button', { name: 'Share' }).click();

  const modal = page.getByRole('dialog', { name: 'Share Credential' });
  await expect(modal.getByRole('button', { name: 'Create Public Link' })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Add to LinkedIn' })).toBeVisible();
  // (Create Public Link is real; the remaining options are stubs)
  await expect(modal.getByRole('button', { name: 'QR code' })).toBeVisible();

  // the options are stubs for now
  await modal.getByRole('button', { name: 'QR code' }).click();
  await expect(modal.getByRole('status')).toHaveText('QR code is coming soon.');
});

test('deletes a credential into the Trash collection', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  // PastedUpload.json was created by the pasted-JSON upload test above
  const row = page.getByRole('row').filter({ hasText: 'PastedUpload' });
  await row.getByRole('button', { name: 'Delete' }).click();

  const modal = page.getByRole('dialog', { name: 'Delete Credential' });
  await expect(modal).toContainText('Move PastedUpload.json to the Trash collection?');
  await modal.getByRole('button', { name: 'Delete' }).click();

  // the refreshed list no longer contains it…
  await expect(row).toHaveCount(0);

  // …and the space now has a Trash collection holding it
  await page.getByRole('button', { name: 'Collections' }).click();
  await page.reload();
  await page.getByRole('button', { name: /Trash/ }).click();
  await expect(page.getByRole('row').filter({ hasText: 'PastedUpload' })).toBeVisible();
});

test('verifies a second credential after the first', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  const experience = page.getByRole('row').filter({ hasText: 'LCWExperience' });
  await experience.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('LCW Experience Badge').first()).toBeVisible();
  await expect(page.getByText('Signature is valid.')).toBeVisible();

  const bachelors = page.getByRole('row').filter({ hasText: 'Bachelors' });
  await bachelors.getByRole('button', { name: 'Verify' }).click();
  // the verifier re-renders with the second credential's content, and the
  // highlight moves to its row
  await expect(page.getByText('Bachelors in Computer Science').first()).toBeVisible();
  await expect(page.getByText('Signature is valid.')).toBeVisible();
  await expect(bachelors).toHaveClass(/bg-indigo-50/);
  await expect(experience).not.toHaveClass(/bg-indigo-50/);
});
