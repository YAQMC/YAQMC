export const FILE_SHA256_V1: 'file-sha256-v1';
export const MACHO_CONTENT_SHA256_V1: 'macho-content-sha256-v1';

export type CoreHashMode = typeof FILE_SHA256_V1 | typeof MACHO_CONTENT_SHA256_V1;

export function coreHashModeForBytes(bytes: Uint8Array): CoreHashMode;
export function coreSha256(bytes: Uint8Array, mode?: CoreHashMode): string;
