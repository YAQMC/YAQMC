import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type CoreIntegrityPolicy = 'required' | 'optional';

export type CoreSha256Manifest = {
  name: string;
  sha256: string;
  bytes: number;
};

export class CoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreIntegrityError';
  }
}

export function coreManifestPath(binary: string): string {
  return path.join(path.dirname(binary), 'manifest.json');
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function parseCoreManifest(value: unknown): CoreSha256Manifest {
  if (value === null || typeof value !== 'object') {
    throw new CoreIntegrityError('core manifest is not an object');
  }
  const record = value as { name?: unknown; sha256?: unknown; bytes?: unknown };
  if (typeof record.name !== 'string' || record.name.length === 0) {
    throw new CoreIntegrityError('core manifest is missing name');
  }
  if (typeof record.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(record.sha256)) {
    throw new CoreIntegrityError('core manifest is missing sha256');
  }
  if (typeof record.bytes !== 'number' || !Number.isInteger(record.bytes) || record.bytes < 0) {
    throw new CoreIntegrityError('core manifest is missing bytes');
  }
  return { name: record.name, sha256: record.sha256.toLowerCase(), bytes: record.bytes };
}

/**
 * FACT: cargo `debug`/`release` (and `YAQMC_CORE_BIN`) may run without a manifest.
 * Staged `apps/desktop/resources/core/` and packaged `resources/core` require one.
 * A present manifest is always checked; mismatch fails closed and does not spawn.
 */
export function verifyCoreBinary(
  binary: string,
  policy: CoreIntegrityPolicy,
): CoreSha256Manifest | undefined {
  const manifestFile = coreManifestPath(binary);
  if (!existsSync(manifestFile)) {
    if (policy === 'required') {
      throw new CoreIntegrityError(`missing sha256 manifest next to ${binary}`);
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown;
  } catch (error) {
    throw new CoreIntegrityError(
      `unreadable core manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parseCoreManifest(parsed);
  const name = path.basename(binary);
  if (manifest.name !== name) {
    throw new CoreIntegrityError(
      `core manifest name mismatch: expected ${name}, found ${manifest.name}`,
    );
  }
  const actual = sha256File(binary);
  if (actual !== manifest.sha256) {
    throw new CoreIntegrityError(
      `core sha256 mismatch: expected ${manifest.sha256}, found ${actual}`,
    );
  }
  return manifest;
}
