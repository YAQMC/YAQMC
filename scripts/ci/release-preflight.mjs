import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAndroidReleaseTag, rootVersion } from './android-version.mjs';

export function releasePreflight(environment, version) {
  const targets = environment.YAQMC_TARGETS || 'all';
  if (!['all', 'windows', 'linux'].includes(targets)) {
    throw new Error('Invalid release targets');
  }
  const tagged = environment.GITHUB_REF_TYPE === 'tag';
  if (tagged) {
    assertAndroidReleaseTag(version, environment.GITHUB_REF_NAME);
    if (targets !== 'all') throw new Error('Tagged releases require every platform');
  }
  const required = [
    'ANDROID_RELEASE_KEYSTORE_BASE64',
    'ANDROID_RELEASE_KEY_ALIAS',
    'ANDROID_RELEASE_STORE_PASSWORD',
    'ANDROID_RELEASE_KEY_PASSWORD',
    'ANDROID_RELEASE_CERT_SHA256',
    ...(targets !== 'linux'
      ? ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'YAQMC_WINDOWS_SIGNER_SUBJECT']
      : []),
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing release-signing secrets: ${missing.join(', ')}`);
  }
  const digest = environment.ANDROID_RELEASE_CERT_SHA256.replace(/[:\s]/gu, '');
  if (!/^[0-9a-f]{64}$/iu.test(digest)) {
    throw new Error('ANDROID_RELEASE_CERT_SHA256 must be a SHA-256 certificate fingerprint');
  }
  return { targets, version, tagged };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = releasePreflight(process.env, rootVersion().versionName);
    process.stdout.write(`Release configuration ready: ${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
