import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import QRCode from 'qrcode';
import { WasClient, type ResourceData } from '@interop/was-client';
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key';
import { removePublicCopy } from '../src/lib/publicCopy';

// End-to-end tests of the wallet UI. The Vite dev server is started
// automatically (or reused if already up on :5173), and the app takes its
// service URLs from the VITE_ variables in the environment or in .env (not
// committed; .env.example lists them).
//
// What runs today:
// - the sandbox banner and mismatched-password tests need nothing more
// - the wrong-password test needs a space server at VITE_WAS_BASE_URL,
//   where sign-in looks the credential up
//
// What doesn't, until it is repaired or removed (#199):
// - the registration-code test expects the back end's invalid-code
//   message, but the space server now checks the code first, when
//   registration creates the space, and the page shows its raw 403 (#200)
// - the tests that sign in stop at the add-a-passkey offer (logIn doesn't
//   mark it dismissed, as deployed.spec.ts does), and need the demo account
//   (tests/scripts/register-demo.ts, seed-demo.ts) on the space server and
//   on the back end at VITE_API_BASE_URL. Since #163 only the sandbox has
//   one, and these tests change it: don't point them there
// - the sharing tests also call a space server on localhost:3000 directly,
//   with the demo key from before #163 (see deriveKeyPair)
// tests/deployed.spec.ts covers signing in, against the sandbox.

const DEMO_EMAIL = 'jc.chartrand@gmail.com';
const DEMO_PASSPHRASE = 'my-secret-seed-that-is-long-enou';

async function logIn(page: Page) {
  // The test browser never has the CHAPI wallet enabled, so suppress the
  // enable-browser-wallet prompt (same flag its "Not now" button sets) or its
  // overlay would intercept the tests' clicks.
  await page.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
  await page.goto('/');
  await page.getByLabel('Email').fill(DEMO_EMAIL);
  await page.getByLabel('Password').fill(DEMO_PASSPHRASE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Login lands on the spaces card view; open the demo account's space
  await page.locator('[data-space-type="credential"]').first().click();
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
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
});

