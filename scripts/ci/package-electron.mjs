import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';
import { verifyFrontendDist } from './verify-frontend-dist.mjs';
import { verifyBinaryFile } from './verify-binary-arch.mjs';
import { sha256File, writeBuildInfo } from './write-build-info.mjs';
import { findCoreBinary, stageCore } from '../stage-core.mjs';
import { stripQaLaunchFlags } from '../qa-runtime.mjs';
import { stageUpdateHelper } from '../stage-update-helper.mjs';
import { writeAppUpdateMetadata } from './app-update-metadata.mjs';

export const ELECTRON_OUTPUT_DIR_NAME = 'release-electron';
export const ELECTRON_RELEASE_CONFIG = 'electron-builder.release.yml';
export const WINDOWS_SIGNING_ENV_KEYS = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
/** Developer ID certificate plus App Store Connect API key used for notarization. */
export const MACOS_SIGNING_ENV_KEYS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];
export const SIGNABLE_ELECTRON_OSES = ['windows', 'macos'];

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

export function isElectronCoreCross({ os, arch, hostArch = process.arch }) {
  return (os === 'windows' && arch === 'arm64') || (os === 'macos' && arch !== hostArch);
}

export function cargoBuildArgs(target) {
  return ['build', '-p', 'yaqmc-core', '--release', '--locked', '--target', target];
}

