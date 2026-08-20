/**
 * ACC-02 DWM / transparency CSS probe against a live Electron CDP port.
 * Does not sign the HUMAN DWM cell. Isolated from ACC-04 profile logic:
 * pass YAQMC_ACC02_CDP (default 9232 = daily-driver).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { assertProductionAttachAllowed } from '../qa-runtime.mjs';

assertProductionAttachAllowed(process.env, 'ACC-02 DWM CSS probe');

const port = Number(process.env.YAQMC_ACC02_CDP || 9232);
mkdirSync('output', { recursive: true });
const outPng = path.resolve('output', 'acc02-dwm-daily-driver.png');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`);
const page =
  browser.contexts().flatMap((context) => context.pages()).find((item) => {
    const url = item.url();
    return url.includes('127.0.0.1:1420') && !url.includes('surface=') && !url.includes('unlockSurface=');
  }) ?? browser.contexts().flatMap((context) => context.pages())[0];
if (!page) throw new Error(`no page on CDP ${String(port)}`);

const css = await page.evaluate(() => {
  const shell = document.querySelector('.app-shell');
  const topbar = document.querySelector('.topbar, [data-topbar], header');
  const art = document.querySelector('.player-bar img, .now-playing img, img');
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const pick = (style) =>
    style
      ? {
          backgroundColor: style.backgroundColor,
          backdropFilter: style.backdropFilter,
          filter: style.filter,
        }
      : null;
  return {
    url: location.href,
    platform: document.documentElement.getAttribute('data-platform'),
    shell: pick(cs(shell)),
    topbar: pick(cs(topbar)),
    artwork: pick(cs(art)),
  };
});

await page.screenshot({ path: outPng, fullPage: false });
const report = {
  capturedAt: new Date().toISOString(),
  cdp: port,
  screenshot: outPng,
  css,
  note: 'AUTO CSS + screenshot. Not a signed §30 DWM HUMAN cell.',
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join('output', 'acc02-dwm-css.json'), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
