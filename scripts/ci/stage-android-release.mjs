import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { androidVersion } from './android-version.mjs';

export const ANDROID_APPLICATION_ID = 'org.yaqmc.android';
export const ANDROID_RELEASE_ABI = 'arm64-v8a';
export const ANDROID_MIN_SDK = 26;
export const ANDROID_TARGET_SDK = 36;

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function androidArtifactName(version) {
  const { versionName } = androidVersion(version);
  return `YAQMC-android-${ANDROID_RELEASE_ABI}-v${versionName}.apk`;
}

export function stageAndroidRelease({ apkPath, destination, version, commit }) {
  const { versionName, versionCode } = androidVersion(version);
  if (!existsSync(apkPath)) throw new Error(`Android APK does not exist: ${apkPath}`);
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('Android release commit must be a full lowercase Git SHA');
  }

  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true });
  const name = androidArtifactName(versionName);
  const stagedApk = path.join(destination, name);
  copyFileSync(apkPath, stagedApk);
  const digest = sha256(stagedApk);

  writeFileSync(path.join(destination, 'SHA256SUMS-android.txt'), `${digest}  ${name}\n`);
  writeFileSync(
    path.join(destination, 'BUILD-IDENTITY-ANDROID.json'),
    `${JSON.stringify(
      {
        applicationId: ANDROID_APPLICATION_ID,
        versionName,
        versionCode,
        commit,
        abi: ANDROID_RELEASE_ABI,
        minSdk: ANDROID_MIN_SDK,
        targetSdk: ANDROID_TARGET_SDK,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(destination, 'RELEASE-NOTES-ANDROID.md'),
    `# YAQMC Android ${versionName}\n\n` +
      `- Package: \`${ANDROID_APPLICATION_ID}\`\n` +
      `- Architecture: \`${ANDROID_RELEASE_ABI}\`\n` +
      `- Requires Android 8.0 (API ${ANDROID_MIN_SDK}) or newer.\n` +
      '- This APK is distributed through GitHub Releases and must retain the same signing certificate for upgrades.\n' +
      '- Verify the download with `SHA256SUMS-android.txt` before sideloading.\n' +
      '- Android v1 does not include desktop lyric overlays, plugins, or the loopback Local API.\n',
  );
  return { digest, name, stagedApk, versionCode, versionName };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${key}`);
    }
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function main(argv) {
  const options = parseArgs(argv);
  for (const required of ['apk', 'to', 'version', 'commit']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  const result = stageAndroidRelease({
    apkPath: path.resolve(options.apk),
    destination: path.resolve(options.to),
    version: options.version,
    commit: options.commit,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
