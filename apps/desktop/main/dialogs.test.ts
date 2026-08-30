import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import {
  BACKGROUND_IMAGE_FILTERS,
  DIAGNOSTICS_ZIP_DEFAULT_NAME,
  DIAGNOSTICS_ZIP_FILTERS,
  filtersFor,
  PATH_PICKER_KINDS,
  pickDirectory,
  pickFile,
  pickSave,
  PLUGIN_PACKAGE_FILTERS,
  resolveDiagnosticsSavePath,
  resolveStatisticsSavePath,
  STATISTICS_CSV_FILTERS,
  STATISTICS_JSON_FILTERS,
  type OpenDialogResult,
  type SaveDialogResult,
} from './dialogs';

const here = path.dirname(fileURLToPath(import.meta.url));

function saveDialog(result: SaveDialogResult) {
  return vi.fn(async (): Promise<SaveDialogResult> => result);
}

function openDialog(result: OpenDialogResult) {
  return vi.fn(async (): Promise<OpenDialogResult> => result);
}

describe('typed filters for the §27.4 flows', () => {
  it('covers diagnostics, statistics, background, and plugin paths', () => {
    expect(PATH_PICKER_KINDS).toEqual([
      'diagnostics-zip',
      'statistics-json',
      'statistics-csv',
      'background-image',
      'plugin-package',
    ]);
    expect(filtersFor('diagnostics-zip')).toEqual(DIAGNOSTICS_ZIP_FILTERS);
    expect(DIAGNOSTICS_ZIP_FILTERS).toEqual([{ name: 'ZIP archive', extensions: ['zip'] }]);
    expect(DIAGNOSTICS_ZIP_DEFAULT_NAME).toBe('YAQMC-diagnostics.zip');
    expect(filtersFor('statistics-json')).toEqual(STATISTICS_JSON_FILTERS);
    expect(STATISTICS_JSON_FILTERS).toEqual([{ name: 'JSON document', extensions: ['json'] }]);
    expect(filtersFor('statistics-csv')).toEqual(STATISTICS_CSV_FILTERS);
    expect(STATISTICS_CSV_FILTERS).toEqual([{ name: 'CSV document', extensions: ['csv'] }]);

    expect(filtersFor('background-image')).toEqual(BACKGROUND_IMAGE_FILTERS);
    expect(BACKGROUND_IMAGE_FILTERS).toEqual([
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
    ]);

    expect(filtersFor('plugin-package')).toEqual(PLUGIN_PACKAGE_FILTERS);
    expect(PLUGIN_PACKAGE_FILTERS).toEqual([
      { name: 'YAQMC Plugin', extensions: ['yaqmc-plugin', 'css', 'js', 'ts'] },
      { name: 'All files', extensions: ['*'] },
    ]);
  });
});

describe('resolveStatisticsSavePath', () => {
  it('uses Downloads for relative paths and appends only the selected format', () => {
    const downloads = path.join(os.tmpdir(), 'yaqmc-downloads');
    const absolute = path.join(os.tmpdir(), 'statistics.json');
    expect(resolveStatisticsSavePath(absolute, downloads, 'json')).toBe(absolute);
    expect(resolveStatisticsSavePath('listening', downloads, 'json')).toBe(
      path.join(downloads, 'listening.json'),
    );
    expect(resolveStatisticsSavePath('listening', downloads, 'csv')).toBe(
      path.join(downloads, 'listening.csv'),
    );
  });
});

describe('resolveDiagnosticsSavePath', () => {
  it('keeps an absolute zip path and joins a relative name under Downloads', () => {
    const exportsZip = path.join(os.tmpdir(), 'yaqmc-exports', 'YAQMC-diagnostics.zip');
    const downloads = path.join(os.tmpdir(), 'yaqmc-downloads');
    expect(resolveDiagnosticsSavePath(exportsZip, downloads)).toBe(exportsZip);
    expect(resolveDiagnosticsSavePath('YAQMC-diagnostics.zip', downloads)).toBe(
      path.join(downloads, 'YAQMC-diagnostics.zip'),
    );
    expect(resolveDiagnosticsSavePath('report', downloads)).toBe(
      path.join(downloads, 'report.zip'),
    );
    expect(resolveDiagnosticsSavePath('YAQMC-diagnostics.zip', '')).toBe('YAQMC-diagnostics.zip');
  });
});

