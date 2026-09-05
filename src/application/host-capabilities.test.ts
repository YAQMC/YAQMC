import { describe, expect, it } from 'vitest';
import { isAndroidPhoneRuntime } from './host-capabilities';

describe('isAndroidPhoneRuntime', () => {
  it('uses the stable smallest display dimension at the 600dp phone boundary', () => {
    expect(isAndroidPhoneRuntime('android', { width: 393, height: 852 })).toBe(true);
    expect(isAndroidPhoneRuntime('android', { width: 852, height: 393 })).toBe(true);
    expect(isAndroidPhoneRuntime('android', { width: 600, height: 960 })).toBe(false);
    expect(isAndroidPhoneRuntime('android', { width: 1280, height: 800 })).toBe(false);
  });

  it('never classifies non-Android or invalid displays as Android phones', () => {
    expect(isAndroidPhoneRuntime('electron', { width: 393, height: 852 })).toBe(false);
    expect(isAndroidPhoneRuntime('android', { width: 0, height: 852 })).toBe(false);
    expect(isAndroidPhoneRuntime('android', null)).toBe(false);
  });
});
