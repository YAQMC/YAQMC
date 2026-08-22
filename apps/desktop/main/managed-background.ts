import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Matches Core `MAX_BACKGROUND_BYTES`. */
export const MAX_MANAGED_BACKGROUND_BYTES = 24 * 1024 * 1024;

const MANAGED_REFERENCE = /^backgrounds\/custom-background\.(png|jpg|webp|bmp|gif)$/;

export function isManagedBackgroundReference(reference: string): boolean {
  if (reference.length === 0 || reference.length > 160) {
    return false;
  }
  if (reference.includes('\0') || reference.includes('..') || reference.includes('\\')) {
    return false;
  }
  return MANAGED_REFERENCE.test(reference);
}

export function managedBackgroundPath(dataDir: string, reference: string): string | undefined {
  if (!isManagedBackgroundReference(reference)) {
    return undefined;
  }
  const root = path.resolve(dataDir);
  const target = path.resolve(root, reference);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return target;
}

export function detectImageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
  ) {
    return 'image/webp';
  }
  if (bytes.subarray(0, 2).equals(Buffer.from('BM'))) {
    return 'image/bmp';
  }
  if (
    bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
    bytes.subarray(0, 6).equals(Buffer.from('GIF89a'))
  ) {
    return 'image/gif';
  }
  return undefined;
}

/**
 * Core stdio omits `dataUri` so wallpaper bytes stay under the 1 MiB method cap.
 * Main re-reads the managed file (same path rules as Core) and attaches the URI.
 */
export async function hydrateManagedBackground(result: unknown, dataDir: string): Promise<unknown> {
  if (result === null || result === undefined) {
    return result;
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('managed background result is invalid');
  }
  const record = result as { reference?: unknown; dataUri?: unknown };
  if (typeof record.reference !== 'string') {
    throw new Error('managed background reference is missing');
  }
  if (typeof record.dataUri === 'string' && record.dataUri.startsWith('data:image/')) {
    return { reference: record.reference, dataUri: record.dataUri };
  }
  const filePath = managedBackgroundPath(dataDir, record.reference);
  if (!filePath) {
    throw new Error('background reference is outside the managed directory');
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    throw new Error('managed background image could not be read');
  }
  if (bytes.length > MAX_MANAGED_BACKGROUND_BYTES) {
    throw new Error('managed background image is too large');
  }
  const mime = detectImageMime(bytes);
  if (!mime) {
    throw new Error('managed background is not a supported image');
  }
  return {
    reference: record.reference,
    dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
  };
}
