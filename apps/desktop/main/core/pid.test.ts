import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  corePidPath,
  isCoreImageName,
  parsePidFile,
  reapStaleCorePid,
  type ProcessProbe,
} from './pid';

function tempDataDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yaqmc-pid-'));
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function probeWith(image: string | undefined, killed: number[]): ProcessProbe {
  return {
    imageName: (pid) => (pid > 0 ? image : undefined),
    kill: (pid) => {
      killed.push(pid);
    },
  };
}

describe('core pid file guard', () => {
  it('parses a core.pid body and matches only yaqmc-core image names', () => {
    expect(parsePidFile('4242\n')).toBe(4242);
    expect(parsePidFile('  99  leftover')).toBe(99);
    expect(parsePidFile('nope')).toBeUndefined();
    expect(parsePidFile('0')).toBeUndefined();
    expect(isCoreImageName('yaqmc-core')).toBe(true);
    expect(isCoreImageName('C:\\bin\\yaqmc-core.exe')).toBe(true);
    expect(isCoreImageName('YAQMC-CORE.EXE')).toBe(true);
    expect(isCoreImageName('notepad.exe')).toBe(false);
    expect(isCoreImageName('chrome')).toBe(false);
  });

  it('kills a zombie yaqmc-core named by a leftover pid file', () => {
    const dataDir = tempDataDir();
    writeFileSync(corePidPath(dataDir), '4242\n');
    const killed: number[] = [];
    expect(reapStaleCorePid(dataDir, probeWith('yaqmc-core.exe', killed))).toEqual({
      action: 'killed',
      pid: 4242,
      image: 'yaqmc-core.exe',
    });
    expect(killed).toEqual([4242]);
    expect(() => readFileSync(corePidPath(dataDir))).toThrow();
  });

  it('does not kill an unrelated process when the pid was reused', () => {
    const dataDir = tempDataDir();
    writeFileSync(corePidPath(dataDir), '7\n');
    const killed: number[] = [];
    expect(reapStaleCorePid(dataDir, probeWith('notepad.exe', killed))).toEqual({
      action: 'ignored',
      pid: 7,
      image: 'notepad.exe',
    });
    expect(killed).toEqual([]);
    expect(readFileSync(corePidPath(dataDir), 'utf8')).toBe('7\n');
  });

  it('treats a dead pid as stale without calling kill', () => {
    const dataDir = tempDataDir();
    writeFileSync(corePidPath(dataDir), '99\n');
    const kill = vi.fn();
    expect(
      reapStaleCorePid(dataDir, {
        imageName: () => undefined,
        kill,
      }),
    ).toEqual({ action: 'stale', pid: 99 });
    expect(kill).not.toHaveBeenCalled();
  });

  it('is a no-op when no pid file exists', () => {
    const dataDir = tempDataDir();
    const kill = vi.fn();
    expect(
      reapStaleCorePid(dataDir, {
        imageName: () => 'yaqmc-core',
        kill,
      }),
    ).toEqual({ action: 'absent' });
    expect(kill).not.toHaveBeenCalled();
  });
});
