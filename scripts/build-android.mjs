import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertAndroidReleaseTag, rootVersion } from './ci/android-version.mjs';
import { stageAndroidRelease } from './ci/stage-android-release.mjs';

export const ANDROID_NDK_VERSION = '28.2.13676358';
export const ANDROID_RELEASE_ABIS = Object.freeze(['arm64-v8a']);
export const ANDROID_DEBUG_ABIS = Object.freeze(['arm64-v8a', 'x86_64']);
export const ANDROID_JAVA_VERSION = 21;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(repositoryRoot, 'apps', 'android', 'android');
const nativeOutput = path.join(androidRoot, 'app', 'build', 'generated', 'jniLibs');

function parseArgs(argv) {
  const result = {
    variant: 'debug',
    buildWeb: true,
    buildNative: true,
    syncCapacitor: true,
    runGradle: true,
    qaBuild: false,
    tag: undefined,
    stageTo: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--skip-web') result.buildWeb = false;
    else if (name === '--skip-native') result.buildNative = false;
    else if (name === '--skip-sync') result.syncCapacitor = false;
    else if (name === '--skip-gradle') result.runGradle = false;
    else if (name === '--qa') result.qaBuild = true;
    else if (name === '--variant' || name === '--tag' || name === '--stage-to') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${name} requires a value`);
      if (name === '--variant') result.variant = value;
      if (name === '--tag') result.tag = value;
      if (name === '--stage-to') result.stageTo = value;
      index += 1;
    } else {
      throw new Error(`unknown Android build argument: ${name}`);
    }
  }
  if (result.variant !== 'debug' && result.variant !== 'release') {
    throw new Error(`Android build variant must be debug or release: ${result.variant}`);
  }
  if (result.qaBuild && result.variant === 'release') {
    throw new Error('--qa is forbidden for release builds');
  }
  return result;
}

export function androidSdkCandidates(environment = process.env, platform = process.platform) {
  const candidates = [environment.ANDROID_SDK_ROOT, environment.ANDROID_HOME];
  if (platform === 'win32' && environment.LOCALAPPDATA) {
    candidates.push(path.join(environment.LOCALAPPDATA, 'Android', 'Sdk'));
  } else if (platform === 'darwin' && environment.HOME) {
    candidates.push(path.join(environment.HOME, 'Library', 'Android', 'sdk'));
  } else if (environment.HOME) {
    candidates.push(path.join(environment.HOME, 'Android', 'Sdk'));
  }
  return [...new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

export function resolveAndroidToolchain(environment = process.env, platform = process.platform) {
  const sdk = androidSdkCandidates(environment, platform).find((candidate) =>
    existsSync(candidate),
  );
  if (!sdk) {
    throw new Error('Android SDK not found; set ANDROID_SDK_ROOT to the SDK 36 installation');
  }
  const explicitNdk = environment.ANDROID_NDK_HOME ?? environment.ANDROID_NDK_ROOT;
  const ndk = explicitNdk ? path.resolve(explicitNdk) : path.join(sdk, 'ndk', ANDROID_NDK_VERSION);
  if (!existsSync(ndk)) {
    throw new Error(`Android NDK ${ANDROID_NDK_VERSION} not found at ${ndk}`);
  }
  return { sdk, ndk };
}

function javaExecutableFromHome(home, platform) {
  return path.join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java');
}

export function androidJavaCandidates(environment = process.env, platform = process.platform) {
  const homes = [environment.YAQMC_JAVA_HOME];
  if (platform === 'win32') {
    if (environment.LOCALAPPDATA) {
      homes.push(path.join(environment.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr'));
    }
    if (environment.USERPROFILE) {
      const jdks = path.join(environment.USERPROFILE, '.jdks');
      if (existsSync(jdks)) {
        homes.push(
          ...readdirSync(jdks, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('jdk-21'))
            .map((entry) => path.join(jdks, entry.name)),
        );
      }
    }
  } else if (platform === 'darwin') {
    homes.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
  } else {
    homes.push('/opt/android-studio/jbr');
  }
  homes.push(environment.JAVA_HOME);
  return [
    ...new Set(
      homes
        .filter(Boolean)
        .map((home) => javaExecutableFromHome(path.resolve(home), platform))
        .filter((executable) => existsSync(executable)),
    ),
    'java',
  ];
}

function javaMajorVersion(executable, environment) {
  const result = spawnSync(executable, ['-version'], {
    env: environment,
    encoding: 'utf8',
  });
  if (result.status !== 0) return undefined;
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const match = output.match(/version\s+"(?:1\.)?(\d+)/u);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function resolveAndroidJava(environment = process.env, platform = process.platform) {
  for (const executable of androidJavaCandidates(environment, platform)) {
    if (javaMajorVersion(executable, environment) === ANDROID_JAVA_VERSION) {
      return executable;
    }
  }
  throw new Error(
    `JDK ${ANDROID_JAVA_VERSION} is required by Capacitor 8; set YAQMC_JAVA_HOME to a JDK ${ANDROID_JAVA_VERSION} installation`,
  );
}

export function cargoNdkArguments(variant, outputDirectory = nativeOutput) {
  const abis = variant === 'release' ? ANDROID_RELEASE_ABIS : ANDROID_DEBUG_ABIS;
  const args = ['ndk', '-P', '26'];
  for (const abi of abis) args.push('-t', abi);
  args.push('-o', outputDirectory, 'build', '--locked', '-p', 'yaqmc-android');
  if (variant === 'release') args.push('--release');
  return args;
}

export function rustlsVerifierMavenFromMetadata(metadata) {
  const verifier = metadata?.packages?.find(
    (candidate) => candidate.name === 'rustls-platform-verifier-android',
  );
  if (!verifier?.manifest_path) {
    throw new Error('rustls-platform-verifier-android is missing from Cargo metadata');
  }
  const repository = path.join(path.dirname(verifier.manifest_path), 'maven');
  if (!existsSync(repository)) {
    throw new Error(`rustls Android Maven repository is missing: ${repository}`);
  }
  return repository;
}

export function resolveRustlsVerifierMaven(environment = process.env) {
  const result = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('cargo metadata failed while locating the Android TLS verifier');
  }
  return rustlsVerifierMavenFromMetadata(JSON.parse(result.stdout));
}

export function gradleTask(variant) {
  return variant === 'release' ? ':app:assembleRelease' : ':app:assembleDebug';
}

function run(command, args, options = {}) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${String(result.status)}`);
  }
}

