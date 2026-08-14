import { definePlugin } from '../../../sdk/plugin/src/index';

export default definePlugin({
  activate(ctx) {
    const unsubscribe = ctx.events.on('track.changed', (track) => {
      const payload = track as { title?: string | null };
      void ctx.log.info(`track changed: ${payload.title ?? 'none'}`);
    });
    return () => unsubscribe();
  },
});
