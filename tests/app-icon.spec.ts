import { test, expect, type APIRequestContext } from '@playwright/test';

// Issue #141: the browser's wallet chooser and the browser tab show the
// Digital Credentials Commons mark, not a generic globe and Vite's icon.
//
// The chooser (the CHAPI mediator at authn.io) reads the wallet's
// /manifest.json, takes the square icon whose first `sizes` entry is nearest
// the size it draws, and loads it as <img crossorigin="anonymous"> from its
// own origin, so the icon needs CORS as well as the manifest. With no icon it
// tries /favicon.ico, and falls back to the globe when that is not an image.
// (authn.io web/mediator/manifest.js and web/components/WrmOriginIcon.vue)
//
// Runs against the dev server by default. Pointed at a deployment with
// BASE_URL, the same checks cover what the live site serves. (BASE_URL, not
// DEPLOYED_URL: these need no account, and DEPLOYED_URL makes the run
// create one. The cross-origin check then loads from example.com.)
//
//   npx playwright test tests/app-icon.spec.ts
//   BASE_URL=https://lcw-sandbox.org npx playwright test tests/app-icon.spec.ts

type ManifestIcon = { src: string; sizes?: string; type?: string; theme_color?: string };

// The site's origin, which the chooser resolves icon addresses against
let site = '';
test.beforeEach(({ baseURL }) => {
  site = new URL(baseURL!).origin;
});

async function manifestIcons(request: APIRequestContext): Promise<ManifestIcon[]> {
  const response = await request.get(`${site}/manifest.json`);
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(Array.isArray(manifest.icons)).toBe(true);
  return manifest.icons;
}

// As the chooser does: an address not starting with http is joined to the
// site's origin
function iconUrl(src: string): string {
  if (src.startsWith('http')) return src;
  return site + (src.startsWith('/') ? '' : '/') + src;
}

// A PNG's width and height, from its header chunk
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('the manifest lists an icon the chooser can pick, true to the image', async ({ request }) => {
  const icons = await manifestIcons(request);
  expect(icons.length).toBeGreaterThan(0);
  for (const icon of icons) {
    // The chooser reads only the first size and skips icons that are not
    // square. It also treats every page as dark mode (it tests
    // matchMedia(...) without .matches), so an icon with theme_color "light"
    // would never show.
    const [first] = (icon.sizes ?? '').split(' ');
    const [width, height] = first.split('x').map((n) => parseInt(n, 10));
    expect(width, `sizes "${icon.sizes}"`).toBe(height);
    expect(icon.theme_color).toBeUndefined();

    const response = await request.get(iconUrl(icon.src));
    expect(response.status(), icon.src).toBe(200);
    expect(response.headers()['content-type']).toBe(icon.type);
    expect(pngSize(await response.body())).toEqual({ width, height });
  }
});

test('every manifest icon loads from another origin, as the chooser loads it', async ({ page, request }) => {
  const icons = await manifestIcons(request);
  expect(icons.length).toBeGreaterThan(0);
  // A stand-in for the chooser's page, on an origin of its own. For a
  // deployment, a real public site, as authn.io is (not one faked with
  // page.route, which turns the browser's cache off and so changes the
  // request). For the dev server, the other name of this computer
  // (localhost <-> 127.0.0.1): Chromium stops a public site loading from
  // this computer, and the dev server's CORS rule allows only localhost.
  const { hostname, port } = new URL(site);
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    const other = hostname === 'localhost' ? '127.0.0.1' : 'localhost';
    await page.goto(`http://${other}:${port}/manifest.json`);
  } else {
    await page.goto('https://example.com/');
  }
  expect(new URL(page.url()).origin).not.toBe(site);
  for (const icon of icons) {
    const loaded = await page.evaluate(
      (src) =>
        new Promise<boolean>((resolve) => {
          const img = document.createElement('img');
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img.naturalWidth > 0);
          img.onerror = () => resolve(false);
          img.src = src;
        }),
      iconUrl(icon.src)
    );
    expect(loaded, `${icon.src} with crossorigin="anonymous"`).toBe(true);
  }
});

test("the browser tab's icon is the DCC mark", async ({ page, request }) => {
  await page.goto(`${site}/`);
  const icons = page.locator('link[rel~="icon"]');
  await expect(icons).toHaveCount(1);
  // Resolved by the browser, against the page's address
  const href = await icons.evaluate((link) => (link as HTMLLinkElement).href);
  expect(new URL(href).pathname).toBe('/dcc-commons-mark.png');

  const response = await request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
  // Not tied to the manifest's icon: #143 sets that from a deployment's
  // own logo, without touching the tab
});
