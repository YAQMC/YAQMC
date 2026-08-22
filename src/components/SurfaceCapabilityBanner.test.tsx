import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  SurfaceCapabilityBanner,
  shouldShowSurfaceCapabilityBanner,
  surfaceCapabilitiesFromDiagnostics,
  type SurfaceCapabilitySnapshot,
} from './SurfaceCapabilityBanner';

function caps(overrides: Partial<SurfaceCapabilitySnapshot> = {}): SurfaceCapabilitySnapshot {
  return {
    backend: 'win32',
    reliableAlwaysOnTop: true,
    reliableClickThrough: true,
    limitations: [],
    ...overrides,
  };
}

describe('shouldShowSurfaceCapabilityBanner', () => {
  it('hides when capabilities are missing or fully reliable', () => {
    expect(shouldShowSurfaceCapabilityBanner(null)).toBe(false);
    expect(shouldShowSurfaceCapabilityBanner(undefined)).toBe(false);
    expect(shouldShowSurfaceCapabilityBanner(caps())).toBe(false);
    expect(shouldShowSurfaceCapabilityBanner(caps({ backend: 'x11' }))).toBe(false);
    expect(shouldShowSurfaceCapabilityBanner(caps({ backend: 'xwayland' }))).toBe(false);
  });

  it('shows for native Wayland backends and unreliable overlay flags', () => {
    expect(shouldShowSurfaceCapabilityBanner(caps({ backend: 'wayland-native' }))).toBe(true);
    expect(shouldShowSurfaceCapabilityBanner(caps({ backend: 'native-wayland' }))).toBe(true);
    expect(shouldShowSurfaceCapabilityBanner(caps({ backend: 'wayland' }))).toBe(true);
    expect(shouldShowSurfaceCapabilityBanner(caps({ reliableAlwaysOnTop: false }))).toBe(true);
    expect(shouldShowSurfaceCapabilityBanner(caps({ reliableClickThrough: false }))).toBe(true);
    expect(shouldShowSurfaceCapabilityBanner(caps({ limitations: ['degraded'] }))).toBe(true);
  });

  it('shows the XWayland session note from limitations even though overlays stay reliable', () => {
    expect(
      shouldShowSurfaceCapabilityBanner(
        caps({
          backend: 'xwayland',
          limitations: [
            'The desktop session is Wayland, but YAQMC is using an X11/XWayland window backend.',
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('SurfaceCapabilityBanner', () => {
  it('stays hidden for a reliable Win32 surface', () => {
    const { container } = render(<SurfaceCapabilityBanner capabilities={caps()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders limitation copy in a status banner on native Wayland', () => {
    const limitation =
      'Native Wayland does not guarantee absolute placement, click-through, or always-on-top overlay semantics.';
    render(
      <SurfaceCapabilityBanner
        capabilities={caps({
          backend: 'wayland-native',
          reliableAlwaysOnTop: false,
          reliableClickThrough: false,
          limitations: [limitation],
        })}
      />,
    );
    const banner = screen.getByRole('status');
    expect(banner).toHaveClass('settings-capability-note');
    expect(banner).toHaveTextContent(limitation);
    expect(banner).toHaveAttribute('data-backend', 'wayland-native');
  });

  it('still exposes a status banner when flags degrade without limitation strings', () => {
    render(
      <SurfaceCapabilityBanner
        capabilities={caps({ reliableAlwaysOnTop: false, limitations: [] })}
      />,
    );
    expect(screen.getByRole('status')).toHaveAttribute('data-reliable-always-on-top', 'false');
  });
});

describe('surfaceCapabilitiesFromDiagnostics', () => {
  it('maps native Wayland diagnostics notes onto the lyrics banner snapshot', () => {
    const snapshot = surfaceCapabilitiesFromDiagnostics({
      os: 'linux',
      linux: { displayBackend: 'wayland-native' },
      capabilities: {
        reliableAlwaysOnTop: false,
        clickThrough: false,
        notes: ['Native Wayland overlay note.'],
      },
    });
    expect(snapshot).toEqual({
      backend: 'wayland-native',
      reliableAlwaysOnTop: false,
      reliableClickThrough: false,
      limitations: ['Native Wayland overlay note.'],
    });
    expect(shouldShowSurfaceCapabilityBanner(snapshot)).toBe(true);
  });
});
