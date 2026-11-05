import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const FILE_SHA256_V1 = 'file-sha256-v1';
export const MACHO_CONTENT_SHA256_V1 = 'macho-content-sha256-v1';

const MACHO_64_LE_MAGIC = 0xfeedfacf;
const MACHO_64_HEADER_SIZE = 32;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;

function asBuffer(bytes) {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isMachO64LittleEndian(bytes) {
  return bytes.length >= MACHO_64_HEADER_SIZE && bytes.readUInt32LE(0) === MACHO_64_LE_MAGIC;
}

export function coreHashModeForBytes(value) {
  return isMachO64LittleEndian(asBuffer(value)) ? MACHO_CONTENT_SHA256_V1 : FILE_SHA256_V1;
}

function machoContentBytes(value) {
  const bytes = asBuffer(value);
  if (!isMachO64LittleEndian(bytes)) {
    throw new Error('macho-content-sha256-v1 requires a little-endian 64-bit Mach-O binary');
  }

  const commandCount = bytes.readUInt32LE(16);
  const commandBytes = bytes.readUInt32LE(20);
  const commandsEnd = MACHO_64_HEADER_SIZE + commandBytes;
  if (commandsEnd > bytes.length) {
    throw new Error('Mach-O load commands extend beyond the file');
  }

  let cursor = MACHO_64_HEADER_SIZE;
  let signatureOffset;
  const normalizedFields = [];
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandsEnd) {
      throw new Error('Mach-O load command header extends beyond sizeofcmds');
    }
    const command = bytes.readUInt32LE(cursor);
    const commandSize = bytes.readUInt32LE(cursor + 4);
    if (commandSize < 8 || cursor + commandSize > commandsEnd) {
      throw new Error('Mach-O load command has an invalid size');
    }

    if (command === LC_SEGMENT_64 && commandSize >= 72) {
      const segmentName = bytes
        .subarray(cursor + 8, cursor + 24)
        .toString('ascii')
        .replace(/\0.*$/u, '');
      if (segmentName === '__LINKEDIT') {
        // codesign resizes __LINKEDIT to fit the new signature blob.
        normalizedFields.push([cursor + 32, 8], [cursor + 48, 8]);
      }
    } else if (command === LC_CODE_SIGNATURE) {
      if (commandSize < 16 || signatureOffset !== undefined) {
        throw new Error('Mach-O has an invalid LC_CODE_SIGNATURE command');
      }
      const dataOffset = bytes.readUInt32LE(cursor + 8);
      const dataSize = bytes.readUInt32LE(cursor + 12);
      if (dataOffset < commandsEnd || dataSize === 0 || dataOffset + dataSize !== bytes.length) {
        throw new Error('Mach-O code signature is not a terminal file region');
      }
      signatureOffset = dataOffset;
      normalizedFields.push([cursor + 8, 8]);
    }
    cursor += commandSize;
  }
  if (cursor !== commandsEnd || signatureOffset === undefined) {
    throw new Error('Mach-O is missing a valid terminal LC_CODE_SIGNATURE');
  }

  const content = Buffer.from(bytes.subarray(0, signatureOffset));
  for (const [offset, size] of normalizedFields) {
    if (offset + size > content.length) {
      throw new Error('Mach-O signature metadata extends into the signature region');
    }
    content.fill(0, offset, offset + size);
  }
  return content;
}

export function coreSha256(value, mode = FILE_SHA256_V1) {
  const bytes = asBuffer(value);
  if (mode === FILE_SHA256_V1) {
    return createHash('sha256').update(bytes).digest('hex');
  }
  if (mode === MACHO_CONTENT_SHA256_V1) {
    return createHash('sha256').update(machoContentBytes(bytes)).digest('hex');
  }
  throw new Error(`unsupported core hash mode ${mode}`);
}
