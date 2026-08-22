import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

function currentCommit() {
  const environmentCommit = process.env.GITHUB_SHA ?? process.env.VITE_GIT_COMMIT;
  if (environmentCommit) return environmentCommit;
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function buildDefines() {
  return {
    __YAQMC_BUILD_COMMIT__: JSON.stringify(currentCommit()),
    __YAQMC_RELEASE_CHANNEL__: JSON.stringify(process.env.YAQMC_RELEASE_CHANNEL ?? 'development'),
    __YAQMC_BUILD_TYPE__: JSON.stringify(watch ? 'development' : 'release'),
  };
}

const mainOptions = {
  absWorkingDir: root,
  entryPoints: ['main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/main/index.js',
  external: ['electron', 'electron-updater'],
  sourcemap: true,
  logLevel: 'info',
  define: buildDefines(),
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
    define: buildDefines(),
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