describe('pickSave', () => {
  it('passes zip filters and the diagnostics default name to showSaveDialog', async () => {
    const showSaveDialog = saveDialog({
      canceled: false,
      filePath: 'D:\\exports\\YAQMC-diagnostics.zip',
    });
    await expect(
      pickSave(showSaveDialog, {
        filters: DIAGNOSTICS_ZIP_FILTERS,
        defaultPath: DIAGNOSTICS_ZIP_DEFAULT_NAME,
        title: 'Export diagnostics bundle',
      }),
    ).resolves.toBe('D:\\exports\\YAQMC-diagnostics.zip');
    expect(showSaveDialog).toHaveBeenCalledOnce();
    expect(showSaveDialog).toHaveBeenCalledWith({
      title: 'Export diagnostics bundle',
      defaultPath: DIAGNOSTICS_ZIP_DEFAULT_NAME,
      filters: DIAGNOSTICS_ZIP_FILTERS,
    });
  });

  it('returns null when the save dialog is canceled or has no path', async () => {
    await expect(
      pickSave(saveDialog({ canceled: true }), { filters: DIAGNOSTICS_ZIP_FILTERS }),
    ).resolves.toBe(null);
    await expect(
      pickSave(saveDialog({ canceled: false, filePath: '' }), { filters: DIAGNOSTICS_ZIP_FILTERS }),
    ).resolves.toBe(null);
    await expect(
      pickSave(saveDialog({ canceled: false }), { filters: DIAGNOSTICS_ZIP_FILTERS }),
    ).resolves.toBe(null);
  });
});

describe('pickFile', () => {
  it('opens a single file with background-image filters', async () => {
    const showOpenDialog = openDialog({ canceled: false, filePaths: ['/tmp/wall.png'] });
    await expect(
      pickFile(showOpenDialog, {
        filters: BACKGROUND_IMAGE_FILTERS,
        title: 'Choose background image',
      }),
    ).resolves.toBe('/tmp/wall.png');
    expect(showOpenDialog).toHaveBeenCalledWith({
      title: 'Choose background image',
      filters: BACKGROUND_IMAGE_FILTERS,
      properties: ['openFile'],
    });
  });

  it('opens a single file with plugin-package filters', async () => {
    const showOpenDialog = openDialog({
      canceled: false,
      filePaths: ['/plugins/pack.yaqmc-plugin'],
    });
    await expect(pickFile(showOpenDialog, { filters: PLUGIN_PACKAGE_FILTERS })).resolves.toBe(
      '/plugins/pack.yaqmc-plugin',
    );
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: PLUGIN_PACKAGE_FILTERS,
        properties: ['openFile'],
      }),
    );
  });

  it('returns null when the open dialog is canceled or empty', async () => {
    await expect(
      pickFile(openDialog({ canceled: true, filePaths: ['/x'] }), {
        filters: BACKGROUND_IMAGE_FILTERS,
      }),
    ).resolves.toBe(null);
    await expect(
      pickFile(openDialog({ canceled: false, filePaths: [] }), {
        filters: BACKGROUND_IMAGE_FILTERS,
      }),
    ).resolves.toBe(null);
    await expect(
      pickFile(openDialog({ canceled: false, filePaths: [''] }), {
        filters: BACKGROUND_IMAGE_FILTERS,
      }),
    ).resolves.toBe(null);
  });
});

describe('pickDirectory', () => {
  it('picks an unpacked plugin directory without file filters', async () => {
    const showOpenDialog = openDialog({ canceled: false, filePaths: ['/plugins/unpacked'] });
    await expect(
      pickDirectory(showOpenDialog, { title: 'Choose unpacked plugin directory' }),
    ).resolves.toBe('/plugins/unpacked');
    expect(showOpenDialog).toHaveBeenCalledWith({
      title: 'Choose unpacked plugin directory',
      properties: ['openDirectory'],
    });
    const directoryOptions = showOpenDialog.mock.calls.at(0)?.at(0) as
      { filters?: unknown } | undefined;
    expect(directoryOptions?.filters).toBeUndefined();
  });

  it('returns null when the directory dialog is canceled', async () => {
    await expect(pickDirectory(openDialog({ canceled: true, filePaths: [] }))).resolves.toBe(null);
  });
});

describe('host wiring', () => {
  it('is used by host-handlers, not imported from Main index.ts, and is not under services/', () => {
    const index = readFileSync(path.join(here, 'index.ts'), 'utf8');
    const handlers = readFileSync(path.join(here, 'ipc/host-handlers.ts'), 'utf8');
    expect(index).not.toMatch(/from ['"]\.\/dialogs['"]/);
    expect(index).toContain('dialog.showSaveDialog');
    expect(index).toContain('dialog.showOpenDialog');
    expect(handlers).toMatch(/from ['"]\.\.\/dialogs['"]/);
    expect(here.replaceAll('\\', '/')).toMatch(/apps\/desktop\/main$/);
    expect(here.replaceAll('\\', '/')).not.toMatch(/\/services$/);
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
