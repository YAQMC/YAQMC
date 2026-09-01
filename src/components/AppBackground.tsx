import { useBackgroundStyle } from '../application/preferences';
import { useCurrentSong } from '../application/player-store';
import { resolveArtworkSource } from '../application/artwork-resolver';
import { useSafeArtworkSource } from '../application/artwork-source';
import { useBlurredArtwork } from '../application/blurred-artwork';

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
  const safeSource = useSafeArtworkSource(desiredSource, { pendingRemote: 'hide' });
  const preblurred = useBlurredArtwork(background.mode === 'artwork' ? safeSource : null);
  const imageSrc = background.mode === 'artwork' ? (preblurred ?? safeSource) : safeSource;
  return (
    <div
      className="app-background"
      data-mode={background.mode}
      data-fit={background.fit}
      style={{
        backgroundColor:
          background.mode === 'color' || background.mode === 'image' ? background.color : undefined,
      }}
      aria-hidden="true"
    >
      {imageSrc && (
        <img
          className="app-background__image"
          src={imageSrc}
          alt=""
          data-preblurred={preblurred ? true : undefined}
        />
      )}
      <span className="app-background__tint" />
    </div>
  );
}
