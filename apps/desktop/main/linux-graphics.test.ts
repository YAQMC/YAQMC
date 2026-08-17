import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRAME_HARD_CAP_BYTES } from '@yaqmc/client';
import {
  LINUX_GRAPHICS_SWITCH_ALLOWLIST,
  linuxGraphicsDiagnostics,
  linuxGraphicsSwitches,
  type LinuxGraphicsOptions,
} from './linux-graphics';

const policySource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'linux-graphics.ts'),
  'utf8',
);

const FORBIDDEN_SWITCHES = [['--', 'no-sandbox'].join(''), ['--', 'disable-web-security'].join('')];

function switches(
  overrides: Partial<LinuxGraphicsOptions> & Pick<LinuxGraphicsOptions, 'platform'>,
): readonly string[] {
  return linuxGraphicsSwitches({
    wayland: false,
    nvidia: false,
    mode: 'auto',
    ...overrides,
  });
}

function expectAllowlistedAndSafe(returned: readonly string[]): void {
  for (const flag of returned) {
    expect(LINUX_GRAPHICS_SWITCH_ALLOWLIST, flag).toContain(flag);
  }
  for (const forbidden of FORBIDDEN_SWITCHES) {
    expect(returned).not.toContain(forbidden);
    expect(returned.some((flag) => flag.includes(forbidden))).toBe(false);
  }
  expect(returned).not.toContain('--ozone-platform-hint=auto');
}

describe('linux graphics Chromium switch policy', () => {
  it('returns an empty list on Windows for every mode', () => {
    for (const mode of ['auto', 'native-wayland', 'gpu-off', 'software', 'vaapi-on']) {
      const returned = switches({ platform: 'win32', wayland: true, nvidia: true, mode });
      expect(returned, mode).toEqual([]);
      expectAllowlistedAndSafe(returned);
    }
  });

  it('returns an empty list on non-Linux platforms', () => {
    expect(switches({ platform: 'darwin', mode: 'gpu-off' })).toEqual([]);
    expect(switches({ platform: 'linux' })).toEqual([]);
  });

  it('keeps Chromium defaults on Linux auto, including NVIDIA + Wayland (no WebKitGTK copy)', () => {
    const returned = switches({ platform: 'linux', wayland: true, nvidia: true, mode: 'auto' });
    expect(returned).toEqual([]);
    expectAllowlistedAndSafe(returned);
  });

  it('does not emit flags for WebKitGTK-only YAQMC_LINUX_RENDERER names', () => {
    for (const mode of [
      'baseline',
      'x11',
      'dmabuf',
      'native',
      'disable-dmabuf',
      'compatibility',
      'compositing-off',
      '',
      'unknown',
    ]) {
      expect(switches({ platform: 'linux', wayland: true, nvidia: true, mode }), mode).toEqual([]);
    }
  });

  it('maps native-wayland to ozone wayland only', () => {
    const returned = switches({ platform: 'linux', wayland: false, mode: 'native-wayland' });
    expect(returned).toEqual(['--ozone-platform=wayland']);
    expectAllowlistedAndSafe(returned);
  });

  it('maps gpu-off and deprecated software/safe renderer modes to disable-gpu', () => {
    for (const mode of ['gpu-off', 'software', 'safe', 'GPU-OFF', ' Software ']) {
      const returned = switches({ platform: 'linux', mode });
      expect(returned, mode).toEqual(['--disable-gpu']);
      expectAllowlistedAndSafe(returned);
    }
  });

  it('maps vaapi-on to the VideoDecode feature flag and leaves it off by default', () => {
    const returned = switches({ platform: 'linux', mode: 'vaapi-on' });
    expect(returned).toEqual(['--enable-features=VaapiVideoDecodeLinuxGL']);
    expectAllowlistedAndSafe(returned);
    expect(switches({ platform: 'linux', mode: 'auto' })).not.toContain(
      '--enable-features=VaapiVideoDecodeLinuxGL',
    );
  });

  it('never returns SEC-03 forbidden switches from any policy row', () => {
    const modes = [
      'auto',
      'native-wayland',
      'gpu-off',
      'software',
      'safe',
      'vaapi-on',
      'dmabuf',
      'compositing-off',
    ];
    for (const platform of ['linux', 'win32', 'darwin']) {
      for (const mode of modes) {
        expectAllowlistedAndSafe(
          switches({
            platform,
            wayland: true,
            nvidia: true,
            mode,
          }),
        );
      }
    }
  });

  it('is a policy table only: no Electron command-line wiring', () => {
    expect(policySource).not.toMatch(/from ['"]electron['"]/);
    expect(policySource).not.toMatch(/\.appendSwitch\s*\(/);
    expect(policySource).not.toMatch(/\bprocess\.env\b/);
    for (const forbidden of FORBIDDEN_SWITCHES) {
      expect(policySource.includes(forbidden)).toBe(false);
    }
  });
});

describe('linuxGraphicsDiagnostics', () => {
  it('marks deprecatedEnv only for non-auto YAQMC_LINUX_RENDERER modes', () => {
    expect(
      linuxGraphicsDiagnostics({
        platform: 'linux',
        wayland: false,
        nvidia: false,
        mode: 'gpu-off',
        fromDeprecatedEnv: true,
      }),
    ).toEqual({
      platform: 'linux',
      mode: 'gpu-off',
      canonicalMode: 'gpu-off',
      switches: ['--disable-gpu'],
      deprecatedEnv: true,
    });
    expect(
      linuxGraphicsDiagnostics({
        platform: 'linux',
        wayland: false,
        nvidia: false,
        mode: 'auto',
        fromDeprecatedEnv: true,
      }).deprecatedEnv,
    ).toBe(false);
    expect(
      linuxGraphicsDiagnostics({
        platform: 'win32',
        wayland: false,
        nvidia: false,
        mode: 'Native-Wayland',
      }),
    ).toEqual({
      platform: 'win32',
      mode: 'Native-Wayland',
      canonicalMode: 'native-wayland',
      switches: [],
      deprecatedEnv: false,
    });
  });
});

describe('host boot wiring', () => {
  it('applies policy switches from Main before ready', () => {
    const index = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
      'utf8',
    );
    expect(index).toContain('linuxGraphicsSwitches');
    expect(index).toContain('app.commandLine.appendSwitch');
    expect(index.indexOf('applyLinuxGraphicsSwitches();')).toBeLessThan(index.indexOf('app.whenReady()'));
    expect(index).toContain("process.env.YAQMC_DESKTOP_SMOKE === '1'");
    expect(index).toMatch(/if \(smoke\) \{\s*return;/);
    for (const forbidden of FORBIDDEN_SWITCHES) {
      expect(index.includes(forbidden)).toBe(false);
    }
  });
});

describe('protocol cap', () => {
  it('leaves the 32 MiB hard cap unchanged', () => {
    expect(FRAME_HARD_CAP_BYTES).toBe(32 * 1024 * 1024);
  });
});
