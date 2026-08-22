export const UI_DIAGNOSTICS_QUERY_KEY = 'uiDiagnostics';

/**
 * Renderer-only test and performance hooks stay available in development and
 * explicit QA launches, but are absent from an ordinary release window.
 */
export function uiDiagnosticsEnabled(
  search: string = window.location.search,
  buildType: string = __YAQMC_BUILD_TYPE__,
): boolean {
  if (buildType !== 'release') return true;
  return new URLSearchParams(search).get(UI_DIAGNOSTICS_QUERY_KEY) === '1';
}
