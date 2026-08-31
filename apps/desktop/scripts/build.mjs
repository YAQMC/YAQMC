import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseBundle } from '../../../scripts/ci/verify-release-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const qa = watch || process.argv.includes('--qa');

if (!watch) {
  rmSync(path.join(root, 'dist'), { recursive: true, force: true });
}

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
  const buildType = watch ? 'development' : qa ? 'qa' : 'release';
  return {
    __YAQMC_BUILD_COMMIT__: JSON.stringify(currentCommit()),
    __YAQMC_RELEASE_CHANNEL__: JSON.stringify(process.env.YAQMC_RELEASE_CHANNEL ?? 'development'),
    __YAQMC_BUILD_TYPE__: JSON.stringify(buildType),
    __YAQMC_QA_BUILD__: JSON.stringify(qa),
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
  minifySyntax: !qa,
  treeShaking: true,
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
    minifySyntax: !qa,
    treeShaking: true,
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
  if (!qa) {
    verifyReleaseBundle({ desktopDir: path.join(root, 'dist') });
    process.stdout.write('desktop release bundle clean\n');
  }
}
