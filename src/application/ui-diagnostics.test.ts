import { describe, expect, it } from 'vitest';
import { uiDiagnosticsEnabled } from './ui-diagnostics';

describe('renderer UI diagnostics gate', () => {
  it('keeps ordinary release windows free of test probes', () => {
    expect(uiDiagnosticsEnabled('', 'release')).toBe(false);
    expect(uiDiagnosticsEnabled('?provider=fake', 'release')).toBe(false);
  });

  it('cannot enable diagnostics through a release query', () => {
    expect(uiDiagnosticsEnabled('?uiDiagnostics=1', 'release')).toBe(false);
    expect(uiDiagnosticsEnabled('?uiDiagnostics=0', 'release')).toBe(false);
  });

  it('keeps developer diagnostics available without a query flag', () => {
    expect(uiDiagnosticsEnabled('', 'development')).toBe(true);
  });
});
