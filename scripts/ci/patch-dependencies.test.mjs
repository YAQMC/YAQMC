import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { patchAmll, patchSource } from '../patch-dependencies.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const installed = path.join(repositoryRoot, 'node_modules', '@applemusic-like-lyrics', 'core');

test('patches original anchors and does not apply the modification twice', () => {
  const original = [
    '\tgenerateWebAnimationBasedMaskImage() {\n\t}\n',
    '\tasync enable(maskAnimationTime = this.lyricPlayer.getCurrentTime(), shouldPlay = this.lyricPlayer.getIsPlaying()) {\n\t\tthis.isEnabled = true;\n\t}\n',
    '\tdisposeElements() {\n\t}\n',
  ].join('');
  const patched = patchSource(original);
  assert.notEqual(patched, original);
  assert.match(patched, /mainElement\.style\.opacity = "var\(--dark-mask-alpha, 1\)"/);
  assert.match(patched, /this\.maskAnimated = true/);
  assert.match(patched, /this\.maskAnimated = false/);
  assert.equal(patchSource(patched), patched);
});

function copyInstalled(version) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-amll-'));
  const target = path.join(root, 'node_modules', '@applemusic-like-lyrics', 'core');
  mkdirSync(path.join(target, 'dist'), { recursive: true });
  for (const file of ['amll-core.mjs', 'amll-core.cjs']) {
    cpSync(path.join(installed, 'dist', file), path.join(target, 'dist', file));
  }
  writeFileSync(path.join(target, 'package.json'), JSON.stringify({ version }));
  return { root, target };
}

test('patches both AMLL builds once and keeps them parseable', () => {
  const { root, target } = copyInstalled('0.5.2');
  const pristine = readFileSync(path.join(installed, 'dist', 'amll-core.cjs'), 'utf8');
  // The installed copy may already be patched by postinstall; compare against a re-patch.
  assert.equal(patchAmll(root), 'patched');
  const once = readFileSync(path.join(target, 'dist', 'amll-core.cjs'), 'utf8');
  assert.equal(patchAmll(root), 'patched');
  assert.equal(readFileSync(path.join(target, 'dist', 'amll-core.cjs'), 'utf8'), once);
  assert.equal(once.split('yaqmc-patch: amll-inactive-line-opacity').length - 1, 1);
  assert.equal(patchSource(pristine), once);
  new vm.Script(`(function (exports, require, module) {${once}\n})`);
  assert.match(
    readFileSync(path.join(target, 'dist', 'amll-core.mjs'), 'utf8'),
    /maskAnimated = true/,
  );
});

test('leaves other AMLL versions alone and rejects unknown builds', () => {
  const { root, target } = copyInstalled('0.6.0');
  const before = readFileSync(path.join(target, 'dist', 'amll-core.mjs'), 'utf8');
  assert.equal(patchAmll(root), 'skipped');
  assert.equal(readFileSync(path.join(target, 'dist', 'amll-core.mjs'), 'utf8'), before);
  assert.throws(() => patchSource('class X {}'), /anchor matched 0 times/);
});
