import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VITE_DEV_ORIGIN, waitForFakeShell } from '../fake-ui';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const electronBinary = createRequire(path.join(desktopRoot, 'package.json'))('electron') as string;

function electronEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'YAQMC_DESKTOP_SMOKE') {
      env[key] = value;
    }
  }
  env.YAQMC_ELECTRON_E2E = '1';
  env.YAQMC_VITE_DEV = '1';
  env.ELECTRON_DISABLE_GPU = '1';
  return env;
}

export async function launchElectronFakeWindow(): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ['.', '--lang=en-US'],
    cwd: desktopRoot,
    env: electronEnv(),
    timeout: 60_000,
    chromiumSandbox: true,
    locale: 'en-US',
  });
  const page = await app.firstWindow();
  await waitForFakeShell(page);
  await page.goto(`${VITE_DEV_ORIGIN}/?provider=fake`);
  await waitForFakeShell(page);
  return { app, page };
}