test('rejects registration with an invalid registration code', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('Email').fill('someone@example.com');
  await page.getByLabel('Password', { exact: true }).fill('a brand new passphrase');
  await page.getByLabel('Confirm password').fill('a brand new passphrase');
  await page.getByLabel('Registration code').fill('not-the-code');
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
  await page.getByLabel('Registration code').fill('anything');
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

  await expect(page.getByText(/Genuine, but we can't confirm who issued it|Verified/).first())
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('none detected')).toBeVisible();
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
  await expect(page.getByText(/Genuine, but we can't confirm who issued it|Verified/).first())
    .toBeVisible({ timeout: 30_000 });
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

// Sharing. Sharing publishes a copy of the credential in the space's public
// collection under a fixed id, so sharing again brings the same link back
// (src/lib/publicCopy.ts). These helpers reach the demo space directly, signed
// with the demo key, to plant a copy shared before the dialog opens and to
// clean up whatever a failed test left behind.
const DEMO_SPACE_ID = 'dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c';
const DEMO_SPACE_URL = `http://localhost:3000/space/${DEMO_SPACE_ID}`;
const VERIFIER_PREFIX = 'https://verifierplus.org/#verify?vc=';

// The demo key as sign-in derived it before #163 (SHA-256 of the passphrase
// as the Ed25519 seed), kept here because src/lib/login.ts is gone and this
// file must load for any test to run. Accounts no longer use this key since
// #163, so these local-stack share helpers need porting before they can run.
async function deriveKeyPair(passphrase: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passphrase));
  const keyPair = await Ed25519VerificationKey.generate({ seed: new Uint8Array(digest) });
  keyPair.controller = `did:key:${keyPair.fingerprint()}`;
  keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`;
  return keyPair;
}

async function demoSpace() {
  const keyPair = await deriveKeyPair(DEMO_PASSPHRASE);
  const client = await WasClient.fromSigner({ serverUrl: 'http://localhost:3000', signer: keyPair.signer() });
  return client.space(DEMO_SPACE_ID);
}

// The stored id of the LCWExperience credential in UniversityOfToronto
async function lcwExperienceId(): Promise<string> {
  const list = await (await demoSpace()).collection('UniversityOfToronto').list();
  const item = list?.items.find((i) => i.id.startsWith('LCWExperience'));
  if (!item) {
    throw new Error('LCWExperience is not seeded in UniversityOfToronto');
  }
  return item.id;
}

async function takeDownLcwExperience() {
  const pub = (await demoSpace()).collection('public', { encryption: 'plaintext' });
  await removePublicCopy(pub, 'UniversityOfToronto', await lcwExperienceId());
}

async function openShareDialog(page: Page): Promise<Locator> {
  await logIn(page);
  await openUniversityCollection(page);
  await page.locator('[data-resource-id^="LCWExperience"]').getByRole('button', { name: 'Open' }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const modal = page.getByRole('dialog', { name: /^Share / });
  await expect(modal).toBeVisible();
  return modal;
}

function option(modal: Locator, name: 'Only you' | 'Anyone with the link'): Locator {
  return modal.getByRole('group', { name: 'Who can see it' }).getByRole('button', { name });
}

// The raw public URL, read off the readable link the dialog shows
async function directLink(modal: Locator): Promise<string> {
  const readable = await modal.getByLabel('Link to share').inputValue();
  expect(readable.startsWith(VERIFIER_PREFIX)).toBe(true);
  return readable.slice(VERIFIER_PREFIX.length);
}

test.describe('sharing', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(takeDownLcwExperience);
  test.afterEach(takeDownLcwExperience);

  test('shares a credential, and taking the link down stops every link working', async ({ page }) => {
    const modal = await openShareDialog(page);

    // it starts private, once the dialog has checked
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal).toContainText("Sending switches it to Anyone with the link. We'll ask first.");
    await expect(modal.getByLabel('Link to share')).toHaveCount(0);

    // choosing Anyone with the link shares it straight away
    await option(modal, 'Anyone with the link').click();
    await expect(modal.getByRole('status').filter({ hasText: 'Anyone with the link can now see it.' })).toBeVisible();
    await expect(option(modal, 'Anyone with the link')).toHaveAttribute('aria-pressed', 'true');
    const first = await directLink(modal);
    expect(first).toBe(`${DEMO_SPACE_URL}/public/UniversityOfToronto--${await lcwExperienceId()}`);
    await expect(modal.getByText('Direct link to the credential file')).toBeVisible();

    // the link works without any authorization
    const res = await page.request.get(first);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('VerifiablePresentation');

    // reopening the dialog finds the same link
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).toBeHidden();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(option(modal, 'Anyone with the link')).toHaveAttribute('aria-pressed', 'true');
    expect(await directLink(modal)).toBe(first);

    // Only you asks first; Keep the link changes nothing
    await option(modal, 'Only you').click();
    await expect(modal).toContainText('Switch to Only you and take the link down?');
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'false');
    await modal.getByRole('button', { name: 'Keep the link' }).click();
    await expect(modal).not.toContainText('take the link down?');
    expect(await directLink(modal)).toBe(first);
    expect((await page.request.get(first)).status()).toBe(200);

    // Take it down stops the link working
    await option(modal, 'Only you').click();
    await modal.getByRole('button', { name: 'Take it down' }).click();
    await expect(modal.getByRole('status').filter({
      hasText: 'Link taken down. If you share it again, the same link will work again.',
    })).toBeVisible();
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.getByLabel('Link to share')).toHaveCount(0);
    expect((await page.request.get(first)).status()).not.toBe(200);

    // sharing again brings the same link back, and it works again
    await option(modal, 'Anyone with the link').click();
    await expect(modal.getByLabel('Link to share')).toBeVisible();
    expect(await directLink(modal)).toBe(first);
    expect((await page.request.get(first)).status()).toBe(200);
  });

  test('a credential shared before the dialog opens shows its link and can be taken down', async ({ page }) => {
    // plant a copy the way the wallet before this dialog shared, at the same id
    const space = await demoSpace();
    const id = await lcwExperienceId();
    const legacyId = `UniversityOfToronto--${id}`;
    const pub = space.collection('public', { encryption: 'plaintext' });
    const body = await space.collection('UniversityOfToronto').get(id);
    await pub.put(legacyId, (body instanceof Blob ? JSON.parse(await body.text()) : body) as ResourceData);
    await pub.resource(legacyId).setPublic();
    const legacyUrl = `${DEMO_SPACE_URL}/public/${legacyId}`;
    expect((await page.request.get(legacyUrl)).status()).toBe(200);

    const modal = await openShareDialog(page);
    await expect(option(modal, 'Anyone with the link')).toHaveAttribute('aria-pressed', 'true');
    expect(await directLink(modal)).toBe(legacyUrl);

    await option(modal, 'Only you').click();
    await modal.getByRole('button', { name: 'Take it down' }).click();
    await expect(modal.getByRole('status').filter({ hasText: 'Link taken down.' })).toBeVisible();
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');
    expect((await page.request.get(legacyUrl)).status()).not.toBe(200);
    expect((await pub.list())?.items.some((i) => i.id === legacyId)).toBe(false);
  });

  test('a share that fails puts the choice back and says so in plain words', async ({ page }) => {
    // the storage server refuses to write the public copy
    await page.route(/\/public\/[^/]+$/, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Internal Server Error"}' })
        : route.continue()
    );
    const modal = await openShareDialog(page);
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');

    await option(modal, 'Anyone with the link').click();
    await expect(modal.getByRole('alert')).toHaveText('Could not create the link.');
    await expect(modal).not.toContainText(/internal server error/i);
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.getByLabel('Link to share')).toHaveCount(0);
  });

  test('the arrow keys never change who can see it; Enter and Space do', async ({ page }) => {
    const modal = await openShareDialog(page);
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');

    await option(modal, 'Only you').focus();
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) {
      await page.keyboard.press(key);
    }
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.getByLabel('Link to share')).toHaveCount(0);

    // Space on Anyone with the link shares it
    await option(modal, 'Anyone with the link').focus();
    await page.keyboard.press('Space');
    await expect(option(modal, 'Anyone with the link')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.getByLabel('Link to share')).toBeVisible();

    // Enter on Only you opens the question and moves focus into it;
    // answering returns focus to the option
    await option(modal, 'Only you').focus();
    await page.keyboard.press('Enter');
    await expect(modal.getByRole('button', { name: 'Keep the link' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(option(modal, 'Only you')).toBeFocused();
    await expect(option(modal, 'Anyone with the link')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the QR code asks first, shows the readable link, and stays on after closing', async ({ page }) => {
    const modal = await openShareDialog(page);
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');

    // while private it asks; Cancel changes nothing
    await modal.getByRole('button', { name: 'QR code' }).click();
    await expect(modal).toContainText('To show a QR code, switch to Anyone with the link?');
    await expect(modal.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.getByRole('img', { name: /QR code/ })).toHaveCount(0);

    // Switch and continue shares it and shows the code in the same click
    await modal.getByRole('button', { name: 'QR code' }).click();
    await modal.getByRole('button', { name: 'Switch and continue' }).click();
    const qrImage = modal.getByRole('img', { name: 'QR code for the link' });
    await expect(qrImage).toBeVisible();
    expect(await qrImage.getAttribute('src')).toMatch(/^data:image\//);
    await expect(modal).toContainText('Opens the same page as the link. The link stays on until you take it down.');
    await expect(modal.getByRole('button', { name: 'Raw credential' })).toHaveCount(0);
    const link = await directLink(modal);

    // Hide QR hides it; closing the dialog leaves the link working
    await modal.getByRole('button', { name: 'Hide QR' }).click();
    await expect(qrImage).toHaveCount(0);
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).toBeHidden();
    expect((await page.request.get(link)).status()).toBe(200);
  });

  test('LinkedIn and Other apps ask first, then send the readable link', async ({ page }) => {
    // LinkedIn itself would send a signed-out test browser to its login page;
    // only the form URL the wallet opens matters here
    await page.context().route(/linkedin\.com/, (route) => route.fulfill({ body: 'LinkedIn stand-in' }));
    // a stand-in share sheet that records what it was given
    await page.addInitScript(() => {
      const shared: ShareData[] = [];
      (window as unknown as { shared: ShareData[] }).shared = shared;
      navigator.share = async (data?: ShareData) => {
        shared.push(data ?? {});
      };
    });
    const modal = await openShareDialog(page);
    await expect(option(modal, 'Only you')).toHaveAttribute('aria-pressed', 'true');

    // Other apps while private: asks, then shares and sends in the same click
    await modal.getByRole('button', { name: 'Other apps' }).click();
    await expect(modal).toContainText('To send it with another app, switch to Anyone with the link?');
    await modal.getByRole('button', { name: 'Switch and continue' }).click();
    await expect(modal.getByLabel('Link to share')).toBeVisible();
    const readable = await modal.getByLabel('Link to share').inputValue();
    await expect.poll(() => page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared))
      .toEqual([{ title: expect.any(String), url: readable }]);

    // take it down, then LinkedIn while private asks too and opens the form
    await option(modal, 'Only you').click();
    await modal.getByRole('button', { name: 'Take it down' }).click();
    await expect(modal.getByRole('status').filter({ hasText: 'Link taken down.' })).toBeVisible();
    await modal.getByRole('button', { name: 'LinkedIn' }).click();
    await expect(modal).toContainText('To add it to LinkedIn, switch to Anyone with the link?');
    const popupPromise = page.waitForEvent('popup');
    await modal.getByRole('button', { name: 'Switch and continue' }).click();
    const popup = await popupPromise;
    await popup.waitForURL(/linkedin\.com\/profile\/add/, { waitUntil: 'commit' });
    const certUrl = new URL(popup.url()).searchParams.get('certUrl');
    await expect(modal.getByLabel('Link to share')).toBeVisible();
    expect(certUrl).toBe(await modal.getByLabel('Link to share').inputValue());
    // shared again after the take-down, so the same link as before
    expect(certUrl).toBe(readable);
    // Closed last: closing it first now and then dropped the main page's
    // DevTools session mid-assertion
    await popup.close();
  });
});

test('deletes a credential into Trash', async ({ page }) => {
  await logIn(page);
  await openUniversityCollection(page);

  // PastedUpload.json was created by the pasted-JSON upload test above
  const row = page.getByRole('row').filter({ hasText: 'PastedUpload' });
  await row.getByRole('button', { name: 'Delete' }).click();

  const modal = page.getByRole('dialog', { name: 'Delete Credential' });
  await expect(modal).toContainText('Move PastedUpload.json to Trash? You can restore it from there.');
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
  await expect(page.getByText(/Genuine, but we can't confirm who issued it|Verified/).first())
    .toBeVisible({ timeout: 30_000 });

  const bachelors = page.getByRole('row').filter({ hasText: 'Bachelors' });
  await bachelors.getByRole('button', { name: 'Verify' }).click();
  // the verifier re-renders with the second credential's content, and the
  // highlight moves to its row
  await expect(page.getByText('Bachelors in Computer Science').first()).toBeVisible();
  await expect(page.getByText(/Genuine, but we can't confirm who issued it|Verified/).first())
    .toBeVisible({ timeout: 30_000 });
  await expect(bachelors).toHaveClass(/bg-indigo-50/);
  await expect(experience).not.toHaveClass(/bg-indigo-50/);
});
