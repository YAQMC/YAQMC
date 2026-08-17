import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/main/index.js',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['preload/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/preload/main.cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
