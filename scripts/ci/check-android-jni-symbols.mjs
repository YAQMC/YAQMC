/**
 * JNI ABI guard for the Android host.
 *
 * `libyaqmc_core.so` resolves native methods by exact JVM name:
 * `Java_org_yaqmc_android_core_CoreManager_<method>`. Kotlin renames `internal`
 * declarations with a module suffix, which turns a working binding into an
 * `UnsatisfiedLinkError`, and the `STREAM_*` result codes are duplicated in Kotlin.
 * Both sides are checked against each other here so a rename cannot land silently.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const JNI_PREFIX = 'Java_org_yaqmc_android_core_CoreManager_';
export const KOTLIN_SOURCE =
  'apps/android/android/app/src/main/java/org/yaqmc/android/core/CoreManager.kt';
export const RUST_SOURCE = 'crates/yaqmc-android/src/lib.rs';
export const STREAM_CODES_SOURCE =
  'apps/android/android/app/src/main/java/org/yaqmc/android/media/NativeStreamError.kt';

/** Same order as the Kotlin `external` declarations. */
export const EXPECTED_JNI_EXPORTS = [
  'nativeInitialize',
  'nativeInvoke',
  'nativeSetLifecycle',
  'nativeShutdown',
  'nativeReportAudioState',
  'nativeStreamOpen',
  'nativeStreamRead',
  'nativeStreamClose',
];

const EXTERNAL_DECLARATION = /external\s+fun\s+([A-Za-z_][A-Za-z0-9_]*)/gu;
const JNI_EXPORT_DECLARATION = /pub\s+extern\s+"system"\s+fn\s+(Java_[A-Za-z0-9_]+)/gu;
const STREAM_CONSTANT = /const\s+val\s+(STREAM_[A-Z_]+)\s*=\s*(-?\d+)L/gu;
const RUST_STREAM_CONSTANT = /const\s+(STREAM_[A-Z_]+):\s*jint\s*=\s*(-?\d+);/gu;

