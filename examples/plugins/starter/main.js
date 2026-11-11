/* global definePlugin */
// Plain JavaScript: edit, pack, and import. No compiler or YAQMC source tree is required.

definePlugin({
  async activate(ctx) {
    await ctx.ui.lyrics.register({ id: 'minimize', label: '最小化', windowAction: 'minimize' });
    await ctx.ui.lyrics.register({
      id: 'maximize',
      label: '最大化 / 还原',
      windowAction: 'toggleMaximize',
    });
    await ctx.ui.lyrics.register({ id: 'close', label: '关闭窗口', windowAction: 'close' });
    await ctx.ui.lyrics.register({ id: 'track-info', label: '歌曲信息', icon: 'info' });

    const unsubscribe = ctx.events.on('ui.action', (payload) => {
      if (!payload || typeof payload !== 'object' || !('slot' in payload) || !('id' in payload))
        return;
      if (payload.slot !== 'lyrics' || payload.id !== 'track-info') return;
      void showTrack().catch((error) => ctx.log.error(String(error)));
    });

    async function showTrack() {
      const track = await ctx.track.get();
      const message = [track.title || '未播放歌曲', ...(track.artists || [])].join(' · ');
      await ctx.ui.notify({ level: 'info', message: Array.from(message).slice(0, 40).join('') });
    }

    // YAQMC also clears all registrations automatically when the plugin stops.
    return unsubscribe;
  },
});
