import { useEffect, useRef, useState } from 'react';
import { isNativeRuntime } from '../application/native-player-runtime';
import { getYaqmcClient } from '../application/yaqmc-runtime';

const client = getYaqmcClient();

const SAMPLE_WINDOW_MS = 500;

interface FrameStats {
  fps: number;
  averageMs: number;
  p95Ms: number;
  maxMs: number;
  longTasks: number;
}

function fpsTier(fps: number): 'good' | 'ok' | 'low' {
  if (fps < 30) return 'low';
  if (fps < 55) return 'ok';
  return 'good';
}

export function FpsOverlay() {
  const [stats, setStats] = useState<FrameStats | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const samples = useRef<number[]>([]);
  const previous = useRef<number | null>(null);
  const windowStart = useRef<number | null>(null);
  const longTasks = useRef(0);

  useEffect(() => {
    let frameId = 0;
    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration >= 50) longTasks.current += 1;
          }
        });
        observer.observe({ type: 'longtask', buffered: true });
      } catch {
        observer = null;
      }
    }

    const summarize = (elapsedMs: number) => {
      const frameTimes = samples.current;
      samples.current = [];
      if (frameTimes.length === 0) return;
      const sorted = [...frameTimes].sort((left, right) => left - right);
      const average = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
      const next = {
        fps: Math.round((frameTimes.length * 1_000) / elapsedMs),
        averageMs: average,
        p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? average,
        maxMs: sorted[sorted.length - 1] ?? average,
        longTasks: longTasks.current,
      };
      setStats(next);
      longTasks.current = 0;
      if (isNativeRuntime) {
        void client
          .invoke('debug_perf_sample', { sample: next })
          .then(() => setReportError(null))
          .catch((error: unknown) => setReportError(String(error)));
      }
    };

    const tick = (now: number) => {
      if (previous.current !== null) samples.current.push(now - previous.current);
      previous.current = now;
      windowStart.current ??= now;
      if (now - windowStart.current >= SAMPLE_WINDOW_MS) {
        summarize(now - windowStart.current);
        windowStart.current = now;
      }
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, []);

  return (
    <div
      className="fps-overlay"
      data-tier={stats === null ? undefined : fpsTier(stats.fps)}
      aria-hidden="true"
    >
      <strong>{stats?.fps ?? '—'}</strong>
      <span>FPS</span>
      {stats && (
        <span className="fps-overlay__detail">
          {stats.averageMs.toFixed(1)} / {stats.p95Ms.toFixed(1)} / {stats.maxMs.toFixed(0)}ms
        </span>
      )}
      {stats !== null && stats.longTasks > 0 && (
        <span className="fps-overlay__longtask">LT{stats.longTasks}</span>
      )}
      {reportError && (
        <span className="fps-overlay__longtask" title={reportError}>
          ERR
        </span>
      )}
    </div>
  );
}
