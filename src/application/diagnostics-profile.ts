/**
 * Performance HUD gating.
 *
 * The FPS/latency overlay is a development/QA tool. It is compiled out of
 * production renderer bundles (`vite build` without `YAQMC_QA_BUILD=1`) and,
 * even in a QA build, stays off until the user explicitly enables the debug
 * counter in Settings. Ordinary runs therefore never render it by default.
 */
export const DIAGNOSTICS_PROFILE_PARAM = 'yaqmc-profile';
export const DIAGNOSTICS_PROFILE_VALUE = 'qa';
export const DIAGNOSTICS_PROFILE_STORAGE_KEY = 'yaqmc.diagnostics-profile';

export type DiagnosticsProfile = 'off' | 'qa';

export function isPlaybackDiagnosticsBuild(): boolean {
  return __YAQMC_QA_BUILD__ === true;
}

export function diagnosticsProfileFromSearch(search: string): DiagnosticsProfile {
  try {
    const value = new URLSearchParams(search).get(DIAGNOSTICS_PROFILE_PARAM);
    return value === DIAGNOSTICS_PROFILE_VALUE ? 'qa' : 'off';
  } catch {
    return 'off';
  }
}

export function resolveDiagnosticsProfile(input: {
  qaBuild: boolean;
  search: string;
  stored: string | null;
}): DiagnosticsProfile {
  if (!input.qaBuild) return 'off';
  if (input.stored === DIAGNOSTICS_PROFILE_VALUE) return 'qa';
  return diagnosticsProfileFromSearch(input.search);
}
