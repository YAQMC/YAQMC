import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAndroidReleaseTag, rootVersion } from './android-version.mjs';

export const MACOS_SIGNING_SECRETS = [
  'MAC_CSC_LINK',
  'MAC_CSC_KEY_PASSWORD',
  'APPLE_API_KEY_P8_BASE64',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];

export function releasePreflight(environment, version) {
  const targets = environment.YAQMC_TARGETS || 'all';
  if (!['all', 'windows', 'linux', 'macos'].includes(targets)) {
    throw new Error('Invalid release targets');
  }
  const macosSigning = environment.YAQMC_MACOS_SIGNING === 'true';
  if (macosSigning && (targets === 'all' || targets === 'macos')) {
    // Opt-in Developer ID signing + notarization: fail closed instead of silently shipping ad-hoc.
    const missingApple = MACOS_SIGNING_SECRETS.filter((name) => !environment[name]?.trim());
    if (missingApple.length) {
      throw new Error(`Missing macOS signing secrets: ${missingApple.join(', ')}`);
    }
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
  ];
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing release-signing secrets: ${missing.join(', ')}`);
  }
  const digest = environment.ANDROID_RELEASE_CERT_SHA256.replace(/[:\s]/gu, '');
  if (!/^[0-9a-f]{64}$/iu.test(digest)) {
    throw new Error('ANDROID_RELEASE_CERT_SHA256 must be a SHA-256 certificate fingerprint');
  }
  return { targets, version, tagged, macosSigning };
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
