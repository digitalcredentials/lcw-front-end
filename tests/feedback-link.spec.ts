import { test, expect, type Page } from '@playwright/test';
import { feedbackPageUrl } from '../src/lib/welcomePage';

// Issue #221: a signed-in tester opens the welcome site's feedback page from
// any screen in the wallet. The link is in the sidebar (behind Menu on a
// phone), opens /feedback?from=wallet on the deployment's welcome page in a
// new tab, and is left out when the deployment has no welcome page.
//
// The address rule runs node-side always. The browser checks follow how the
// dev server was started (stop any dev server already on 5173 first, since
// Playwright reuses one): with a welcome page they check the link, without
// one that there is none.
//
//   VITE_WELCOME_URL=https://welcome.example.test npx playwright test tests/feedback-link.spec.ts
//   npx playwright test tests/feedback-link.spec.ts

test('the feedback page is /feedback?from=wallet on the welcome page', () => {
  expect(feedbackPageUrl('https://welcome.alpha.lcw.app')).toBe('https://welcome.alpha.lcw.app/feedback?from=wallet');
  expect(feedbackPageUrl('https://welcome.alpha.lcw.app/')).toBe('https://welcome.alpha.lcw.app/feedback?from=wallet');
  // A welcome site in a folder, like the GitHub Pages preview
  expect(feedbackPageUrl('https://digitalcredentials.github.io/lcw-welcome')).toBe(
    'https://digitalcredentials.github.io/lcw-welcome/feedback?from=wallet'
  );
  expect(feedbackPageUrl('')).toBeUndefined();
});

const WELCOME_URL = process.env.VITE_WELCOME_URL ?? '';

// The signed-in layout, rendered on its own (tests/harness/shell.tsx), at a
// computer's width unless the test sets a phone's
async function showShell(page: Page, viewport = { width: 1280, height: 800 }) {
  await page.setViewportSize(viewport);
  // The enable-browser-wallet prompt would cover the sidebar
  await page.addInitScript(() => sessionStorage.setItem('lcw_wallet_prompt_dismissed', 'true'));
  await page.goto('/#/login');
  await page.evaluate(async () => (await import('/tests/harness/shell.tsx')).show());
}

const feedbackLink = (page: Page) => page.locator('#shell-harness').getByRole('link', { name: /Share feedback/ });

test.describe('with a welcome page', () => {
  test.skip(!WELCOME_URL, 'start the dev server with VITE_WELCOME_URL to check the link');

  test('the sidebar links to the feedback page, in a new tab', async ({ page }) => {
    await showShell(page);
    const link = feedbackLink(page);
    await expect(link).toBeVisible();
    await expect(link).toHaveAccessibleName('Share feedback (opens in a new tab)');
    await expect(link).toHaveAttribute('href', feedbackPageUrl(WELCOME_URL)!);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  test('clicking it opens the feedback page and leaves the wallet open', async ({ page, context }) => {
    // Answers the feedback page here (it is not under test)
    let opened = '';
    await context.route(`${new URL(WELCOME_URL).origin}/**`, (route) => {
      // The page itself, not what the browser fetches for it (its icon)
      if (route.request().resourceType() === 'document') {
        opened = route.request().url();
      }
      return route.fulfill({ contentType: 'text/html', body: '<h1>Share feedback</h1>' });
    });
    await showShell(page);
    const [tab] = await Promise.all([context.waitForEvent('page'), feedbackLink(page).click()]);
    await expect(tab.getByRole('heading', { name: 'Share feedback' })).toBeVisible();
    expect(opened).toBe(feedbackPageUrl(WELCOME_URL));
    await expect(page.locator('#shell-harness').getByText('Page', { exact: true })).toBeVisible();
  });

  test('on a phone it is behind Menu, which folds once it is tapped', async ({ page, context }) => {
    await context.route(`${new URL(WELCOME_URL).origin}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Share feedback</h1>' })
    );
    await showShell(page, { width: 375, height: 740 });
    const link = feedbackLink(page);
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(link).toBeHidden();
    await menu.click();
    await expect(link).toBeVisible();
    await Promise.all([context.waitForEvent('page'), link.click()]);
    // Back in the wallet's tab, its page shows, not the open menu
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(link).toBeHidden();
  });
});

test.describe('without a welcome page', () => {
  test.skip(!!WELCOME_URL, 'start the dev server without VITE_WELCOME_URL to check there is no link');

  test('the sidebar has no feedback link', async ({ page }) => {
    await showShell(page);
    await expect(page.locator('#shell-harness').getByRole('link', { name: 'My Credentials' })).toBeVisible();
    // Not even as text: a link with no address isn't announced as a link
    await expect(page.locator('#shell-harness').getByText('Share feedback')).toHaveCount(0);
  });
});
