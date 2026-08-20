import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const CORE_PID_FILE = 'core.pid';

export type ProcessProbe = {
  imageName(pid: number): string | undefined;
  kill(pid: number): void;
};

export type ReapStaleCorePidResult =
  | { action: 'absent' }
  | { action: 'stale'; pid: number | undefined }
  | { action: 'killed'; pid: number; image: string }
  | { action: 'ignored'; pid: number; image: string };

export function corePidPath(dataDir: string): string {
  return path.join(dataDir, CORE_PID_FILE);
}

export function parsePidFile(contents: string): number | undefined {
  const line = contents.trim().split(/\s+/u)[0];
  if (!line) {
    return undefined;
  }
  const pid = Number.parseInt(line, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return pid;
}

export function isCoreImageName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const base = name.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
  return base === 'yaqmc-core' || base === 'yaqmc-core.exe';
}

export function defaultProcessProbe(): ProcessProbe {
  return {
    imageName(pid) {
      return lookupProcessImage(pid);
    },
    kill(pid) {
      try {
        process.kill(pid);
      } catch {
        // Process already gone.
      }
    },
  };
}

export function lookupProcessImage(pid: number, platform = process.platform): string | undefined {
  if (platform === 'win32') {
    try {
      const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      }).trim();
      if (!output.startsWith('"')) {
        return undefined;
      }
      const name = output.split(',')[0]?.replaceAll('"', '');
      return name || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kill a leftover yaqmc-core only when `{data}/core.pid` still names that image.
 * Unrelated PIDs (including PID reuse) are left alone. Port 19532 is not scanned.
 */
export function reapStaleCorePid(
  dataDir: string,
  probe: ProcessProbe = defaultProcessProbe(),
): ReapStaleCorePidResult {
  const file = corePidPath(dataDir);
  if (!existsSync(file)) {
    return { action: 'absent' };
  }
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return { action: 'absent' };
  }
  const pid = parsePidFile(contents);
  if (pid === undefined) {
    removePidFile(file);
    return { action: 'stale', pid: undefined };
  }
  const image = probe.imageName(pid);
  if (!image) {
    removePidFile(file);
    return { action: 'stale', pid };
  }
  if (!isCoreImageName(image)) {
    return { action: 'ignored', pid, image };
  }
  probe.kill(pid);
  removePidFile(file);
  return { action: 'killed', pid, image };
}

function removePidFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Best-effort; the next core overwrites the file.
  }
}