export function electronBuilderArgs({ os, arch, requireSigning = false }) {
  const args = [
    '--projectDir',
    '.',
    '--config',
    requireSigning ? ELECTRON_RELEASE_CONFIG : 'electron-builder.yml',
  ];
  if (requireSigning && !SIGNABLE_ELECTRON_OSES.includes(os)) {
    throw new Error('release signing is supported only for Windows and macOS packages');
  }
  if (os === 'windows') {
    if (!requireSigning) {
      args.push('--config.forceCodeSigning=false', '--config.win.verifyUpdateCodeSignature=false');
    }
    args.push('--win', 'nsis', 'portable', `--${arch}`);
  } else if (os === 'linux') {
    // electron-builder expands ${arch} using each Linux target's native label
    // (x86_64 for AppImage/RPM, amd64 for deb). Keep the public artifact
    // contract stable by supplying our canonical x64/arm64 label explicitly.
    args.push(
      `--config.linux.artifactName=YAQMC-linux-${arch}.\${ext}`,
      '--linux',
      'AppImage',
      'deb',
      'rpm',
      'tar.gz',
      `--${arch}`,
    );
  } else if (os === 'macos') {
    if (!requireSigning) {
      // Unsigned builds are ad-hoc signed: Apple silicon refuses to launch code with no
      // signature, and flipping Electron fuses invalidates Electron's own one. Hardened
      // runtime is only meaningful with a Developer ID, and with an ad-hoc identity it
      // would reject the differently-signed Electron frameworks at launch.
      args.push(
        '--config.mac.identity=-',
        '--config.mac.hardenedRuntime=false',
        '--config.mac.notarize=false',
      );
    }
    args.push('--mac', 'dmg', 'zip', `--${arch}`);
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
  if (os === 'macos') {
    return [`YAQMC-macos-${arch}.dmg`, `YAQMC-macos-${arch}.zip`];
  }
  throw new Error(`unsupported Electron package OS ${os}`);
}

export function planElectronPackage({ os, arch, target, cross, requireSigning = false }) {
  const resolvedCross = cross ?? isElectronCoreCross({ os, arch });
  return {
    cargo: ['cargo', ...cargoBuildArgs(target)],
    helperBuild: [
      'cargo',
      'build',
      '-p',
      'yaqmc-update-helper',
      '--release',
      '--locked',
      '--target',
      target,
    ],
    clientBuild: ['npm', 'run', 'build', '-w', '@yaqmc/client'],
    frontendBuild: ['npm', 'run', 'ci:frontend-build'],
    desktopBuild: ['npm', 'run', 'build', '-w', '@yaqmc/desktop'],
    stageCore: ['node', 'scripts/stage-core.mjs', '--profile', 'release', '--rust-target', target],
    electronBuilder: ['electron-builder', ...electronBuilderArgs({ os, arch, requireSigning })],
    publish: 'never',
    signingRequired: requireSigning,
    cross: resolvedCross,
    outputDir: ELECTRON_OUTPUT_DIR_NAME,
  };
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
  // macOS has no in-place updater (see installDisabledReason), so no feed is staged for it.
  const metadata =
    platform === 'windows' ? ['latest.yml'] : platform === 'linux' ? ['latest-linux.yml'] : [];
  for (const name of metadata) {
    const from = path.join(outputRoot, name);
    if (existsSync(from)) {
      copyFileSync(from, path.join(destDir, name));
      copied.push(name);
    }
  }
  if (buildInfo) {
    if (platform === 'windows') {
      const version = JSON.parse(
        readFileSync(path.join(repoRoot, 'apps/desktop/package.json'), 'utf8'),
      ).version;
      copied.push(writeAppUpdateMetadata(destDir, version, arch));
    }
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
  const sanitized = stripQaLaunchFlags(env);
  // Actions supplies empty strings for optional signing secrets. electron-builder
  // treats an empty CSC_LINK as a path relative to the project directory.
  for (const key of [...WINDOWS_SIGNING_ENV_KEYS, ...MACOS_SIGNING_ENV_KEYS]) {
    if (typeof sanitized[key] === 'string' && !sanitized[key].trim()) delete sanitized[key];
  }
  return sanitized;
}

export function packagingBuildEnvironment(env = process.env) {
  const sanitized = { ...packagingEnvironment(env) };
  for (const key of [...WINDOWS_SIGNING_ENV_KEYS, ...MACOS_SIGNING_ENV_KEYS]) {
    delete sanitized[key];
  }
  return sanitized;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? packagingEnvironment(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
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
  const requireSigning = options['require-signing'] === 'true';
  if (
    options['require-signing'] !== undefined &&
    options['require-signing'] !== 'true' &&
    options['require-signing'] !== 'false'
  ) {
    throw new Error('package-electron --require-signing must be true or false');
  }
  const plan = planElectronPackage({
    os: osName,
    arch,
    target,
    cross,
    requireSigning,
  });
  const packageEnv = packagingEnvironment();
  const buildEnv = packagingBuildEnvironment(packageEnv);
  buildEnv.YAQMC_PACKAGE_ARCH = arch;

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const usePrebuiltFrontend = packageEnv.YAQMC_PREBUILT_FRONTEND === '1';
  if (usePrebuiltFrontend) {
    const info = verifyFrontendDist();
    process.stdout.write(`Using prebuilt frontend dist for ${info.gitSha}\n`);
  }

  run(plan.cargo[0], plan.cargo.slice(1), { env: buildEnv });
  run(plan.helperBuild[0], plan.helperBuild.slice(1), { env: buildEnv });
  stageUpdateHelper({ repoRoot: repositoryRoot, env: buildEnv, rustTarget: target });
  const coreBinary = findCoreBinary({
    repoRoot: repositoryRoot,
    profile: 'release',
    rustTarget: target,
  });
  verifyBinaryFile(coreBinary, target);

  run(plan.clientBuild[0], plan.clientBuild.slice(1), { env: buildEnv });
  if (!usePrebuiltFrontend) {
    run(plan.frontendBuild[0], plan.frontendBuild.slice(1), { env: buildEnv });
    const info = verifyFrontendDist();
    process.stdout.write(`Built frontend dist for ${info.gitSha}\n`);
  }
  run(plan.desktopBuild[0], plan.desktopBuild.slice(1), { env: buildEnv });
  stageCore({ repoRoot: repositoryRoot, profile: 'release', rustTarget: target });

  const desktopRoot = path.join(repositoryRoot, 'apps', 'desktop');
  run('npx', ['electron-builder', ...plan.electronBuilder.slice(1)], {
    cwd: desktopRoot,
    env: packageEnv,
  });

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
