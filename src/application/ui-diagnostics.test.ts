import { describe, expect, it } from 'vitest';
import { uiDiagnosticsEnabled } from './ui-diagnostics';

describe('renderer UI diagnostics gate', () => {
  it('keeps ordinary release windows free of test probes', () => {
    expect(uiDiagnosticsEnabled('', 'release')).toBe(false);
    expect(uiDiagnosticsEnabled('?provider=fake', 'release')).toBe(false);
  });

  it('allows only an explicit QA query in a release renderer', () => {
    expect(uiDiagnosticsEnabled('?uiDiagnostics=1', 'release')).toBe(true);
    expect(uiDiagnosticsEnabled('?uiDiagnostics=0', 'release')).toBe(false);
  });

  it('keeps developer diagnostics available without a query flag', () => {
    expect(uiDiagnosticsEnabled('', 'development')).toBe(true);
  });
});