function sourceAt(root, relative) {
  const file = path.join(root, relative);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

/** JVM names the Kotlin host actually calls, plus any `internal` declaration that would rename them. */
export function parseKotlinExternals(source) {
  const names = [];
  const internal = [];
  for (const match of source.matchAll(EXTERNAL_DECLARATION)) {
    names.push(match[1]);
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    if (/\binternal\b/u.test(source.slice(lineStart, match.index))) internal.push(match[1]);
  }
  return { names, internal };
}

/** Exported symbols declared in Rust, in source order. */
export function parseRustJniExports(source) {
  return [...source.matchAll(JNI_EXPORT_DECLARATION)].map((match) => match[1]);
}

export function parseKotlinStreamConstants(source) {
  return new Map(
    [...source.matchAll(STREAM_CONSTANT)].map((match) => [match[1], Number(match[2])]),
  );
}

export function parseRustStreamConstants(source) {
  return new Map(
    [...source.matchAll(RUST_STREAM_CONSTANT)].map((match) => [match[1], Number(match[2])]),
  );
}

/**
 * Resolves the symbols the Kotlin compiler emits for the native declarations.
 *
 * Kotlin appends the module and compilation suffix to `internal` names, so a
 * `javap` dump of the compiled class is the authoritative list. Degrades to the
 * source list when `javap` or the class file is unavailable (for example when
 * the CI job runs before Gradle produced classes).
 */
export function kotlinJvmNativeNames(
  sourceNames,
  { classesDirectory, javap = 'javap', run = execFileSync } = {},
) {
  if (
    !classesDirectory ||
    !existsSync(path.join(classesDirectory, 'org/yaqmc/android/core/CoreManager.class'))
  ) {
    return { names: sourceNames, tool: 'source' };
  }
  let output;
  try {
    output = run(
      javap,
      ['-p', '-classpath', classesDirectory, 'org.yaqmc.android.core.CoreManager'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch {
    return { names: sourceNames, tool: 'source' };
  }
  const names = [];
  for (const match of output.matchAll(
    /(?:static\s+)?native\s+[^\s(]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu,
  )) {
    names.push(match[1]);
  }
  return names.length > 0 ? { names, tool: 'javap' } : { names: sourceNames, tool: 'source' };
}

function unique(values) {
  return [...new Set(values)];
}

function diff(left, right) {
  const other = new Set(right);
  return left.filter((value) => !other.has(value));
}

export function checkJniSymbols(options = {}) {
  const root = options.root ?? defaultRepositoryRoot;
  const errors = [];
  const kotlinSource = sourceAt(root, KOTLIN_SOURCE);
  const rustSource = sourceAt(root, RUST_SOURCE);
  if (kotlinSource === null) errors.push(`${KOTLIN_SOURCE}: missing`);
  if (rustSource === null) errors.push(`${RUST_SOURCE}: missing`);
  if (errors.length > 0) return { errors, kotlinNames: [], rustNames: [], streamCodes: [] };

  const declared = parseKotlinExternals(kotlinSource);
  const resolved = kotlinJvmNativeNames(declared.names, {
    classesDirectory: options.classesDirectory,
    javap: options.javap,
    run: options.run,
  });
  const kotlinNames = unique(resolved.names);
  const rustNames = unique(
    parseRustJniExports(rustSource).map((name) => name.slice(JNI_PREFIX.length)),
  );
  const rawRust = unique(parseRustJniExports(rustSource));

  for (const name of declared.internal) {
    errors.push(
      `${KOTLIN_SOURCE}: ${name} is declared internal, which mangles the JVM name and breaks the JNI lookup`,
    );
  }
  for (const name of rawRust) {
    if (!name.startsWith(JNI_PREFIX)) {
      errors.push(`${RUST_SOURCE}: exported symbol ${name} is outside ${JNI_PREFIX}`);
    }
  }
  for (const name of diff(kotlinNames, rustNames)) {
    errors.push(
      `${KOTLIN_SOURCE}: ${name} has no matching ${JNI_PREFIX}${name} export in ${RUST_SOURCE}`,
    );
  }
  for (const name of diff(rustNames, kotlinNames)) {
    errors.push(`${RUST_SOURCE}: ${JNI_PREFIX}${name} has no matching Kotlin external declaration`);
  }
  for (const name of diff(EXPECTED_JNI_EXPORTS, rustNames)) {
    errors.push(`${RUST_SOURCE}: ${JNI_PREFIX}${name} is missing`);
  }

  // `STREAM_OK_EOF` is a success code the Kotlin data source spells `0`, so only
  // negative codes are required to exist on both sides; every shared code must
  // still carry the same value.
  const streamCodes = [];
  const kotlinCodes = parseKotlinStreamConstants(sourceAt(root, STREAM_CODES_SOURCE) ?? '');
  const rustCodes = parseRustStreamConstants(rustSource);
  const shared = (name) => name.startsWith('STREAM_ERR_');
  for (const [name, value] of rustCodes) {
    if (kotlinCodes.has(name)) {
      if (kotlinCodes.get(name) !== value) {
        errors.push(
          `${STREAM_CODES_SOURCE}: ${name} is ${kotlinCodes.get(name)} but ${RUST_SOURCE} declares ${value}`,
        );
      }
      streamCodes.push({ name, rust: value, kotlin: kotlinCodes.get(name) });
      continue;
    }
    if (shared(name)) {
      errors.push(`${STREAM_CODES_SOURCE}: ${name} is not mirrored from ${RUST_SOURCE}`);
    }
  }
  for (const [name, value] of kotlinCodes) {
    if (!rustCodes.has(name)) {
      errors.push(`${STREAM_CODES_SOURCE}: ${name} has no matching constant in ${RUST_SOURCE}`);
    } else if (!shared(name) && rustCodes.get(name) !== value) {
      errors.push(
        `${STREAM_CODES_SOURCE}: ${name} is ${value} but ${RUST_SOURCE} declares ${rustCodes.get(name)}`,
      );
    }
  }

  return { errors, kotlinNames, rustNames, streamCodes, tool: resolved.tool };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--root' || flag === '--classes' || flag === '--javap') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      index += 1;
      if (flag === '--root') options.root = path.resolve(value);
      else if (flag === '--classes') options.classesDirectory = path.resolve(value);
      else options.javap = value;
      continue;
    }
    throw new Error(`unsupported option: ${flag}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const report = checkJniSymbols(parseArguments(argv));
  if (report.errors.length > 0) {
    process.stderr.write(`Android JNI symbol check failed (${report.errors.length}):\n`);
    for (const error of report.errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
    return;
  }
  const codes = report.streamCodes.map((entry) => `${entry.name}=${entry.rust}`).join(' ');
  process.stdout.write(
    `Android JNI symbols match: ${report.kotlinNames.length} Kotlin externals (${report.tool}), ` +
      `${report.rustNames.length} Rust exports; ${codes}\n`,
  );
}

if (Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
