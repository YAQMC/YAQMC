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
const providerPlugins = [
  {
    directory: 'provider-catalog-rust',
    world: 'provider',
    capabilities: ['provider.catalog'],
    permissions: ['provider.catalog'],
  },
  {
    directory: 'provider-platform-rust',
    world: 'provider-account',
    capabilities: [
      'provider.catalog',
      'provider.playback',
      'provider.recommendation',
      'provider.lyrics',
      'provider.account',
    ],
    permissions: [
      'provider.catalog',
      'provider.playback',
      'provider.recommendation',
      'provider.lyrics',
      'provider.account',
      'plugin.storage',
      'network:https://accounts.example.com',
    ],
  },
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

for (const expected of providerPlugins) {
  const { directory } = expected;
  const manifestPath = path.join(root, 'examples', 'plugins', directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.manifestVersion !== 2 || manifest.apiVersion !== 3) {
    process.stderr.write(`${directory}: Provider Components require manifest v2 / API v3\n`);
    failed = true;
  }
  if (
    manifest.provider?.world !== expected.world ||
    manifest.provider?.witVersion !== '0.1.0' ||
    JSON.stringify(manifest.provider?.capabilities) !== JSON.stringify(expected.capabilities)
  ) {
    process.stderr.write(`${directory}: frozen provider WIT declaration is missing\n`);
    failed = true;
  }
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(expected.permissions)) {
    process.stderr.write(
      `${directory}: capability permissions do not match the example contract\n`,
    );
    failed = true;
  }
  if (
    manifest.permissions?.some(
      (permission) =>
        permission === 'network' || permission === 'network:*' || permission.includes('*'),
    )
  ) {
    process.stderr.write(`${directory}: wildcard network access is not allowed\n`);
    failed = true;
  }
  if (manifest.entrypoints?.component !== 'component/provider.wasm') {
    process.stderr.write(`${directory}: component entrypoint is not canonical\n`);
    failed = true;
  }
  process.stdout.write(`ok ${manifest.id} api=${manifest.apiVersion}\n`);
}
if (failed) process.exit(1);
