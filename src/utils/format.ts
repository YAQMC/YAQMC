export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatTotalDuration(durationMs: number, locale = 'en-US'): string {
  const totalMinutes = Math.round(durationMs / 60_000);
  const minutes = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'short',
  });
  if (totalMinutes < 60) return minutes.format(totalMinutes);
  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;
  const hourLabel = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'hour',
    unitDisplay: 'short',
  }).format(hours);
  return remainder === 0 ? hourLabel : `${hourLabel} ${minutes.format(remainder)}`;
}

export function joinArtistNames(artists: { name: string }[]): string {
  return artists.map((artist) => artist.name).join(', ');
}
