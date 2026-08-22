export const lyricsPerfCounters = {
  panelCommits: 0,
  lastPanelCommitAt: 0,
};

export function noteLyricsPanelCommit(): void {
  lyricsPerfCounters.panelCommits += 1;
  lyricsPerfCounters.lastPanelCommitAt = performance.now();
}
