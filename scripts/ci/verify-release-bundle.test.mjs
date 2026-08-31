import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
