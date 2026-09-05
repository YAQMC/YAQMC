import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EXPECTED_PERMISSIONS = new Set([
  'android.permission.INTERNET',
  'android.permission.WAKE_LOCK',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
]);
const FORBIDDEN_SOURCE_EXTENSIONS = new Set(['.jks', '.keystore', '.p12', '.pfx', '.so']);
const FORBIDDEN_RELEASE_MARKERS = [
  'http://localhost',
  'http://127.0.0.1',
  'http://10.0.2.2',
  '?provider=fake',
  '__YAQMC_E2E__',
];

function textAt(root, relative, errors) {
  const file = path.join(root, relative);
  if (!existsSync(file)) {
    errors.push(`${relative}: missing required file`);
    return '';
  }
  return readFileSync(file, 'utf8');
}

function requireMatch(text, pattern, label, errors) {
  if (!pattern.test(text)) errors.push(label);
}

function blockAfter(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return '';
  const start = text.indexOf('{', match.index);
  if (start < 0) return '';
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, index);
    }
  }
  return '';
}

function listedAbis(block) {
  return [...block.matchAll(/abiFilters\.add\("([^"]+)"\)/gu)].map((match) => match[1]);
}

function sourceFilesBelow(root) {
  const result = [];
  if (!existsSync(root)) return result;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ['build', '.gradle'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  };
  visit(root);
  return result;
}

export function verifyAndroidProject(repositoryRoot = defaultRepositoryRoot) {
  const errors = [];
  const androidWorkspace = path.join(repositoryRoot, 'apps', 'android');
  const packageText = textAt(repositoryRoot, 'apps/android/package.json', errors);
  const capacitor = textAt(repositoryRoot, 'apps/android/capacitor.config.ts', errors);
  const settings = textAt(repositoryRoot, 'apps/android/android/settings.gradle.kts', errors);
  const rootGradle = textAt(repositoryRoot, 'apps/android/android/build.gradle.kts', errors);
  const appGradle = textAt(repositoryRoot, 'apps/android/android/app/build.gradle.kts', errors);
  const wrapper = textAt(
    repositoryRoot,
    'apps/android/android/gradle/wrapper/gradle-wrapper.properties',
    errors,
  );
  const manifest = textAt(
    repositoryRoot,
    'apps/android/android/app/src/main/AndroidManifest.xml',
    errors,
  );
  const rootCargo = textAt(repositoryRoot, 'Cargo.toml', errors);
  const androidCargo = textAt(repositoryRoot, 'crates/yaqmc-android/Cargo.toml', errors);

  let rootPackage = {};
  let androidPackage = {};
  try {
    rootPackage = JSON.parse(textAt(repositoryRoot, 'package.json', errors));
    androidPackage = JSON.parse(packageText);
  } catch (error) {
    errors.push(`Android package metadata is not valid JSON: ${error}`);
  }
  if (androidPackage.version !== rootPackage.version) {
    errors.push(
      `apps/android/package.json version ${String(androidPackage.version)} does not match root ${String(rootPackage.version)}`,
    );
  }
  for (const dependency of ['@capacitor/android', '@capacitor/core']) {
    if (androidPackage.dependencies?.[dependency] !== '8.5.1') {
      errors.push(`${dependency} must be pinned to 8.5.1`);
    }
  }
  if (androidPackage.devDependencies?.['@capacitor/cli'] !== '8.5.1') {
    errors.push('@capacitor/cli must be pinned to 8.5.1');
  }
  if (androidPackage.dependencies?.['@capacitor/app'] !== '8.1.1') {
    errors.push('@capacitor/app must be pinned to 8.1.1');
  }

  requireMatch(
    capacitor,
    /appId:\s*['"]org\.yaqmc\.android['"]/u,
    'Capacitor appId drifted',
    errors,
  );
  requireMatch(
    capacitor,
    /webDir:\s*['"]\.\.\/\.\.\/dist-android['"]/u,
    'Capacitor webDir must be the isolated dist-android bundle',
    errors,
  );
  requireMatch(
    rootGradle,
    /com\.android\.application[^\n]+8\.13\.0/u,
    'AGP must be 8.13.0',
    errors,
  );
  requireMatch(
    rootGradle,
    /org\.jetbrains\.kotlin\.android[^\n]+2\.2\.20/u,
    'Kotlin must be 2.2.20',
    errors,
  );
  requireMatch(
    wrapper,
    /gradle-8\.14\.3-(?:all|bin)\.zip/u,
    'Gradle wrapper must be 8.14.3',
    errors,
  );
  if (
    !existsSync(path.join(androidWorkspace, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar'))
  ) {
    errors.push('Gradle wrapper jar is missing');
  }
  requireMatch(
    settings,
    /include\(":capacitor-android"\)/u,
    'Capacitor Android project is not included',
    errors,
  );
  requireMatch(
    settings,
    /include\(":capacitor-app"\)/u,
    'Capacitor App plugin project is not included',
    errors,
  );

  for (const [pattern, label] of [
    [/applicationId\s*=\s*"org\.yaqmc\.android"/u, 'Android applicationId drifted'],
    [/compileSdk\s*=\s*36/u, 'compileSdk must be 36'],
    [/minSdk\s*=\s*26/u, 'minSdk must be 26'],
    [/targetSdk\s*=\s*36/u, 'targetSdk must be 36'],
    [/buildToolsVersion\s*=\s*"36\.0\.0"/u, 'Build Tools must be 36.0.0'],
    [/ndkVersion\s*=\s*"28\.2\.13676358"/u, 'NDK must be 28.2.13676358'],
    [/YAQMC_VERSION_NAME/u, 'Gradle must receive YAQMC_VERSION_NAME'],
    [/YAQMC_VERSION_CODE/u, 'Gradle must receive YAQMC_VERSION_CODE'],
    [/androidx\.media3:media3-common:1\.10\.1/u, 'Media3 common must be 1.10.1'],
    [/androidx\.media3:media3-session:1\.10\.1/u, 'Media3 session must be 1.10.1'],
    [/YAQMC_ANDROID_NATIVE_LIB_DIR/u, 'JNI libraries must come from an external build directory'],
    [/implementation\(project\(":capacitor-app"\)\)/u, 'Capacitor App plugin must be linked'],
  ]) {
    requireMatch(appGradle, pattern, label, errors);
  }
  for (const secret of [
    'ANDROID_RELEASE_KEYSTORE',
    'ANDROID_RELEASE_KEY_ALIAS',
    'ANDROID_RELEASE_STORE_PASSWORD',
    'ANDROID_RELEASE_KEY_PASSWORD',
  ]) {
    if (!appGradle.includes(secret)) errors.push(`Gradle release signing is missing ${secret}`);
  }
  const debugAbis = listedAbis(blockAfter(appGradle, /debug\s*\{/u));
  const releaseAbis = listedAbis(blockAfter(appGradle, /release\s*\{/u));
  if (JSON.stringify(debugAbis) !== JSON.stringify(['arm64-v8a', 'x86_64'])) {
    errors.push(`debug ABI set must be arm64-v8a,x86_64; found ${debugAbis.join(',')}`);
  }
  if (JSON.stringify(releaseAbis) !== JSON.stringify(['arm64-v8a'])) {
    errors.push(`release ABI set must be arm64-v8a; found ${releaseAbis.join(',')}`);
  }
  if (/exoplayer/iu.test(appGradle))
    errors.push('Android host must not add ExoPlayer as a second engine');

  const permissions = new Set(
    [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"\s*\/>/gu)].map(
      (match) => match[1],
    ),
  );
  for (const permission of permissions) {
    if (!EXPECTED_PERMISSIONS.has(permission))
      errors.push(`unexpected Android permission: ${permission}`);
  }
  for (const permission of EXPECTED_PERMISSIONS) {
    if (!permissions.has(permission)) errors.push(`missing Android permission: ${permission}`);
  }
  for (const [pattern, label] of [
    [/android:allowBackup="false"/u, 'Android backup must be disabled'],
    [/android:usesCleartextTraffic="false"/u, 'cleartext network traffic must be disabled'],
    [
      /android:foregroundServiceType="mediaPlayback"/u,
      'playback service type must be mediaPlayback',
    ],
    [/android:scheme="yaqmc"/u, 'yaqmc deep-link scheme is missing'],
    [/android:host="catalog"/u, 'yaqmc catalog deep-link host is missing'],
  ]) {
    requireMatch(manifest, pattern, label, errors);
  }
  if (/android:screenOrientation=/u.test(manifest))
    errors.push('Android orientation must not be locked');

  requireMatch(
    rootCargo,
    /"crates\/yaqmc-android"/u,
    'yaqmc-android is not a Cargo workspace member',
    errors,
  );
  requireMatch(
    androidCargo,
    /crate-type\s*=\s*\[\s*"cdylib"\s*\]/u,
    'yaqmc-android must emit a cdylib',
    errors,
  );
  requireMatch(
    androidCargo,
    /yaqmc-core\s*=\s*\{[^\n]*default-features\s*=\s*false/u,
    'yaqmc-android must disable yaqmc-core default desktop features',
    errors,
  );

  for (const file of sourceFilesBelow(androidWorkspace)) {
    const relative = path.relative(repositoryRoot, file).replaceAll('\\', '/');
    if (FORBIDDEN_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      errors.push(`${relative}: native binary or signing key must not live in the source tree`);
      continue;
    }
    if (
      !['.gradle', '.kts', '.kt', '.json', '.md', '.properties', '.ts', '.xml'].includes(
        path.extname(file),
      )
    ) {
      continue;
    }
    const contents = readFileSync(file, 'utf8');
    for (const marker of FORBIDDEN_RELEASE_MARKERS) {
      if (contents.includes(marker))
        errors.push(`${relative}: forbidden development marker ${marker}`);
    }
  }

  return errors;
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const errors = verifyAndroidProject();
  if (errors.length > 0) {
    process.stderr.write(`Android project verification failed (${errors.length}):\n`);
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Android project verification passed.\n');
  }
}
