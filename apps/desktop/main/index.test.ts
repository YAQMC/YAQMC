import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'),
  'utf8',
);

describe('host boot wiring', () => {
  it('imports tray, shortcuts, opener, and lyrics surfaces', () => {
    expect(source).toContain("from './services/tray'");
    expect(source).toContain("from './services/shortcuts'");
    expect(source).toContain("from './ipc/host-handlers'");
    expect(source).toContain("from './windows/lyrics-surfaces'");
    expect(source).toContain('lyrics-surface.cjs');
    expect(source).toContain('createTray');
    expect(source).toContain('registerGlobalShortcuts');
    expect(source).toContain('createLyricsSurfaces');
    expect(source).toContain('shell.openExternal');
  });

  it('skips tray and shortcuts during YAQMC_DESKTOP_SMOKE', () => {
    expect(source).toContain("process.env.YAQMC_DESKTOP_SMOKE === '1'");
    expect(source).toContain('installTrayAndShortcuts');
    expect(source).toMatch(/if \(smoke\) \{\s*return;/);
  });

  it('keeps the main window FACT size and sandbox flags', () => {
    expect(source).toContain('width: 1280');
    expect(source).toContain('height: 800');
    expect(source).toContain('sandbox: true');
    expect(source).toContain('contextIsolation: true');
    expect(source).toContain('nodeIntegration: false');
    expect(source).not.toContain('--no-sandbox');
  });

  it('does not auto-open OAuth or import mid-flight host modules', () => {
    expect(source).not.toContain('oauth-window');
    expect(source).not.toContain('linux-graphics');
    expect(source).not.toContain("from './dialogs'");
    expect(source).not.toContain("from './services/updater'");
    expect(source).not.toContain('lyrics-unlock');
  });

  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
