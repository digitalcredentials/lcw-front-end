import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The verifier-plugin card as the wallet uses it (src/components/
// CredentialVerifier.tsx), in a real browser with real verification, and no
// back end: tests/harness/verifier.tsx renders the component on the login page.
//
// Nothing goes to the network. The DCC registry list, the one registry it
// names and the Open Badges schema are answered from tests/fixtures/verifier,
// and any other outside request fails the test. The two credentials are copies
// of vc-test-fixtures' v2/ed25519/didKey/legacy-noStatus-noExpiry(-tampered).json.

const fixture = (name: string) => new URL(`./fixtures/verifier/${name}`, import.meta.url).pathname;
const credential = (name: string) => JSON.parse(readFileSync(fixture(`${name}.json`), 'utf8'));

const REGISTRY_LIST = 'https://digitalcredentials.github.io/dcc-known-registries/known-did-registries.json';
const REGISTRY = 'https://registry.example.test/registry.json';
// verifier-plugin's own default, which the card falls back to without the list.
const DEFAULT_REGISTRY = 'https://digitalcredentials.github.io/sandbox-registry/registry.json';
const SCHEMA = 'https://purl.imsglobal.org/spec/ob/v3p0/schema/json/ob_v3p0_achievementcredential_schema.json';

const outside: string[] = [];

// 'down-once' fails the first request for the registry list and answers the
// rest; 'hang' never answers it.
async function serveFixtures(page: Page, registryList: 'ok' | 'down' | 'down-once' | 'hang' = 'ok') {
  outside.length = 0;
  let listRequests = 0;
  await page.route(
    (url) => url.hostname !== 'localhost',
    (route) => {
      const url = route.request().url();
      const json = (name: string) =>
        route.fulfill({ path: fixture(name), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
      if (url === REGISTRY_LIST) {
        listRequests++;
        if (registryList === 'hang') return;
        const down = registryList === 'down' || (registryList === 'down-once' && listRequests === 1);
        return down ? route.fulfill({ status: 503 }) : json('known-did-registries.json');
      }
      if (url === REGISTRY || url === DEFAULT_REGISTRY) return json('registry.json');
      if (url === SCHEMA) return json('ob_v3p0_achievementcredential_schema.json');
      outside.push(url);
      return route.abort('blockedbyclient');
    }
  );
}

/** Shows `credential` in the wallet's verifier and reads the card once it has finished. */
async function verify(page: Page, credential?: Record<string, unknown>) {
  return page.evaluate(async (credential) => {
    let started = 0;
    let registry = '';
    document.addEventListener('verification-started', () => started++);
    const done = new Promise<void>((resolve) => {
      document.addEventListener(
        'verification-complete',
        (e) => {
          const results = (e as CustomEvent).detail.response.results as { id?: string; outcome: { status: string; message?: string } }[];
          const check = results.find((r) => r.id === 'trust.registry.issuer')?.outcome;
          registry = check ? `${check.status}: ${check.message ?? ''}` : 'absent';
          resolve();
        },
        { once: true }
      );
      document.addEventListener('verification-failed', () => resolve(), { once: true });
    });
    const { show } = await import('/tests/harness/verifier.tsx');
    show(credential);
    await Promise.race([done, new Promise((r) => setTimeout(r, 30_000))]);
    // Long enough for a second, unwanted check to have started
    await new Promise((r) => setTimeout(r, 1_000));
    const cards = document.querySelectorAll('verifier-credential');
    const root = cards[0]?.shadowRoot;
    const glyph = root?.querySelector('.glyph');
    return {
      cards: cards.length,
      started,
      registry,
      severity: glyph ? [...glyph.classList].find((c) => c.startsWith('s-'))?.slice(2) : undefined,
      headline: root?.querySelector('.headline')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      text: root?.querySelector('.card')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    };
  }, credential);
}

test.beforeEach(async ({ page }) => {
  await serveFixtures(page);
});

test.afterEach(() => {
  expect(outside, 'requests to anywhere not answered from tests/fixtures/verifier').toEqual([]);
});

test('a genuine credential from a listed issuer is verified', async ({ page }) => {
  await page.goto('/');
  const card = await verify(page, credential('verified'));
  expect(card.cards).toBe(1);
  expect(card.registry).toBe('success: Issuer found in registry: Test Registry');
  expect(card.severity).toBe('success');
  expect(card.headline).toContain('Verified');
  await expect(page.locator('verifier-credential')).toBeVisible();
});

test('a tampered credential is an error', async ({ page }) => {
  await page.goto('/');
  const card = await verify(page, credential('tampered'));
  expect(card.started).toBe(1);
  expect(card.severity).toBe('error');
  expect(card.headline).toContain('tampered');
});

test('it checks once, after the registry list has loaded', async ({ page }) => {
  await page.goto('/');
  const card = await verify(page, credential('verified'));
  expect(card.started).toBe(1);
});

test('if the registry list will not load, it still checks the credential', async ({ page }) => {
  await page.unrouteAll();
  await serveFixtures(page, 'down');
  await page.goto('/');
  const card = await verify(page, credential('verified'));
  expect(card.started).toBe(1);
  // Found through verifier-plugin's own default registry instead.
  expect(card.registry).toBe('success: Issuer found in registry: DCC Sandbox Registry');
  expect(card.severity).toBe('success');
});

test('if the registry list never answers, it checks without it after 10 seconds', async ({ page }) => {
  await page.unrouteAll();
  await serveFixtures(page, 'hang');
  await page.goto('/');
  const card = await verify(page, credential('verified'));
  expect(card.started).toBe(1);
  expect(card.registry).toBe('success: Issuer found in registry: DCC Sandbox Registry');
});

test('after the registry list fails, the next credential asks for it again', async ({ page }) => {
  await page.unrouteAll();
  await serveFixtures(page, 'down-once');
  await page.goto('/');
  const first = await verify(page, credential('verified'));
  expect(first.registry).toBe('success: Issuer found in registry: DCC Sandbox Registry');
  // A new credential, so the list is asked for again, and this time it loads
  const second = await verify(page, credential('verified'));
  expect(second.started).toBe(1);
  expect(second.registry).toBe('success: Issuer found in registry: Test Registry');
});

test('the card stays hidden until it has a credential to check', async ({ page }) => {
  await page.unrouteAll();
  await serveFixtures(page, 'hang');
  await page.goto('/');
  const card = page.locator('verifier-credential');
  const show = (c?: Record<string, unknown>) =>
    page.evaluate(async (c) => (await import('/tests/harness/verifier.tsx')).show(c), c);

  // No credential: no empty card
  await show(undefined);
  await expect(card).toHaveCount(1);
  await expect(card).toBeHidden();

  // A credential, but the registry list is still loading: a line says so instead
  await show(credential('verified'));
  await expect(page.getByText('Checking…')).toBeVisible();
  await expect(card).toBeHidden();
});
