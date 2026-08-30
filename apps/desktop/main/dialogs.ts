import path from 'node:path';

/**
 * §27.4 host half: Main path pickers. Private HostBridge methods
 * `dialog.pickSave` / `dialog.pickFile` select paths before the renderer invokes
 * Core `_to`/`_from` continuations (`diagnostics_export_bundle_to`,
 * `preferences_set_background_from`, `plugin_install_from`).
 *
 * Callers inject Electron `dialog.showSaveDialog` / `showOpenDialog` so unit
 * tests never need a display. Cancel and missing paths return `null`.
 *
 * Canonical filters preserved across the host migration:
 * - background: `app_preferences.rs` `Images` png/jpg/jpeg/webp/bmp/gif
 * - plugin package: `plugin/commands.rs` `YAQMC Plugin` yaqmc-plugin/css/js/ts
 *   plus `All files`
 * - plugin unpacked dir: `blocking_pick_folder` (no file filter)
 * - diagnostics ZIP: defaults to the downloads directory with
 *   `YAQMC-diagnostics-*.zip`; the Electron save dialog uses a zip filter
 *   and that suggested name.
 */

export type DialogFileFilter = {
  name: string;
  extensions: string[];
};

export type SaveDialogResult = {
  canceled: boolean;
  filePath?: string;
};

export type OpenDialogResult = {
  canceled: boolean;
  filePaths: string[];
};

export type SaveDialogOptions = {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: DialogFileFilter[];
};

export type OpenDialogProperties = 'openFile' | 'openDirectory' | 'multiSelections';

export type OpenDialogOptions = {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: DialogFileFilter[];
  properties?: OpenDialogProperties[];
};

export type ShowSaveDialog = (options: SaveDialogOptions) => Promise<SaveDialogResult>;
export type ShowOpenDialog = (options: OpenDialogOptions) => Promise<OpenDialogResult>;

export type PickSaveOptions = {
  filters: readonly DialogFileFilter[];
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
};

export type PickFileOptions = {
  filters: readonly DialogFileFilter[];
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
};

export type PickDirectoryOptions = {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
};

/** Suggested filename for diagnostics `pickSave`. */
export const DIAGNOSTICS_ZIP_DEFAULT_NAME = 'YAQMC-diagnostics.zip';

export const DIAGNOSTICS_ZIP_FILTERS: DialogFileFilter[] = [
  { name: 'ZIP archive', extensions: ['zip'] },
];

export const STATISTICS_JSON_FILTERS: DialogFileFilter[] = [
  { name: 'JSON document', extensions: ['json'] },
];

export const STATISTICS_CSV_FILTERS: DialogFileFilter[] = [
  { name: 'CSV document', extensions: ['csv'] },
];

export const BACKGROUND_IMAGE_FILTERS: DialogFileFilter[] = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
];

export const PLUGIN_PACKAGE_FILTERS: DialogFileFilter[] = [
  { name: 'YAQMC Plugin', extensions: ['yaqmc-plugin', 'css', 'js', 'ts'] },
  { name: 'All files', extensions: ['*'] },
];

export const PATH_PICKER_KINDS = [
  'diagnostics-zip',
  'statistics-json',
  'statistics-csv',
  'background-image',
  'plugin-package',
] as const;
export type PathPickerKind = (typeof PATH_PICKER_KINDS)[number];

const FILTERS_BY_KIND: Record<PathPickerKind, DialogFileFilter[]> = {
  'diagnostics-zip': DIAGNOSTICS_ZIP_FILTERS,
  'statistics-json': STATISTICS_JSON_FILTERS,
  'statistics-csv': STATISTICS_CSV_FILTERS,
  'background-image': BACKGROUND_IMAGE_FILTERS,
  'plugin-package': PLUGIN_PACKAGE_FILTERS,
};

/** Resolve a diagnostics save/default path to an absolute `.zip` under Downloads when relative. */
export function resolveDiagnosticsSavePath(filePath: string, downloadsDir: string): string {
  const trimmed = filePath.trim();
  const withZip = /\.zip$/i.test(trimmed) ? trimmed : `${trimmed}.zip`;
  if (path.isAbsolute(withZip)) {
    return withZip;
  }
  if (downloadsDir.length === 0) {
    return withZip;
  }
  return path.join(downloadsDir, withZip);
}

export function resolveStatisticsSavePath(
  filePath: string,
  downloadsDir: string,
  format: 'json' | 'csv',
): string {
  const trimmed = filePath.trim();
  const extension = new RegExp(`\\.${format}$`, 'i');
  const withExtension = extension.test(trimmed) ? trimmed : `${trimmed}.${format}`;
  if (path.isAbsolute(withExtension) || downloadsDir.length === 0) {
    return withExtension;
  }
  return path.join(downloadsDir, withExtension);
}

export function filtersFor(kind: PathPickerKind): DialogFileFilter[] {
  return FILTERS_BY_KIND[kind].map((filter) => ({
    name: filter.name,
    extensions: [...filter.extensions],
  }));
}

function cloneFilters(filters: readonly DialogFileFilter[]): DialogFileFilter[] {
  return filters.map((filter) => ({
    name: filter.name,
    extensions: [...filter.extensions],
  }));
}

function chosenSavePath(result: SaveDialogResult): string | null {
  if (result.canceled) {
    return null;
  }
  const path = result.filePath;
  if (path === undefined || path.length === 0) {
    return null;
  }
  return path;
}

function chosenOpenPath(result: OpenDialogResult): string | null {
  if (result.canceled) {
    return null;
  }
  const path = result.filePaths[0];
  if (path === undefined || path.length === 0) {
    return null;
  }
  return path;
}

function assignOptional(
  target: SaveDialogOptions | OpenDialogOptions,
  options: { title?: string; defaultPath?: string; buttonLabel?: string },
): void {
  if (options.title !== undefined) {
    target.title = options.title;
  }
  if (options.defaultPath !== undefined) {
    target.defaultPath = options.defaultPath;
  }
  if (options.buttonLabel !== undefined) {
    target.buttonLabel = options.buttonLabel;
  }
}

export async function pickSave(
  showSaveDialog: ShowSaveDialog,
  options: PickSaveOptions,
): Promise<string | null> {
  const dialogOptions: SaveDialogOptions = {
    filters: cloneFilters(options.filters),
  };
  assignOptional(dialogOptions, options);
  return chosenSavePath(await showSaveDialog(dialogOptions));
}

export async function pickFile(
  showOpenDialog: ShowOpenDialog,
  options: PickFileOptions,
): Promise<string | null> {
  const dialogOptions: OpenDialogOptions = {
    filters: cloneFilters(options.filters),
    properties: ['openFile'],
  };
  assignOptional(dialogOptions, options);
  return chosenOpenPath(await showOpenDialog(dialogOptions));
}

export async function pickDirectory(
  showOpenDialog: ShowOpenDialog,
  options: PickDirectoryOptions = {},
): Promise<string | null> {
  const dialogOptions: OpenDialogOptions = {
    properties: ['openDirectory'],
  };
  assignOptional(dialogOptions, options);
  return chosenOpenPath(await showOpenDialog(dialogOptions));
}
