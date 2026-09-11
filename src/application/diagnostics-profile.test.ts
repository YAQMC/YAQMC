import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTICS_PROFILE_PARAM,
  DIAGNOSTICS_PROFILE_STORAGE_KEY,
  DIAGNOSTICS_PROFILE_VALUE,
  diagnosticsProfileFromSearch,
  resolveDiagnosticsProfile,
} from './diagnostics-profile';

describe('playback diagnostics profile', () => {
  it('keeps production builds off whatever the query or storage says', () => {
    expect(
      resolveDiagnosticsProfile({ qaBuild: false, search: '?yaqmc-profile=qa', stored: 'qa' }),
    ).toBe('off');
    expect(resolveDiagnosticsProfile({ qaBuild: false, search: '', stored: null })).toBe('off');
  });

  it('requires an explicit opt-in inside a QA build', () => {
    expect(resolveDiagnosticsProfile({ qaBuild: true, search: '', stored: null })).toBe('off');
    expect(
      resolveDiagnosticsProfile({
        qaBuild: true,
        search: `?${DIAGNOSTICS_PROFILE_PARAM}=qa`,
        stored: null,
      }),
    ).toBe('qa');
    expect(
      resolveDiagnosticsProfile({ qaBuild: true, search: '', stored: DIAGNOSTICS_PROFILE_VALUE }),
    ).toBe('qa');
  });

  it('parses only the documented query value and falls back on junk', () => {
    expect(diagnosticsProfileFromSearch('?yaqmc-profile=other')).toBe('off');
    expect(diagnosticsProfileFromSearch('?yaqmc-profile=qa&x=1')).toBe('qa');
    expect(DIAGNOSTICS_PROFILE_STORAGE_KEY).toBe('yaqmc.diagnostics-profile');
  });
});
