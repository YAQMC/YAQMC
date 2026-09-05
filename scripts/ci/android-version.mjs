import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NUMBER = '(?:0|[1-9]\\d*)';
const RELEASE_VERSION = new RegExp(
  `^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(alpha|beta|rc)\\.(${NUMBER}))?$`,
  'u',
);
const STAGE = Object.freeze({ alpha: 1, beta: 2, rc: 3, stable: 9 });

export function androidVersion(version) {
  if (typeof version !== 'string') throw new Error('Android version must be a string');
  const match = RELEASE_VERSION.exec(version);
  if (!match) {
    throw new Error(
      `Android release version must be x.y.z, x.y.z-alpha.n, x.y.z-beta.n, or x.y.z-rc.n: ${version}`,
    );
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const channel = match[4] ?? 'stable';
  const serial = match[5] === undefined ? 0 : Number(match[5]);
  if (major > 20 || minor > 99 || patch > 99 || serial > 999) {
    throw new Error(`Android release version exceeds versionCode component bounds: ${version}`);
  }
  const versionCode =
    major * 100_000_000 + minor * 1_000_000 + patch * 10_000 + STAGE[channel] * 1_000 + serial;
  if (versionCode > 2_100_000_000) {
    throw new Error(`Android versionCode exceeds the supported maximum: ${versionCode}`);
  }
  return { versionName: version, versionCode };
}

export function assertAndroidReleaseTag(version, tag) {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`release tag ${tag} does not match canonical version ${expected}`);
  }
  return expected;
}

export function rootVersion(repoRoot = repositoryRoot) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return androidVersion(packageJson.version);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) continue;
    options[name.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const resolved = options.version ? androidVersion(options.version) : rootVersion();
  if (options.tag) assertAndroidReleaseTag(resolved.versionName, options.tag);
  if (options.format === 'github-output') {
    process.stdout.write(
      `version_name=${resolved.versionName}\nversion_code=${resolved.versionCode}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(resolved)}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
