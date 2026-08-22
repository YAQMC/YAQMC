import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';
import { verifyFrontendDist } from './verify-frontend-dist.mjs';
import { verifyBinaryFile } from './verify-binary-arch.mjs';
import { sha256File, writeBuildInfo } from './write-build-info.mjs';
import { findCoreBinary, stageCore } from '../stage-core.mjs';
import { stripQaLaunchFlags } from '../qa-runtime.mjs';

export const ELECTRON_OUTPUT_DIR_NAME = 'release-electron';

export function parseElectronPackageArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    options[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

export function isElectronCoreCross({ os, arch }) {
  return os === 'windows' && arch === 'arm64';
}

export function cargoBuildArgs(target) {
  return ['build', '-p', 'yaqmc-core', '--release', '--locked', '--target', target];
}

export function electronBuilderArgs({ os, arch }) {
  const args = ['--projectDir', '.', '--config', 'electron-builder.yml'];
  if (os === 'windows') {
    args.push('--win', 'nsis', 'portable', `--${arch}`);
  } else if (os === 'linux') {
    args.push('--linux', 'AppImage', 'deb', 'rpm', 'tar.gz', `--${arch}`);
  } else {
    throw new Error(`unsupported Electron package OS ${os}`);
  }
  args.push('--publish', 'never');
  return args;
}

export function electronArtifactNames({ os, arch }) {
  if (os === 'windows') {
    return [`YAQMC-windows-${arch}-setup.exe`, `YAQMC-windows-${arch}-portable.exe`];
  }
  if (os === 'linux') {
    return [
      `YAQMC-linux-${arch}.AppImage`,
      `YAQMC-linux-${arch}.deb`,
      `YAQMC-linux-${arch}.rpm`,
      `YAQMC-linux-${arch}.tar.gz`,
    ];
  }
  throw new Error(`unsupported Electron package OS ${os}`);
}

export function planElectronPackage({ os, arch, target, cross }) {
  const resolvedCross = cross ?? isElectronCoreCross({ os, arch });
  return {
    cargo: ['cargo', ...cargoBuildArgs(target)],
    clientBuild: ['npm', 'run', 'build', '-w', '@yaqmc/client'],
    frontendBuild: ['npm', 'run', 'ci:frontend-build'],
    desktopBuild: ['npm', 'run', 'build', '-w', '@yaqmc/desktop'],
    stageCore: ['node', 'scripts/stage-core.mjs', '--profile', 'release', '--rust-target', target],
    electronBuilder: ['electron-builder', ...electronBuilderArgs({ os, arch })],
    publish: 'never',
    cross: resolvedCross,
    outputDir: ELECTRON_OUTPUT_DIR_NAME,
  };
}

export function writeElectronDistOverride(cross, directory = os.tmpdir()) {
  if (!cross) return null;
  const file = path.join(directory, 'yaqmc-electron-builder-cross.json');
  writeFileSync(file, `${JSON.stringify({ electronDist: null }, null, 2)}\n`);
  return file;
}

export function stageElectronArtifacts({
  repoRoot = repositoryRoot,
  os: platform,
  arch,
  sourceDir,
  buildInfo,
}) {
  const outputRoot = sourceDir ?? path.join(repoRoot, ELECTRON_OUTPUT_DIR_NAME);
  const destDir = path.join(outputRoot, `YAQMC-electron-${platform}-${arch}`);
  if (existsSync(destDir) && readdirSync(destDir).length > 0) {
    throw new Error(`refusing to overwrite non-empty Electron package directory ${destDir}`);
  }
  mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const name of electronArtifactNames({ os: platform, arch })) {
    const from = path.join(outputRoot, name);
    if (!existsSync(from)) {
      throw new Error(`missing Electron artifact ${from}`);
    }
    copyFileSync(from, path.join(destDir, name));
    copied.push(name);
    const blockmap = `${name}.blockmap`;
    if (existsSync(path.join(outputRoot, blockmap))) {
      copyFileSync(path.join(outputRoot, blockmap), path.join(destDir, blockmap));
      copied.push(blockmap);
    }
  }
  const metadata = platform === 'windows' ? ['latest.yml'] : ['latest-linux.yml'];
  for (const name of metadata) {
    const from = path.join(outputRoot, name);
    if (existsSync(from)) {
      copyFileSync(from, path.join(destDir, name));
      copied.push(name);
    }
  }
  if (buildInfo) {
    const buildInfoName = `build-info-${platform}-${arch}.json`;
    writeBuildInfo({
      ...buildInfo,
      outputPath: path.join(destDir, buildInfoName),
      os: platform,
      arch,
      files: copied.map((name) => ({
        name,
        sha256: sha256File(path.join(destDir, name)),
      })),
    });
    copied.push(buildInfoName);
  }
  const sums = copied.map((name) => `${sha256File(path.join(destDir, name))}  ${name}`).join('\n');
  writeFileSync(path.join(destDir, `SHA256SUMS-electron-${platform}-${arch}.txt`), `${sums}\n`);
  return destDir;
}

export function packagingEnvironment(env = process.env) {
  return stripQaLaunchFlags(env);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? packagingEnvironment(),
    encoding: 'utf8',
    shell: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}

function main() {
  const options = parseElectronPackageArgs(process.argv.slice(2));
  const osName = options.os;
  const arch = options.arch;
  const target = options.target;
  if (!osName || !arch || !target) {
    throw new Error('package-electron requires --os, --arch, and --target');
  }
  const cross = options.cross === 'true' || isElectronCoreCross({ os: osName, arch });
  const plan = planElectronPackage({ os: osName, arch, target, cross });
  const packageEnv = packagingEnvironment();

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const usePrebuiltFrontend = packageEnv.YAQMC_PREBUILT_FRONTEND === '1';
  if (usePrebuiltFrontend) {
    const info = verifyFrontendDist();
    process.stdout.write(`Using prebuilt frontend dist for ${info.gitSha}\n`);
  }

  run(plan.cargo[0], plan.cargo.slice(1), { env: packageEnv });
  const coreBinary = findCoreBinary({
    repoRoot: repositoryRoot,
    profile: 'release',
    rustTarget: target,
  });
  verifyBinaryFile(coreBinary, target);

  run(plan.clientBuild[0], plan.clientBuild.slice(1), { env: packageEnv });
  if (!usePrebuiltFrontend) {
    run(plan.frontendBuild[0], plan.frontendBuild.slice(1), { env: packageEnv });
    const info = verifyFrontendDist();
    process.stdout.write(`Built frontend dist for ${info.gitSha}\n`);
  }
  run(plan.desktopBuild[0], plan.desktopBuild.slice(1), { env: packageEnv });
  stageCore({ repoRoot: repositoryRoot, profile: 'release', rustTarget: target });

  const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
  const builderArgs = [...plan.electronBuilder.slice(1)];
  if (cross) {
    const override = writeElectronDistOverride(
      true,
      mkdtempSync(path.join(os.tmpdir(), 'yaqmc-eb-')),
    );
    builderArgs.splice(builderArgs.indexOf('--config') + 2, 0, '--config', override);
  }
  run('npx', ['electron-builder', ...builderArgs], { cwd: desktopRoot, env: packageEnv });

  const staged = stageElectronArtifacts({
    os: osName,
    arch,
    buildInfo: {
      target,
      profile: process.env.YAQMC_BUILD_PROFILE || 'ci-release',
      lto: process.env.CARGO_PROFILE_RELEASE_LTO || 'thin',
      codegenUnits: Number(process.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS || 8),
      bundles: electronArtifactNames({ os: osName, arch }),
    },
  });
  process.stdout.write(`Electron package complete: ${staged}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
