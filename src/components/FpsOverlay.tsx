import { useEffect, useRef, useState } from 'react';

const SAMPLE_WINDOW_MS = 500;

function fpsTier(fps: number): 'good' | 'ok' | 'low' {
  if (fps < 30) return 'low';
  if (fps < 55) return 'ok';
  return 'good';
}

export function FpsOverlay() {
  const [fps, setFps] = useState<number | null>(null);
  const frames = useRef(0);
  const windowStart = useRef<number | null>(null);

  useEffect(() => {
    let frameId = 0;
    frames.current = 0;
    windowStart.current = null;
    const tick = (now: number) => {
      windowStart.current ??= now;
      if (now - windowStart.current >= SAMPLE_WINDOW_MS) {
        setFps(Math.round((frames.current * 1_000) / (now - windowStart.current)));
        frames.current = 0;
        windowStart.current = now;
      }
      frames.current += 1;
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  return (
    <div
      className="fps-overlay"
      data-tier={fps === null ? undefined : fpsTier(fps)}
      aria-hidden="true"
    >
      <strong>{fps ?? '—'}</strong>
      <span>FPS</span>
    </div>
  );
}
