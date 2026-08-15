import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './repo.mjs';
import { sha256File } from './write-build-info.mjs';
import { verifyBinaryFile } from './verify-binary-arch.mjs';
import { verifyFrontendDist } from './verify-frontend-dist.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    options[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function runTauri(args) {
  const started = Date.now();
  const result = spawnSync('npm', ['run', 'tauri', '--', ...args], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    shell: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(`tauri ${args.join(' ')} failed with exit ${result.status}`);
  }
  return {
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function findBinary(target, os) {
  const name = os === 'windows' ? 'yaqmc.exe' : 'yaqmc';
  const candidates = [
    path.join(repositoryRoot, 'src-tauri', 'target', target, 'release', name),
    path.join(repositoryRoot, 'src-tauri', 'target', 'release', name),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`built binary not found for ${target}`);
  return found;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = options.target;
  const os = options.os;
  const arch = options.arch || target;
  const bundles = options.bundles || '';
  if (!target || !os) throw new Error('package-native requires --target and --os');

  if (process.env.YAQMC_PREBUILT_FRONTEND === '1') {
    const info = verifyFrontendDist();
    process.stdout.write(`Using prebuilt frontend dist for ${info.gitSha}\n`);
  }

  const build = runTauri(['build', '--target', target, '--no-bundle', '--ci', '--no-sign']);
  const binary = findBinary(target, os);
  verifyBinaryFile(binary, target);
  const beforeHash = sha256File(binary);
  const beforeMtime = statSync(binary).mtimeMs;

  const timings = {
    target,
    os,
    arch,
    binary,
    nativeBuildSeconds: build.seconds,
    nativeCompiledYaQmc: /Compiling yaqmc/u.test(build.output),
    bundleSeconds: 0,
    bundleCompiledYaQmc: false,
    binaryReused: true,
  };

  if (bundles) {
    const bundle = runTauri([
      'bundle',
      '--target',
      target,
      '--bundles',
      bundles,
      '--ci',
      '--no-sign',
    ]);
    timings.bundleSeconds = bundle.seconds;
    timings.bundleCompiledYaQmc = /Compiling yaqmc/u.test(bundle.output);
    const afterHash = sha256File(binary);
    timings.binaryReused = afterHash === beforeHash && statSync(binary).mtimeMs === beforeMtime;
    if (timings.bundleCompiledYaQmc) {
      process.stderr.write(
        `warning: tauri bundle compiled yaqmc again for ${target}; native reuse did not hold\n`,
      );
    }
  }

  const releaseDir = path.join(repositoryRoot, 'release');
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(
    path.join(releaseDir, `timings-${os}-${arch}.json`),
    `${JSON.stringify(timings, null, 2)}\n`,
  );
  process.stdout.write(`Native package complete: ${binary}\n`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
