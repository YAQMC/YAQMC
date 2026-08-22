import { describe, expect, it } from 'vitest';
import {
  DISABLE_BACKGROUNDING_OCCLUDED_WINDOWS,
  DISABLE_CALCULATE_NATIVE_WIN_OCCLUSION,
  WINDOWS_OCCLUSION_SWITCH_ALLOWLIST,
  mergeChromiumFeatureList,
  windowsOcclusionSwitches,
} from './windows-occlusion';

describe('windows occlusion Chromium switch policy', () => {
  it('is empty on non-Windows platforms', () => {
    expect(windowsOcclusionSwitches({ platform: 'linux', mode: 'auto' })).toEqual([]);
    expect(windowsOcclusionSwitches({ platform: 'darwin', mode: 'on' })).toEqual([]);
  });

  it('keeps an explicit off mode for diagnostic A/B', () => {
    expect(windowsOcclusionSwitches({ platform: 'win32', mode: 'off' })).toEqual([]);
    expect(windowsOcclusionSwitches({ platform: 'win32', mode: '0' })).toEqual([]);
  });

  it('disables occluded-window backgrounding only when explicitly requested', () => {
    expect(windowsOcclusionSwitches({ platform: 'win32', mode: 'auto' })).toEqual([]);
    expect(windowsOcclusionSwitches({ platform: 'win32', mode: 'on' })).toEqual([
      DISABLE_BACKGROUNDING_OCCLUDED_WINDOWS,
    ]);
    const returned = windowsOcclusionSwitches({ platform: 'win32', mode: 'on' });
    for (const flag of returned) {
      expect(WINDOWS_OCCLUSION_SWITCH_ALLOWLIST).toContain(flag);
    }
    expect(returned.join(' ')).not.toContain('disable-renderer-backgrounding');
    expect(returned.join(' ')).not.toContain('disable-background-timer-throttling');
  });

  it('can also disable the native occlusion tracker for a second A/B', () => {
    expect(windowsOcclusionSwitches({ platform: 'win32', mode: 'occlusion-tracker-off' })).toEqual([
      DISABLE_BACKGROUNDING_OCCLUDED_WINDOWS,
      DISABLE_CALCULATE_NATIVE_WIN_OCCLUSION,
    ]);
  });

  it('merges Chromium feature lists without clobbering siblings', () => {
    expect(mergeChromiumFeatureList(undefined, 'CalculateNativeWinOcclusion')).toBe(
      'CalculateNativeWinOcclusion',
    );
    expect(mergeChromiumFeatureList('Foo,Bar', 'CalculateNativeWinOcclusion,Bar')).toBe(
      'Foo,Bar,CalculateNativeWinOcclusion',
    );
  });
});
