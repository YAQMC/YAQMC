import { getYaqmcClient } from './yaqmc-runtime';
import { usePlayerStore } from './player-store';

export interface PlaybackUiProbeSample {
  durationMs: number;
  rafFrames: number;
  rafFps: number;
  rafP95Ms: number;
  storeUpdates: number;
  storeHz: number;
  positionUpdates: number;
  positionHz: number;
  snapshotRevision: number;
  playerBarMutations: number;
  playerBarMutationHz: number;
  ipcSnapshots: number;
  ipcSnapshotHz: number;
}

type ProbeHost = Window & {
  __YAQMC_PLAYBACK_UI_PROBE__?: { sample: (durationMs?: number) => Promise<PlaybackUiProbeSample> };
};

export async function samplePlaybackUi(durationMs = 1_500): Promise<PlaybackUiProbeSample> {
  const client = getYaqmcClient();
  let storeUpdates = 0;
  let positionUpdates = 0;
  let lastPosition = usePlayerStore.getState().positionMs;
  let ipcSnapshots = 0;
  const stopStore = usePlayerStore.subscribe((state) => {
    storeUpdates += 1;
    if (state.positionMs !== lastPosition) {
      positionUpdates += 1;
      lastPosition = state.positionMs;
    }
  });
  const stopIpc = client.on('player://snapshot', () => {
    ipcSnapshots += 1;
  });
  const bar = document.querySelector('[data-yaqmc="player-bar"]');
  let playerBarMutations = 0;
  const observer =
    bar === null
      ? null
      : new MutationObserver((records) => {
          playerBarMutations += records.length;
        });
  observer?.observe(bar as Node, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  const frameTimes: number[] = [];
  const started = performance.now();
  let previous: number | null = null;
  let rafFrames = 0;
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      rafFrames += 1;
      if (previous !== null) frameTimes.push(now - previous);
      previous = now;
      if (now - started >= durationMs) {
        resolve();
        return;
      }
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });

  observer?.disconnect();
  stopStore();
  stopIpc();
  const elapsed = Math.max(1, performance.now() - started);
  const sorted = [...frameTimes].sort((left, right) => left - right);
  const perSecond = 1_000 / elapsed;
  return {
    durationMs: elapsed,
    rafFrames,
    rafFps: rafFrames * perSecond,
    rafP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    storeUpdates,
    storeHz: storeUpdates * perSecond,
    positionUpdates,
    positionHz: positionUpdates * perSecond,
    snapshotRevision: usePlayerStore.getState().snapshotRevision,
    playerBarMutations,
    playerBarMutationHz: playerBarMutations * perSecond,
    ipcSnapshots,
    ipcSnapshotHz: ipcSnapshots * perSecond,
  };
}

export function installPlaybackUiProbe(): () => void {
  const host = window as ProbeHost;
  host.__YAQMC_PLAYBACK_UI_PROBE__ = { sample: samplePlaybackUi };
  return () => {
    delete host.__YAQMC_PLAYBACK_UI_PROBE__;
  };
}
