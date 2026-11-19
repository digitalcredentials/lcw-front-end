import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // With DEPLOYED_URL set, the tests against a deployed wallet run on an
  // account made before the first test and deleted after the last
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'Chromium', use: { ...devices['Desktop Chrome'] } }],
  // Starts the Vite dev server, or reuses one already running on 5173
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
