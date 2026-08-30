import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builds = {
  example: {
    root: path.join(root, 'examples', 'plugins', 'provider-catalog-rust'),
    artifact: 'yaqmc_provider_catalog_example.wasm',
    destination: path.join(
      root,
      'examples',
      'plugins',
      'provider-catalog-rust',
      'component',
      'provider.wasm',
    ),
  },
  'host-fixture': {
    root: path.join(root, 'crates', 'yaqmc-core', 'tests', 'fixtures', 'component-host-guest'),
    artifact: 'yaqmc_component_host_guest.wasm',
    destination: path.join(
      root,
      'crates',
      'yaqmc-core',
      'tests',
      'fixtures',
      'component-host-guest.wasm',
    ),
  },
};
const build = builds[process.argv[2] ?? 'example'];
if (!build) throw new Error('unknown Provider Component build target');
const exampleRoot = build.root;
const manifestPath = path.join(exampleRoot, 'Cargo.toml');
const target = 'wasm32-wasip2';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

await run('cargo', [
  'build',
  '--locked',
  '--release',
  '--target',
  target,
  '--manifest-path',
  manifestPath,
]);

const source = path.join(exampleRoot, 'target', target, 'release', build.artifact);
const destination = build.destination;
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
process.stdout.write(`built ${path.relative(root, destination)}\n`);
