import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const mainOptions = {
  absWorkingDir: root,
  entryPoints: ['main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/main/index.js',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

const preloadOptions = {
  absWorkingDir: root,
  entryPoints: ['preload/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/preload/main.cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const mainCtx = await esbuild.context(mainOptions);
  const preloadCtx = await esbuild.context(preloadOptions);
  await mainCtx.watch();
  await preloadCtx.watch();
} else {
  await esbuild.build(mainOptions);
  await esbuild.build(preloadOptions);
}
