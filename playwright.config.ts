import { defineConfig, devices } from '@playwright/test';

/**
 * FE-06 fake-mode UI suite.
 *
 * `YAQMC_DESKTOP_SMOKE=1` boots a hidden ELEC-04 harness window and quits on
 * title `yaqmc-smoke-ok` — it does not load the renderer UI, so it is not a
 * Playwright target. This suite drives Vite `http://127.0.0.1:1420?provider=fake`.
 * Full Electron `_electron` window E2E (tray, core kill, geometry) is a follow-up.
 *
 * Browsers are not downloaded by `npm ci` (CI sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).
 * Maintainers: `npx playwright install chromium` then `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
