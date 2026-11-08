// Verifies a staged macOS package on a macOS runner:
//   node scripts/ci/verify-macos-package.mjs --dir release-electron/YAQMC-electron-macos-arm64 \
//     --arch arm64 --signed false
// Checks the dmg/zip exist, the app's main executable and the bundled Core sidecar are thin
// Mach-O for the expected architecture, the bundle passes `codesign --verify --deep --strict`,
// and the signature matches the build mode: ad-hoc for unsigned builds, or a Developer ID with
// a Team ID that Gatekeeper accepts and whose notarization ticket is stapled for signed builds.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreSha256 } from '../../apps/desktop/main/core/core-hash.js';
import { inspectBinaryArchitecture } from './verify-binary-arch.mjs';

const MACHO_ARCH = { x64: 'x86_64', arm64: 'aarch64' };

/** Parses `codesign -dv --verbose=2` (written to stderr) into the fields we gate on. */
export function parseCodesignDetails(text) {
  const field = (name) => text.match(new RegExp(`^${name}=(.*)$`, 'mu'))?.[1]?.trim() ?? null;
  const authorities = [...text.matchAll(/^Authority=(.*)$/gmu)].map((match) => match[1].trim());
  const team = field('TeamIdentifier');
  return {
    identifier: field('Identifier'),
    adhoc: /^Signature=adhoc$/mu.test(text) || /flags=0x[0-9a-f]*\(adhoc/u.test(text),
    teamIdentifier: team && team !== 'not set' ? team : null,
    developerId: authorities.some((authority) => authority.startsWith('Developer ID Application:')),
    hardenedRuntime: /flags=0x[0-9a-f]*\([^)]*runtime/u.test(text),
  };
}

/** Pure policy so the decision is unit-testable off macOS. Returns a list of problems. */
export function signaturePolicyProblems(details, { signed }) {
  const problems = [];
  if (details.identifier !== 'org.yaqmc.desktop') {
    problems.push(`unexpected bundle identifier ${details.identifier}`);
  }
  if (signed) {
    if (details.adhoc) problems.push('signed build carries an ad-hoc signature');
    if (!details.developerId)
      problems.push('signed build is not signed by a Developer ID Application');
    if (!details.teamIdentifier) problems.push('signed build has no Team ID');
    if (!details.hardenedRuntime) problems.push('signed build is missing the hardened runtime');
  } else if (!details.adhoc) {
    problems.push('unsigned build must be ad-hoc signed so Apple silicon can launch it');
  }
  return problems;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runStderr(command, args) {
  try {
    execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${error.stderr || error.message}`, {
      cause: error,
    });
  }
}

export function codesignDetails(appPath, execute = spawnSync) {
  // codesign prints details on stderr even on success.
  const result = execute('codesign', ['-dv', '--verbose=2', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `codesign -dv failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`,
      {
        cause: result.error,
      },
    );
  }
  return result.stderr;
}

export function verifyCoreManifest(resourcesPath) {
  const coreDir = path.join(resourcesPath, 'core');
  const manifest = JSON.parse(readFileSync(path.join(coreDir, 'manifest.json'), 'utf8'));
  if (
    manifest.name !== 'yaqmc-core' ||
    typeof manifest.sha256 !== 'string' ||
    typeof manifest.hashMode !== 'string'
  ) {
    throw new Error('packaged Core manifest is incomplete');
  }
  const actual = coreSha256(readFileSync(path.join(coreDir, manifest.name)), manifest.hashMode);
  if (actual !== manifest.sha256) {
    throw new Error(`packaged Core hash mismatch: expected ${manifest.sha256}, found ${actual}`);
  }
  return manifest;
}

function verify({ dir, arch, signed }) {
  const expected = MACHO_ARCH[arch];
  if (!expected) throw new Error(`unsupported macOS arch ${arch}`);
  for (const name of [`YAQMC-macos-${arch}.dmg`, `YAQMC-macos-${arch}.zip`]) {
    if (!existsSync(path.join(dir, name))) throw new Error(`missing ${name}`);
  }
  const extracted = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-macos-verify-'));
  // ditto preserves the bundle's symlinks, extended attributes and signatures.
  run('ditto', ['-x', '-k', path.join(dir, `YAQMC-macos-${arch}.zip`), extracted]);
  const app = readdirSync(extracted).find((name) => name.endsWith('.app'));
  if (!app) throw new Error('zip does not contain an .app bundle');
  const appPath = path.join(extracted, app);

  for (const binary of [
    path.join(appPath, 'Contents', 'MacOS', 'YAQMC'),
    path.join(appPath, 'Contents', 'Resources', 'core', 'yaqmc-core'),
  ]) {
    const actual = inspectBinaryArchitecture(readFileSync(binary));
    if (actual.format !== 'macho' || actual.arch !== expected) {
      throw new Error(`${binary} is ${actual.format}/${actual.arch}, expected macho/${expected}`);
    }
  }
  verifyCoreManifest(path.join(appPath, 'Contents', 'Resources'));

  runStderr('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const details = parseCodesignDetails(codesignDetails(appPath));
  const problems = signaturePolicyProblems(details, { signed });
  if (problems.length) throw new Error(problems.join('; '));
  if (signed) {
    runStderr('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);
    runStderr('xcrun', ['stapler', 'validate', appPath]);
  }
  process.stdout.write(
    `Verified ${app} (${arch}, ${signed ? `Developer ID ${details.teamIdentifier}, notarized` : 'ad-hoc'})\n`,
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const signed = option('signed');
  if (!option('dir') || !option('arch') || (signed !== 'true' && signed !== 'false')) {
    throw new Error(
      'usage: verify-macos-package.mjs --dir <dir> --arch <x64|arm64> --signed <true|false>',
    );
  }
  verify({ dir: option('dir'), arch: option('arch'), signed: signed === 'true' });
}
