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

const preloadEntries = [
  ['preload/main.ts', 'dist/preload/main.cjs'],
  ['preload/lyrics-surface.ts', 'dist/preload/lyrics-surface.cjs'],
  ['preload/unlock-overlay.ts', 'dist/preload/unlock-overlay.cjs'],
];

function preloadOptions(entryPoint, outfile) {
  return {
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  };
}

if (watch) {
  const mainCtx = await esbuild.context(mainOptions);
  await mainCtx.watch();
  for (const [entryPoint, outfile] of preloadEntries) {
    const preloadCtx = await esbuild.context(preloadOptions(entryPoint, outfile));
    await preloadCtx.watch();
  }
} else {
  await esbuild.build(mainOptions);
  for (const [entryPoint, outfile] of preloadEntries) {
    await esbuild.build(preloadOptions(entryPoint, outfile));
  }
}
