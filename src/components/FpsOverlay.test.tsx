import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FpsOverlay } from './FpsOverlay';

type RafHandle = number;
type FrameCallback = (time: number) => void;

function installFakeRaf() {
  let nextId: RafHandle = 1;
  const pending = new Map<RafHandle, FrameCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameCallback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = vi.fn((id: RafHandle) => {
    pending.delete(id);
  });
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
  return {
    step(time: number) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(time);
    },
  };
}

function advanceFrames(
  raf: ReturnType<typeof installFakeRaf>,
  count: number,
  intervalMs: number,
  clock: { time: number } = { time: 1_000 },
) {
  act(() => {
    for (let frame = 1; frame <= count; frame += 1) {
      clock.time += intervalMs;
      raf.step(clock.time);
    }
  });
}

describe('FpsOverlay', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the sampled frames per second', () => {
    const raf = installFakeRaf();
    render(<FpsOverlay />);
    advanceFrames(raf, 17, 33.33);
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('marks low frame rates in the overlay tier', () => {
    const raf = installFakeRaf();
    const { container } = render(<FpsOverlay />);
    advanceFrames(raf, 12, 50);
    const overlay = container.querySelector('.fps-overlay');
    expect(overlay?.getAttribute('data-tier')).toBe('low');
  });

  it('classifies tiers by frames per second', () => {
    const raf = installFakeRaf();
    const { container } = render(<FpsOverlay />);
    const clock = { time: 1_000 };
    advanceFrames(raf, 17, 33.33, clock);
    expect(container.querySelector('.fps-overlay')?.getAttribute('data-tier')).toBe('ok');
    advanceFrames(raf, 61, 8.33, clock);
    expect(container.querySelector('.fps-overlay')?.getAttribute('data-tier')).toBe('good');
  });

  it('cancels its frame loop on unmount', () => {
    const raf = installFakeRaf();
    const { unmount } = render(<FpsOverlay />);
    raf.step(1_000);
    unmount();
    expect(vi.mocked(window.cancelAnimationFrame)).toHaveBeenCalled();
  });
});