function requireReleaseSigning(environment) {
  for (const name of [
    'ANDROID_RELEASE_KEYSTORE',
    'ANDROID_RELEASE_KEY_ALIAS',
    'ANDROID_RELEASE_STORE_PASSWORD',
    'ANDROID_RELEASE_KEY_PASSWORD',
  ]) {
    if (!environment[name]?.trim())
      throw new Error(`${name} is required for Android release builds`);
  }
  if (!existsSync(path.resolve(environment.ANDROID_RELEASE_KEYSTORE))) {
    throw new Error('ANDROID_RELEASE_KEYSTORE does not point to a readable file');
  }
}

function buildWeb(environment, qaBuild) {
  run(process.execPath, [
    path.join('node_modules', 'typescript', 'bin', 'tsc'),
    '-b',
    '--pretty',
    'false',
  ]);
  run(
    process.execPath,
    [
      path.join('node_modules', 'vite', 'bin', 'vite.js'),
      'build',
      '--outDir',
      'dist-android',
      '--emptyOutDir',
    ],
    {
      env: {
        ...environment,
        YAQMC_TARGET_PLATFORM: 'android',
        YAQMC_QA_BUILD: qaBuild ? '1' : '0',
      },
    },
  );
  run(process.execPath, [
    path.join('scripts', 'ci', 'verify-release-bundle.mjs'),
    '--renderer',
    'dist-android',
  ]);
}

