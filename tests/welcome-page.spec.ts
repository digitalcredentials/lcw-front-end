import { test, expect, type Page } from '@playwright/test';
import { isPlainAddress } from '../src/lib/welcomePage';

// Issue #248: a signed-out visitor who opens the wallet's plain address goes
// to the deployment's welcome page; every other address, a session in the
// tab and a browser a passkey remembers open the wallet as before.
//
// The rule runs node-side always. The browser checks need the dev server
// started with a welcome page (stop any dev server already on 5173 first,
// since Playwright reuses one):
//
//   VITE_WELCOME_URL=https://welcome.example.test npx playwright test tests/welcome-page.spec.ts

const plain = (url: string) => {
  const { pathname, search, hash } = new URL(url);
  return isPlainAddress({ pathname, search, hash });
};

test('the plain address is the root with no # page and no query', () => {
  for (const url of ['https://alpha.lcw.app', 'https://alpha.lcw.app/', 'https://alpha.lcw.app/#', 'https://alpha.lcw.app/#/', 'https://alpha.lcw.app/index.html']) {
    expect(plain(url), url).toBe(true);
  }
  for (const url of [
    'https://alpha.lcw.app/#/login',
    'https://alpha.lcw.app/#/register',
    'https://alpha.lcw.app/#/forgot',
    'https://alpha.lcw.app/#/files',
    'https://lcw.app/request',
    'https://alpha.lcw.app/forgot',
    'https://alpha.lcw.app/?from=email',
  ]) {
    expect(plain(url), url).toBe(false);
  }
});

const WELCOME_URL = process.env.VITE_WELCOME_URL ?? '';

// Answers the welcome page here (it is not under test) and reports whether
// the page went there
async function watchWelcome(page: Page): Promise<() => boolean> {
  let welcomed = false;
  await page.route(`${new URL(WELCOME_URL).origin}/**`, (route) => {
    welcomed = true;
    return route.fulfill({ contentType: 'text/html', body: '<h1>Welcome page</h1>' });
  });
  return () => welcomed;
}

// A stored session in the shape the wallet keeps one in the tab; the
// wallet's pages fail to load with it, after the check under test
const STORED_SESSION = {
  kind: 'transient',
  email: 'visitor@example.test',
  did: 'did:webvh:test',
  serverUrl: 'http://localhost:3000',
  spaceId: 'test',
  userKey: { id: 'did:key:test', secret: 'AAAA' },
  clientAnnexDid: 'did:webvh:annex',
  visitSeed: 'AAAA',
  generationDelegation: {},
  ladderSeed: 'AAAA',
  standingClientSeed: 'AAAA',
  bridgeDelegation: {},
  siblingDelegation: {},
};

test.describe('with a welcome page', () => {
  test.skip(!WELCOME_URL, 'start the dev server with VITE_WELCOME_URL to run the redirect checks');

  test('signed out, the plain address goes to the welcome page', async ({ page }) => {
    const welcomed = await watchWelcome(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome page' })).toBeVisible();
    expect(welcomed()).toBe(true);
  });

  for (const [address, heading] of [
    ['/#/login', 'Sign in'],
    ['/#/register', 'Create account'],
    ['/#/forgot', 'Recover your account'],
    // Paths the hosting serves itself; the dev server answers them with the
    // wallet, which opens its sign-in form as it always has
    ['/request', 'Sign in'],
    ['/forgot', 'Sign in'],
  ]) {
    test(`signed out, ${address} opens the wallet as before`, async ({ page }) => {
      const welcomed = await watchWelcome(page);
      await page.goto(address);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      expect(welcomed()).toBe(false);
    });
  }

  test('with a session in this tab, the plain address opens the wallet', async ({ page }) => {
    const welcomed = await watchWelcome(page);
    await page.goto('/#/login');
    await page.evaluate((stored) => sessionStorage.setItem('lcw_session', JSON.stringify(stored)), STORED_SESSION);
    await page.goto('/');
    // A # route on the wallet's own address: the router ran, so the check let the visit in
    await expect(page).toHaveURL(/^http:\/\/localhost:5173\/#\//);
    expect(welcomed()).toBe(false);
  });

  test('a browser a passkey remembers gets its passkey prompt, not the welcome page', async ({ page }) => {
    const welcomed = await watchWelcome(page);
    await page.goto('/#/login');
    // One client-key record, the way a remembered sign-in leaves this browser
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('lcw-session', 1);
          open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('client-keys')) {
              open.result.createObjectStore('client-keys');
            }
          };
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('client-keys', 'readwrite');
            tx.objectStore('client-keys').put({}, 'remembered-unlock-space');
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        })
    );
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(welcomed()).toBe(false);
  });
});
