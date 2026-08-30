import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleRoot = path.join(root, 'examples', 'plugins', 'provider-catalog-rust');
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

const source = path.join(
  exampleRoot,
  'target',
  target,
  'release',
  'yaqmc_provider_catalog_example.wasm',
);
const destination = path.join(exampleRoot, 'component', 'provider.wasm');
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
process.stdout.write(`built ${path.relative(root, destination)}\n`);
