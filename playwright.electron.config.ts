/**
 * FE-06 follow-up: Playwright `_electron` fake-mode (local only).
 *
 * `YAQMC_DESKTOP_SMOKE=1` is still not the target (harness + hidden window).
 * This suite launches the real Electron host with `YAQMC_ELECTRON_E2E=1` and
 * Vite `/?provider=fake`. Kill-core runs when a local `yaqmc-core` binary is
 * present. Tray click uses `YAQMC_E2E_TRAY=1` (show/hide + settings without
 * Core; play/pause/next/previous/quit need Core). Geometry persist (desktop +
 * island) and SUP-05 second-launch need Core plus the shared e2e userData.
 *
 * Maintainers: `npx playwright install chromium` is not required for this
 * driver. `npm run test:e2e:electron`.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/electron',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  expect: {
    timeout: 20_000,
  },
  globalSetup: './e2e/electron/global-setup.ts',
  use: {
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
