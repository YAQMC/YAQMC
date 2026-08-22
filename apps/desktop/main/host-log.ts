import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';

/** DIAG leftover: rotating Main `host.log` in the Core log dir (§27.1). */
export const HOST_LOG_FILE_NAME = 'host.log';
export const HOST_LOG_ROTATED_NAME = 'host.log.1';
/** Keep the live file small; diagnostics still cap the exported tail at 64 KiB. */
export const HOST_LOG_MAX_BYTES = 256 * 1024;

export type HostLog = {
  filePath: string;
  append: (message: string) => void;
  tail: (maxBytes?: number) => string;
};

export type HostLogOptions = {
  logDir: string;
  maxBytes?: number;
  now?: () => Date;
};

export function hostLogPath(logDir: string): string {
  return path.join(logDir, HOST_LOG_FILE_NAME);
}

export function createHostLog(options: HostLogOptions): HostLog {
  const maxBytes = options.maxBytes ?? HOST_LOG_MAX_BYTES;
  const filePath = hostLogPath(options.logDir);
  mkdirSync(options.logDir, { recursive: true });

  function rotateIfNeeded(nextBytes: number): void {
    if (!existsSync(filePath)) {
      return;
    }
    const size = statSync(filePath).size;
    if (size + nextBytes <= maxBytes) {
      return;
    }
    const rotated = path.join(options.logDir, HOST_LOG_ROTATED_NAME);
    if (existsSync(rotated)) {
      unlinkSync(rotated);
    }
    renameSync(filePath, rotated);
  }

  return {
    filePath,
    append(message: string): void {
      const now = options.now ?? (() => new Date());
      const stamp = now().toISOString();
      const line = `${stamp} ${message.replace(/\s+/g, ' ').trim()}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      rotateIfNeeded(bytes);
      appendFileSync(filePath, line, 'utf8');
    },
    tail(maxBytes = HOST_LOG_MAX_BYTES): string {
      const rotated = path.join(options.logDir, HOST_LOG_ROTATED_NAME);
      const parts: Buffer[] = [];
      if (existsSync(rotated)) {
        parts.push(readFileSync(rotated));
      }
      if (existsSync(filePath)) {
        parts.push(readFileSync(filePath));
      }
      if (parts.length === 0) {
        return '';
      }
      const combined = Buffer.concat(parts);
      if (combined.length <= maxBytes) {
        return combined.toString('utf8');
      }
      let slice = combined.subarray(combined.length - maxBytes);
      while (slice.length > 0 && ((slice[0] ?? 0) & 0xc0) === 0x80) {
        slice = slice.subarray(1);
      }
      return slice.toString('utf8');
    },
  };
}
