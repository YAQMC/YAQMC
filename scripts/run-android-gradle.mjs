import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  resolveAndroidJava,
  resolveAndroidToolchain,
  resolveRustlsVerifierMaven,
} from './build-android.mjs';
import { rootVersion } from './ci/android-version.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = path.join(repositoryRoot, 'apps', 'android', 'android');
const tasks = process.argv.slice(2);

if (tasks.length === 0 || tasks.some((task) => !/^:[a-zA-Z0-9:_-]+$/u.test(task))) {
  throw new Error('one or more explicit Gradle task paths are required');
}

const toolchain = resolveAndroidToolchain();
const version = rootVersion(repositoryRoot);
const commit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).stdout.trim();
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('unable to resolve the build commit');

const environment = {
  ...process.env,
  ANDROID_HOME: toolchain.sdk,
  ANDROID_SDK_ROOT: toolchain.sdk,
  ANDROID_NDK_HOME: toolchain.ndk,
  ANDROID_NDK_ROOT: toolchain.ndk,
  YAQMC_VERSION_NAME: version.versionName,
  YAQMC_VERSION_CODE: String(version.versionCode),
  YAQMC_BUILD_COMMIT: commit,
  YAQMC_RUSTLS_VERIFIER_MAVEN_DIR: resolveRustlsVerifierMaven(),
};
const wrapperJar = path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
const result = spawnSync(
  resolveAndroidJava(environment),
  ['-classpath', wrapperJar, 'org.gradle.wrapper.GradleWrapperMain', '--no-daemon', ...tasks],
  {
    cwd: androidRoot,
    env: environment,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
