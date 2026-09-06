import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { androidVersion } from './android-version.mjs';

export const ANDROID_APPLICATION_ID = 'org.yaqmc.android';
export const ANDROID_RELEASE_ABI = 'arm64-v8a';
export const ANDROID_MIN_SDK = 26;
export const ANDROID_TARGET_SDK = 36;

export function androidReleaseNotes(version) {
  const { versionName } = androidVersion(version);
  return `# YAQMC Android ${versionName}

## 中文

- 应用包名：\`${ANDROID_APPLICATION_ID}\`
- 架构：\`${ANDROID_RELEASE_ABI}\`
- 系统要求：Android 8.0（API ${ANDROID_MIN_SDK}）或更新版本。
- APK 通过 GitHub Releases 分发；后续覆盖升级必须使用相同的签名证书。
- 安装前请用 \`SHA256SUMS-android.txt\` 校验下载文件。
- Android v1 不包含桌面悬浮歌词、插件和回环 Local API。

## English

- Package: \`${ANDROID_APPLICATION_ID}\`
- Architecture: \`${ANDROID_RELEASE_ABI}\`
- Requires Android 8.0 (API ${ANDROID_MIN_SDK}) or newer.
- This APK is distributed through GitHub Releases and must retain the same signing certificate for upgrades.
- Verify the download with \`SHA256SUMS-android.txt\` before sideloading.
- Android v1 does not include desktop lyric overlays, plugins, or the loopback Local API.
`;
}

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
        schemaVersion: 1,
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
    androidReleaseNotes(versionName),
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
