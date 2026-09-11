import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_JNI_EXPORTS,
  JNI_PREFIX,
  KOTLIN_SOURCE,
  RUST_SOURCE,
  STREAM_CODES_SOURCE,
  checkJniSymbols,
  parseKotlinExternals,
  parseRustJniExports,
  parseRustStreamConstants,
} from './check-android-jni-symbols.mjs';

const repositoryRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function fixture({ kotlin, rust, streamCodes }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-jni-'));
  for (const [relative, contents] of [
    [KOTLIN_SOURCE, kotlin],
    [RUST_SOURCE, rust],
    [STREAM_CODES_SOURCE, streamCodes],
  ]) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

test('the repository contract has no mismatches', () => {
  const report = checkJniSymbols({ root: repositoryRoot });
  assert.deepEqual(report.errors, []);
  // javap emits members grouped by visibility, so compare as sets and keep the
  // declaration order check on the source-parsed export list.
  assert.deepEqual([...report.kotlinNames].sort(), [...EXPECTED_JNI_EXPORTS].sort());
  assert.deepEqual(report.rustNames, EXPECTED_JNI_EXPORTS);
  assert.deepEqual(
    report.streamCodes.map((entry) => [entry.name, entry.rust, entry.kotlin]),
    [
      ['STREAM_OK_EOF', 0, 0],
      ['STREAM_ERR_IO', -1, -1],
      ['STREAM_ERR_UNKNOWN_ID', -2, -2],
      ['STREAM_ERR_CANCELLED', -3, -3],
      ['STREAM_ERR_INTERNAL', -4, -4],
      ['STREAM_ERR_BUSY', -5, -5],
    ],
  );
});

test('Kotlin externals and Rust exports carry the JNI prefix', () => {
  const rust = parseRustJniExports(`#[no_mangle]
pub extern "system" fn ${JNI_PREFIX}nativeStreamOpen(
    _env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    stream_id: jlong,
    position: jlong,
) -> jlong {
    open_stream(stream_id, position)
}`);
  assert.deepEqual(rust, [`${JNI_PREFIX}nativeStreamOpen`]);

  const kotlin = parseKotlinExternals(`@JvmStatic
    private external fun nativeStreamOpen(streamId: Long, position: Long): Long`);
  assert.deepEqual(kotlin, { names: ['nativeStreamOpen'], internal: [] });
});

test('an internal external declaration fails closed', () => {
  const root = fixture({
    kotlin: 'internal external fun nativeStreamOpen(streamId: Long, position: Long): Long',
    rust: `pub extern "system" fn ${JNI_PREFIX}nativeStreamOpen() -> jlong { 0 }`,
    streamCodes: '',
  });
  try {
    const report = checkJniSymbols({ root });
    assert.ok(report.errors.some((error) => error.includes('declared internal')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a renamed Kotlin binding fails closed', () => {
  const root = fixture({
    kotlin: 'private external fun nativeStreamOpenV2(streamId: Long, position: Long): Long',
    rust: `pub extern "system" fn ${JNI_PREFIX}nativeStreamOpen() -> jlong { 0 }`,
    streamCodes: '',
  });
  try {
    const report = checkJniSymbols({ root });
    assert.ok(report.errors.some((error) => error.includes('nativeStreamOpenV2')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a drifted stream result code fails closed', () => {
  const root = fixture({
    kotlin: 'private external fun nativeStreamOpen(streamId: Long, position: Long): Long',
    rust: `pub extern "system" fn ${JNI_PREFIX}nativeStreamOpen() -> jlong { 0 }`,
    streamCodes: `private companion object {
        const val STREAM_ERR_BUSY = -6L
    }`,
  });
  try {
    const report = checkJniSymbols({ root });
    assert.ok(report.errors.some((error) => error.includes('STREAM_ERR_BUSY')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compiled classes resolve the JVM names when a javap build output exists', () => {
  const classesDirectory = path.join(
    repositoryRoot,
    'apps/android/android/app/build/tmp/kotlin-classes/debug',
  );
  const report = checkJniSymbols({ root: repositoryRoot, classesDirectory });
  if (report.tool !== 'javap') return;
  assert.deepEqual(report.errors, []);
  assert.deepEqual([...report.kotlinNames].sort(), [...EXPECTED_JNI_EXPORTS].sort());
});

test('Rust stream constants are read with their signed values', () => {
  const constants = parseRustStreamConstants(
    'const STREAM_ERR_IO: jint = -1;\nconst STREAM_OK_EOF: jint = 0;',
  );
  assert.deepEqual(
    [...constants],
    [
      ['STREAM_ERR_IO', -1],
      ['STREAM_OK_EOF', 0],
    ],
  );
});
