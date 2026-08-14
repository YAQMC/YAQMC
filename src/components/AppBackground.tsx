import { useBackgroundStyle } from '../application/preferences';
import { useCurrentSong } from '../application/player-store';
import { resolveArtworkSource } from '../application/artwork-resolver';
import { useSafeArtworkSource } from '../application/artwork-source';

export function AppBackground() {
  const current = useCurrentSong();
  const background = useBackgroundStyle();
  const desiredSource =
    background.mode === 'artwork'
      ? current
        ? resolveArtworkSource(current.artwork, 'fullscreen')
        : null
      : background.mode === 'image'
        ? background.source
        : null;
  const safeSource = useSafeArtworkSource(desiredSource);
  return (
    <div
      className="app-background"
      data-mode={background.mode}
      data-fit={background.fit}
      style={{ backgroundColor: background.mode === 'color' ? background.color : undefined }}
      aria-hidden="true"
    >
      {safeSource && (
        <img key={safeSource} className="app-background__image" src={safeSource} alt="" />
      )}
      <span className="app-background__tint" />
    </div>
  );
}
