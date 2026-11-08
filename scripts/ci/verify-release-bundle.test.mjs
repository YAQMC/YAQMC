import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyReleaseBundle } from './verify-release-bundle.mjs';

function sandbox() {
  return mkdtempSync(path.join(os.tmpdir(), 'yaqmc-release-bundle-'));
}

test('accepts product renderer and desktop files', (t) => {
  const root = sandbox();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const renderer = path.join(root, 'renderer');
  const desktop = path.join(root, 'desktop');
  mkdirSync(path.join(renderer, 'artwork'), { recursive: true });
  mkdirSync(path.join(desktop, 'main'), { recursive: true });
  writeFileSync(path.join(renderer, 'index.html'), '<main>YAQMC</main>');
  writeFileSync(path.join(renderer, 'artwork', 'preset-preview.svg'), '<svg/>');
  writeFileSync(path.join(desktop, 'main', 'index.js'), 'export const app = true;');
  assert.equal(verifyReleaseBundle({ rendererDir: renderer, desktopDir: desktop }).length, 2);
});

test('rejects a renderer bundle that still ships the QA-only playback HUD', (t) => {
  const root = sandbox();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const renderer = path.join(root, 'renderer');
  mkdirSync(renderer, { recursive: true });
  writeFileSync(
    path.join(renderer, 'index.js'),
    'const node = document.createElement("div"); node.className = "fps-overlay";',
  );
  assert.throws(
    () => verifyReleaseBundle({ rendererDir: renderer }),
    (error) => {
      assert.match(String(error), /dev-only marker/u);
      return true;
    },
  );

  // The stylesheet may keep the class name; only executed JavaScript matters.
  writeFileSync(path.join(renderer, 'index.js'), 'export const app = true;');
  writeFileSync(path.join(renderer, 'app.css'), '.fps-overlay { color: red; }');
  assert.equal(verifyReleaseBundle({ rendererDir: renderer }).length, 1);
});

test('rejects fake markers, harness paths, and non-product artwork', (t) => {
  const root = sandbox();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const renderer = path.join(root, 'renderer');
  mkdirSync(path.join(renderer, 'harness'), { recursive: true });
  mkdirSync(path.join(renderer, 'artwork'), { recursive: true });
  writeFileSync(path.join(renderer, 'index.js'), 'globalThis.__YAQMC_E2E__ = {};');
  writeFileSync(path.join(renderer, 'harness', 'index.html'), 'test');
  writeFileSync(path.join(renderer, 'artwork', 'afterglow.svg'), '<svg/>');
  assert.throws(
    () => verifyReleaseBundle({ rendererDir: renderer }),
    (error) => {
      assert.match(String(error), /forbidden marker/u);
      assert.match(String(error), /test-only path/u);
      assert.match(String(error), /non-product artwork/u);
      return true;
    },
  );
});

test('production minification keeps the standard platform backdrop override', async (t) => {
  const root = sandbox();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'index.html'), '<link rel="stylesheet" href="./platform.css">');
  writeFileSync(
    path.join(root, 'platform.css'),
    readFileSync(new URL('../../src/styles/platform.css', import.meta.url)),
  );
  const { build } = await import('vite');
  const result = await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, cssMinify: 'lightningcss' },
  });
  const css = result.output.find((file) => file.type === 'asset' && file.fileName.endsWith('.css'));
  assert(css, 'production build must emit the platform stylesheet');
  const rules = String(css.source).matchAll(/([^{}]+)\{([^{}]*)\}/gu);
  const overrides = [...rules].filter((rule) => rule[1].includes('data-platform'));
  const topbar = overrides.find((rule) => rule[1].includes('.topbar'));
  const surfaces = overrides.find((rule) => rule[1].includes('.lyrics-fullscreen-transport__bar'));
  assert(topbar && surfaces, 'platform blur overrides must survive minification');
  for (const rule of [topbar, surfaces]) {
    assert.match(rule[2], /(?:^|;)backdrop-filter:none(?:;|$)/u);
  }
});
