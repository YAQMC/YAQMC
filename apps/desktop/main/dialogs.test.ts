import { readFileSync } from 'node:fs';
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
  type OpenDialogOptions,
  type OpenDialogResult,
  type SaveDialogOptions,
  type SaveDialogResult,
} from './dialogs';

const here = path.dirname(fileURLToPath(import.meta.url));

function saveDialog(result: SaveDialogResult) {
  return vi.fn(async (_options: SaveDialogOptions): Promise<SaveDialogResult> => result);
}

function openDialog(result: OpenDialogResult) {
  return vi.fn(async (_options: OpenDialogOptions): Promise<OpenDialogResult> => result);
}

describe('typed filters for the three §27.4 flows', () => {
  it('covers diagnostics zip, background image, and plugin package', () => {
    expect(PATH_PICKER_KINDS).toEqual(['diagnostics-zip', 'background-image', 'plugin-package']);
    expect(filtersFor('diagnostics-zip')).toEqual(DIAGNOSTICS_ZIP_FILTERS);
    expect(DIAGNOSTICS_ZIP_FILTERS).toEqual([{ name: 'ZIP archive', extensions: ['zip'] }]);
    expect(DIAGNOSTICS_ZIP_DEFAULT_NAME).toBe('YAQMC-diagnostics.zip');

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
    await expect(pickSave(saveDialog({ canceled: true }), { filters: DIAGNOSTICS_ZIP_FILTERS })).resolves.toBe(
      null,
    );
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
    await expect(
      pickFile(showOpenDialog, { filters: PLUGIN_PACKAGE_FILTERS }),
    ).resolves.toBe('/plugins/pack.yaqmc-plugin');
    expect(showOpenDialog.mock.calls[0]?.[0].filters).toEqual(PLUGIN_PACKAGE_FILTERS);
    expect(showOpenDialog.mock.calls[0]?.[0].properties).toEqual(['openFile']);
  });

  it('returns null when the open dialog is canceled or empty', async () => {
    await expect(
      pickFile(openDialog({ canceled: true, filePaths: ['/x'] }), { filters: BACKGROUND_IMAGE_FILTERS }),
    ).resolves.toBe(null);
    await expect(
      pickFile(openDialog({ canceled: false, filePaths: [] }), { filters: BACKGROUND_IMAGE_FILTERS }),
    ).resolves.toBe(null);
    await expect(
      pickFile(openDialog({ canceled: false, filePaths: [''] }), { filters: BACKGROUND_IMAGE_FILTERS }),
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
    expect(showOpenDialog.mock.calls[0]?.[0].filters).toBeUndefined();
  });

  it('returns null when the directory dialog is canceled', async () => {
    await expect(pickDirectory(openDialog({ canceled: true, filePaths: [] }))).resolves.toBe(null);
  });
});

describe('unwired status', () => {
  it('is not imported from Main index.ts and is not under services/', () => {
    const index = readFileSync(path.join(here, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/from ['"]\.\/dialogs['"]/);
    expect(here.replaceAll('\\', '/')).toMatch(/apps\/desktop\/main$/);
    expect(here.replaceAll('\\', '/')).not.toMatch(/\/services$/);
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
