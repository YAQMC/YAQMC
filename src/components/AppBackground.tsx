import { useBackgroundStyle } from '../application/preferences';
import { useCurrentSong } from '../application/player-store';

export function AppBackground() {
  const current = useCurrentSong();
  const background = useBackgroundStyle();
  const desiredSource =
    background.mode === 'artwork'
      ? (current?.artwork.src ?? null)
      : background.mode === 'image'
        ? background.source
        : null;
  return (
    <div
      className="app-background"
      data-mode={background.mode}
      data-fit={background.fit}
      style={{ backgroundColor: background.mode === 'color' ? background.color : undefined }}
      aria-hidden="true"
    >
      {desiredSource && (
        <img key={desiredSource} className="app-background__image" src={desiredSource} alt="" />
      )}
      <span className="app-background__tint" />
    </div>
  );
}
