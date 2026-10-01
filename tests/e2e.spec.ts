import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import QRCode from 'qrcode';

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
  await page.getByRole('button', { name: 'Add Credential' }).click();
  return page.getByRole('dialog', { name: 'Add Credential' });
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
  await modal.getByRole('button', { name: 'Add', exact: true }).click();

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
  await modal.getByRole('button', { name: 'Add', exact: true }).click();

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
  await modal.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByRole('row').filter({ hasText: 'DraggedUpload' })).toBeVisible();
});

// A QR image can carry the credential JSON itself, a URL that serves it, or a
// CBOR-LD-encoded presentation (the VP1- format the LCW mobile wallet uses)
async function stageQrImage(modal: Locator, content: string) {
  const buffer = await QRCode.toBuffer(content, { width: 480, margin: 2 });
  await modal.locator('input[type=file]').setInputFiles({
    name: 'credential-qr.png', mimeType: 'image/png', buffer,
  });
}

test('adds a credential scanned from a QR image containing JSON', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);
  const modal = await openUploadModal(page);

  await stageQrImage(modal, JSON.stringify({
    '@context': 'https://www.w3.org/2018/credentials/v1',
    type: 'VerifiableCredential',
    credentialSubject: { id: 'did:example:embedded-json-qr' },
  }));

  // scanning stages the decoded credential with a generated, editable name
  await expect(modal.locator('.cm-content')).toContainText('did:example:embedded-json-qr');
  await expect(modal.getByLabel('Name')).toHaveValue(/^scanned-/);
  await modal.getByLabel('Name').fill('ScannedUpload.json');
  await modal.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByRole('row').filter({ hasText: 'ScannedUpload' })).toBeVisible();
});

test('stages a credential from a QR image containing a URL', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);
  const modal = await openUploadModal(page);

  await stageQrImage(
    modal,
    'https://digitalcredentials.github.io/vc-test-fixtures/verifiableCredentials/v1/bothSignatureTypes/didKey/fourRegistry-noStatus-noExpiry.json'
  );

  // the URL is fetched and its credential staged
  await expect(modal.locator('.cm-content')).toContainText('VerifiableCredential');
});

test('stages a credential from a CBOR-LD (VP1) QR image', async ({ page }) => {
  // Pre-encoded with @digitalcredentials/vpqr: a presentation holding one
  // credential whose subject is did:example:qr-test-subject
  const vp1 = 'VP1-B3ECQDIYACEMHIGDODB6KKAARDB2BQ3AYQKQRQ4DYDNSGSZB2MV4GC3LQNRSTU4LSFV2GK43UFVZXKYTKMVRXIGEIDJVLDRIADCGIEGIEAFMCF3IBKVK44ICANKL4FEWA54S6YF4GITMGJYFVIA55GT4QJZGYAM7V6GHA';
  await logIn(page);
  await openUniversityCollection(page);
  const modal = await openUploadModal(page);

  await stageQrImage(modal, vp1);

  await expect(modal.locator('.cm-content')).toContainText('did:example:qr-test-subject');
  await expect(modal.locator('.cm-content')).toContainText('VerifiablePresentation');
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
  await expect(modal.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();

  // repairing the JSON re-enables the upload
  await modal.locator('.cm-content').fill('{"type": ["VerifiablePresentation"]}');
  await expect(modal.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
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

  // ...along with a companion link that verifies it on VerifierPlus
  await expect(modal.getByLabel('VerifierPlus link'))
    .toHaveValue(`https://verifierplus.org/#verify?vc=${link}`);

  // the link works without any authorization
  const res = await page.request.get(link);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('VerifiablePresentation');

  // ...and only for this resource: a sibling stays private
  const sibling = link.replace('LCWExperience.json', 'Bachelors.json');
  expect((await page.request.get(sibling)).status()).not.toBe(200);

  // reopening the dialog shows the existing link, not Create Public Link
  await modal.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('row').filter({ hasText: 'LCWExperience' })
    .getByRole('button', { name: 'Share' }).click();
  await expect(modal.getByLabel('Public link')).toHaveValue(link);
  await expect(modal.getByRole('button', { name: 'Create Public Link' })).toHaveCount(0);
  await expect(modal).toContainText('The links will stop working');

  // a QR code on an already-public credential doesn't revoke access on close
  await modal.getByRole('button', { name: 'QR code', exact: true }).click();
  await expect(modal.getByRole('img', { name: /QR code/ })).toBeVisible();
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toBeHidden();
  expect((await page.request.get(link)).status()).toBe(200);
  await page.getByRole('row').filter({ hasText: 'LCWExperience' })
    .getByRole('button', { name: 'Share' }).click();
  await expect(modal.getByLabel('Public link')).toHaveValue(link);

  // unsharing asks for confirmation first; backing out changes nothing
  await modal.getByRole('button', { name: 'Unshare' }).click();
  await expect(modal).toContainText('Remove public access?');
  await modal.getByRole('button', { name: 'Keep sharing' }).click();
  await expect(modal.getByLabel('Public link')).toHaveValue(link);

  // confirming kills the link and restores the Create option
  await modal.getByRole('button', { name: 'Unshare' }).click();
  await modal.getByRole('button', { name: 'Yes, unshare' }).click();
  await expect(modal.getByRole('button', { name: 'Create Public Link' })).toBeVisible();
  expect((await page.request.get(link)).status()).not.toBe(200);

  // safety net in case an earlier expectation aborted before the UI unshare
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
  await expect(modal.getByRole('button', { name: 'QR code', exact: true })).toBeVisible();

  // LinkedIn is still a stub
  await modal.getByRole('button', { name: 'Add to LinkedIn' }).click();
  await expect(modal.getByRole('status')).toHaveText('Add to LinkedIn is coming soon.');
});

test('shows a QR code and shares only while it is visible', async ({ page }) => {
  const link = 'http://localhost:3000/space/dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c/UniversityOfToronto/LCWExperience.json';
  await logIn(page);
  await openUniversityCollection(page);

  await page.getByRole('row').filter({ hasText: 'LCWExperience' })
    .getByRole('button', { name: 'Share' }).click();
  const modal = page.getByRole('dialog', { name: 'Share Credential' });

  // the credential starts private
  await expect(modal.getByRole('button', { name: 'Create Public Link' })).toBeVisible();
  expect((await page.request.get(link)).status()).not.toBe(200);

  // the QR appears (VerifierPlus target first) and warns about the
  // temporary public access it needed
  await modal.getByRole('button', { name: 'QR code', exact: true }).click();
  const qrImage = modal.getByRole('img', { name: /QR code/ });
  await expect(qrImage).toBeVisible();
  expect(await qrImage.getAttribute('src')).toMatch(/^data:image\//);
  await expect(modal).toContainText('temporarily public');
  expect((await page.request.get(link)).status()).toBe(200);

  // the toggle switches the encoded target
  const verifierSrc = await qrImage.getAttribute('src');
  await modal.getByRole('button', { name: 'Raw credential' }).click();
  expect(await qrImage.getAttribute('src')).not.toBe(verifierSrc);

  // closing the dialog reverts the temporary public access
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toBeHidden();
  await expect(async () => {
    expect((await page.request.get(link)).status()).not.toBe(200);
  }).toPass({ timeout: 10000 });

  // safety net in case an earlier expectation aborted before the revert
  execSync(
    'aws s3 rm s3://dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c/policies/UniversityOfToronto/LCWExperience.json.json --region us-east-1',
    { stdio: 'ignore' }
  );
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
