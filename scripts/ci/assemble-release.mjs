import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { androidVersion, rootVersion } from './android-version.mjs';
import { ELECTRON_RELEASE_NOTES, assembleElectronRelease } from './assemble-electron-release.mjs';
import {
  ANDROID_APPLICATION_ID,
  ANDROID_MIN_SDK,
  ANDROID_RELEASE_ABI,
  ANDROID_TARGET_SDK,
  androidArtifactName,
} from './stage-android-release.mjs';
import { sha256File } from './write-build-info.mjs';

export const RELEASE_NOTES_NAME = 'RELEASE-NOTES.md';

const ANDROID_METADATA_NAMES = Object.freeze([
  'BUILD-IDENTITY-ANDROID.json',
  'RELEASE-NOTES-ANDROID.md',
  'SHA256SUMS-android.txt',
]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith('--') || !value) throw new Error(`invalid argument: ${name}`);
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

function demoteHeadings(markdown) {
  return markdown.trim().replace(/^#/gmu, '##');
}

function combinedReleaseNotes(androidNotes) {
  return `# YAQMC release\n\n${demoteHeadings(ELECTRON_RELEASE_NOTES)}\n\n${demoteHeadings(
    androidNotes,
  )}\n`;
}

export function addAndroidReleaseAssets({
  sourceDir,
  destDir,
  expectedCommit,
  expectedVersion = rootVersion().versionName,
}) {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit ?? '')) {
    throw new Error('expected Android release commit must be a full lowercase Git SHA');
  }
  if (!existsSync(sourceDir)) {
    throw new Error(`Android release source is missing: ${sourceDir}`);
  }
  if (!existsSync(destDir)) {
    throw new Error(`assembled release destination is missing: ${destDir}`);
  }

  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Android release source must contain files only');
  }
  const names = entries.map((entry) => entry.name).sort();
  const apkNames = names.filter((name) => name.endsWith('.apk'));
  if (apkNames.length !== 1) {
    throw new Error('Android release source must contain exactly one APK');
  }

  const identityPath = path.join(sourceDir, 'BUILD-IDENTITY-ANDROID.json');
  if (!existsSync(identityPath)) throw new Error('Android release build identity is missing');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  const version = androidVersion(identity?.versionName);
  const apkName = androidArtifactName(version.versionName);
  const expectedNames = [...ANDROID_METADATA_NAMES, apkName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error('Android release source has unexpected or missing files');
  }
  if (
    identity?.schemaVersion !== 1 ||
    identity?.applicationId !== ANDROID_APPLICATION_ID ||
    identity?.versionName !== expectedVersion ||
    identity?.versionCode !== version.versionCode ||
    identity?.commit !== expectedCommit ||
    identity?.abi !== ANDROID_RELEASE_ABI ||
    identity?.minSdk !== ANDROID_MIN_SDK ||
    identity?.targetSdk !== ANDROID_TARGET_SDK
  ) {
    throw new Error('Android release build identity does not match the release contract');
  }

  const apkPath = path.join(sourceDir, apkName);
  const expectedChecksum = `${sha256File(apkPath)}  ${apkName}\n`;
  if (readFileSync(path.join(sourceDir, 'SHA256SUMS-android.txt'), 'utf8') !== expectedChecksum) {
    throw new Error('Android release checksum does not match the staged APK');
  }

  const releaseNotesPath = path.join(destDir, RELEASE_NOTES_NAME);
  for (const name of [...expectedNames, RELEASE_NOTES_NAME]) {
    if (existsSync(path.join(destDir, name))) throw new Error(`duplicate release file ${name}`);
  }
  for (const name of expectedNames) {
    copyFileSync(path.join(sourceDir, name), path.join(destDir, name));
  }
  const androidNotes = readFileSync(path.join(sourceDir, 'RELEASE-NOTES-ANDROID.md'), 'utf8');
  writeFileSync(releaseNotesPath, combinedReleaseNotes(androidNotes));
  return { apkName, files: readdirSync(destDir).sort(), version };
}

export function assembleRelease({
  electronSourceDir,
  androidSourceDir,
  correspondingSourceDir,
  destDir,
  expectedCommit,
}) {
  const electron = assembleElectronRelease({
    sourceDir: electronSourceDir,
    correspondingSourceDir,
    destDir,
  });
  if (electron.releaseCommit !== expectedCommit) {
    throw new Error('Electron release assets do not match the expected release commit');
  }
  const android = addAndroidReleaseAssets({
    sourceDir: androidSourceDir,
    destDir,
    expectedCommit,
  });
  return { electron, android, files: readdirSync(destDir).sort() };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  for (const required of ['electron-from', 'android-from', 'source-from', 'to', 'commit']) {
    if (!options[required]) throw new Error(`assemble-release requires --${required}`);
  }
  const result = assembleRelease({
    electronSourceDir: path.resolve(options['electron-from']),
    androidSourceDir: path.resolve(options['android-from']),
    correspondingSourceDir: path.resolve(options['source-from']),
    destDir: path.resolve(options.to),
    expectedCommit: options.commit,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
