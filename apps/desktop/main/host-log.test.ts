import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOST_LOG_FILE_NAME,
  HOST_LOG_MAX_BYTES,
  HOST_LOG_ROTATED_NAME,
  createHostLog,
} from './host-log';

describe('rotating Main host.log', () => {
  it('appends timestamped lines under the Core log dir', () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-host-log-'));
    const log = createHostLog({
      logDir,
      now: () => new Date('2026-08-17T16:00:00.000Z'),
    });
    log.append('supervisor start');
    expect(log.filePath).toBe(path.join(logDir, HOST_LOG_FILE_NAME));
    expect(readFileSync(log.filePath, 'utf8')).toBe('2026-08-17T16:00:00.000Z supervisor start\n');
  });

  it('rotates to host.log.1 when the live file would exceed the cap', () => {
    const logDir = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-host-log-rot-'));
    const log = createHostLog({
      logDir,
      maxBytes: 64,
      now: () => new Date('2026-08-17T16:00:00.000Z'),
    });
    log.append('first-line-that-fits');
    log.append('second-line-triggers-rotate');
    expect(readFileSync(path.join(logDir, HOST_LOG_ROTATED_NAME), 'utf8')).toContain(
      'first-line-that-fits',
    );
    expect(readFileSync(log.filePath, 'utf8')).toContain('second-line-triggers-rotate');
    expect(log.tail()).toContain('first-line-that-fits');
    expect(log.tail()).toContain('second-line-triggers-rotate');
  });

  it('keeps the default rotate cap at 256 KiB', () => {
    expect(HOST_LOG_MAX_BYTES).toBe(256 * 1024);
  });
});