function syncCapacitor() {
  const cli = path.join(repositoryRoot, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
  if (!existsSync(cli)) throw new Error('Capacitor CLI is missing; run npm ci first');
  run(process.execPath, [cli, 'sync', 'android'], {
    cwd: path.join(repositoryRoot, 'apps', 'android'),
  });
}

function runGradle(variant, environment) {
  const wrapperJar = path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (!existsSync(wrapperJar)) throw new Error(`Gradle wrapper jar is missing: ${wrapperJar}`);
  run(
    resolveAndroidJava(environment),
    [
      '-classpath',
      wrapperJar,
      'org.gradle.wrapper.GradleWrapperMain',
      '--no-daemon',
      gradleTask(variant),
    ],
    { cwd: androidRoot, env: environment },
  );
}

export function expectedApkPath(variant) {
  return path.join(androidRoot, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
}

export function debugApkName(versionName) {
  return `YAQMC-${versionName}-android-debug.apk`;
}

export function defaultAndroidDebugDestination(environment = process.env) {
  if (environment.YAQMC_ANDROID_DEBUG_OUTPUT_DIR?.trim()) {
    return path.resolve(environment.YAQMC_ANDROID_DEBUG_OUTPUT_DIR.trim());
  }
  const userRoot = environment.USERPROFILE?.trim() || os.homedir();
  return path.join(userRoot, 'Downloads', 'YAQMC', 'Android', 'debug');
}

function stageAndroidDebug(apkPath, destination, versionName) {
  mkdirSync(destination, { recursive: true });
  const stagedApk = path.join(destination, debugApkName(versionName));
  copyFileSync(apkPath, stagedApk);
  return stagedApk;
}

export function buildAndroid(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv);
  const version = rootVersion(repositoryRoot);
  if (options.variant === 'release') {
    requireReleaseSigning(environment);
    if (options.tag) assertAndroidReleaseTag(version.versionName, options.tag);
  }

  const toolchain = resolveAndroidToolchain(environment);
  const rustlsVerifierMaven = resolveRustlsVerifierMaven(environment);
  const commitResult = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (commitResult.status !== 0 || !/^[0-9a-f]{40}$/u.test(commitResult.stdout.trim())) {
    throw new Error('unable to resolve the Android build commit');
  }
  const buildEnvironment = {
    ...environment,
    ANDROID_HOME: toolchain.sdk,
    ANDROID_SDK_ROOT: toolchain.sdk,
    ANDROID_NDK_HOME: toolchain.ndk,
    ANDROID_NDK_ROOT: toolchain.ndk,
    YAQMC_ANDROID_NATIVE_LIB_DIR: nativeOutput,
    YAQMC_VERSION_NAME: version.versionName,
    YAQMC_VERSION_CODE: String(version.versionCode),
    YAQMC_BUILD_COMMIT: commitResult.stdout.trim(),
    YAQMC_RUSTLS_VERIFIER_MAVEN_DIR: rustlsVerifierMaven,
  };

  if (options.buildWeb) buildWeb(buildEnvironment, options.qaBuild);
  if (options.buildNative) {
    const resolvedOutput = path.resolve(nativeOutput);
    const safeRoot = path.resolve(androidRoot, 'app', 'build');
    if (!resolvedOutput.startsWith(`${safeRoot}${path.sep}`)) {
      throw new Error(`refusing to clear native output outside ${safeRoot}`);
    }
    rmSync(resolvedOutput, { force: true, recursive: true });
    mkdirSync(resolvedOutput, { recursive: true });
    run('cargo', cargoNdkArguments(options.variant, resolvedOutput), {
      env: buildEnvironment,
    });
  }
  if (options.syncCapacitor) syncCapacitor();
  if (options.runGradle) runGradle(options.variant, buildEnvironment);

  const apkPath = expectedApkPath(options.variant);
  if (options.runGradle && !existsSync(apkPath)) {
    throw new Error(`Gradle completed without the expected APK: ${apkPath}`);
  }
  const stageDestination = options.stageTo
    ? path.resolve(repositoryRoot, options.stageTo)
    : options.variant === 'debug' && options.runGradle
      ? defaultAndroidDebugDestination(environment)
      : undefined;
  const stagedApkPath = stageDestination
    ? options.variant === 'release'
      ? stageAndroidRelease({
          apkPath,
          destination: stageDestination,
          version: version.versionName,
          commit: commitResult.stdout.trim(),
        }).stagedApk
      : stageAndroidDebug(apkPath, stageDestination, version.versionName)
    : undefined;
  return { apkPath, stagedApkPath, options, toolchain, version };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const result = buildAndroid();
    process.stdout.write(
      result.options.runGradle
        ? `Android ${result.options.variant} ${result.version.versionName} built at ${result.apkPath}${
            result.stagedApkPath ? ` and exported to ${result.stagedApkPath}` : ''
          }\n`
        : `Android ${result.options.variant} inputs prepared; Gradle assembly was skipped\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}${os.EOL}`);
    process.exitCode = 1;
  }
}
