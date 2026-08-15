import { definePlugin, type PluginContext, type PluginTrack } from '../../../sdk/plugin/src/index';

type Bookmark = {
  queueEntryId?: string | null;
  positionMs?: number;
  playing?: boolean;
};

function asTrack(value: unknown): PluginTrack {
  const source = value && typeof value === 'object' ? (value as PluginTrack) : {};
  return {
    id: source.id ?? null,
    title: source.title ?? null,
    queueEntryId: source.queueEntryId,
    sessionId: source.sessionId,
    durationMs: source.durationMs,
  };
}

async function restore(ctx: PluginContext): Promise<void> {
  const track = await ctx.track.get();
  const player = await ctx.player.get();
  const lyrics = await ctx.lyrics.get();
  const theme = await ctx.theme.get();
  await ctx.log.info(
    `session snapshot title=${track.title ?? 'none'} lines=${lyrics.lines.length} theme=${theme.source} pos=${player.positionMs}`,
  );
  const stored = await ctx.storage.get('bookmark');
  let bookmark: Bookmark | null = null;
  try {
    bookmark = stored.value ? (JSON.parse(stored.value) as Bookmark) : null;
  } catch {
    await ctx.log.warn('bookmark JSON was unreadable');
  }
  const duration = track.durationMs ?? 0;
  const sameEntry =
    Boolean(bookmark?.queueEntryId) && bookmark?.queueEntryId === track.queueEntryId;
  const position = bookmark?.positionMs ?? 0;
  if (
    sameEntry &&
    position > 1500 &&
    (duration === 0 || position < duration - 2000) &&
    Math.abs(position - player.positionMs) > 1200
  ) {
    await ctx.player.seek(position);
    await ctx.log.info(`restored seek ${position}`);
  }
  if (player.isPlaying || bookmark?.playing) {
    await ctx.player.play();
  }
}

export default definePlugin({
  activate(ctx) {
    const unsubscribers = [
      ctx.events.on('track.changed', (payload) => {
        const track = asTrack(payload);
        void ctx.log.info(`track.changed ${track.title ?? 'none'}`);
        void restore(ctx);
      }),
      ctx.events.on('playback.stateChanged', () => {
        void ctx.player.get().then((player) => ctx.log.info(`state playing=${player.isPlaying}`));
      }),
      ctx.events.on('playback.positionCommitted', (payload) => {
        const positionMs =
          payload && typeof payload === 'object' && 'positionMs' in payload
            ? Number((payload as { positionMs?: number }).positionMs)
            : NaN;
        void Promise.all([ctx.track.get(), ctx.player.get()]).then(([track, player]) =>
          ctx.storage.set(
            'bookmark',
            JSON.stringify({
              queueEntryId: track.queueEntryId,
              positionMs: Number.isFinite(positionMs) ? positionMs : player.positionMs,
              playing: player.isPlaying,
            }),
          ),
        );
      }),
      ctx.events.on('lyrics.lineChanged', () => {
        void ctx.lyrics.get().then((document) =>
          ctx.storage.set('lastLineCount', String(document.lines.length)),
        );
      }),
      ctx.events.on('theme.changed', () => {
        void ctx.theme.get().then((theme) => ctx.log.info(`theme.changed ${theme.source}`));
      }),
    ];
    void restore(ctx).catch((error: unknown) => {
      void ctx.log.error(String(error));
    });
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  },
});
