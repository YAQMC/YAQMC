import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugins = [
  'style-sakura',
  'style-night',
  'scene-pack',
  'script-now-playing',
  'script-actions',
  'script-network',
  'studio',
  'ink-core',
  'ink-accent',
];

let failed = false;
for (const directory of plugins) {
  const manifestPath = path.join(root, 'examples', 'plugins', directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.manifestVersion !== 1) {
    process.stderr.write(`${directory}: manifestVersion must stay 1\n`);
    failed = true;
  }
  if (manifest.apiVersion !== 1 && manifest.apiVersion !== 2) {
    process.stderr.write(`${directory}: apiVersion must be 1 or 2\n`);
    failed = true;
  }
  if (manifest.permissions?.includes('network') || manifest.permissions?.includes('network:*')) {
    process.stderr.write(`${directory}: wildcard network is not allowed\n`);
    failed = true;
  }
  if (manifest.entrypoints?.html) {
    process.stderr.write(`${directory}: HTML entrypoints are not allowed\n`);
    failed = true;
  }
  process.stdout.write(`ok ${manifest.id} api=${manifest.apiVersion}\n`);
}
if (failed) process.exit(1);
