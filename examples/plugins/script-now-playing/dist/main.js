definePlugin({
  activate(ctx) {
    var unsubscribers = [];

    function asNumber(value) {
      var n = Number(value);
      return isFinite(n) ? n : 0;
    }

    async function restore() {
      var track = await ctx.track.get();
      var player = await ctx.player.get();
      var lyrics = await ctx.lyrics.get();
      var theme = await ctx.theme.get();
      await ctx.log.info(
        'session snapshot title=' +
          (track.title || 'none') +
          ' lines=' +
          (lyrics.lines ? lyrics.lines.length : 0) +
          ' theme=' +
          theme.source +
          ' pos=' +
          player.positionMs,
      );
      var stored = await ctx.storage.get('bookmark');
      var bookmark = null;
      try {
        bookmark = stored && stored.value ? JSON.parse(stored.value) : null;
      } catch (error) {
        await ctx.log.warn('bookmark JSON was unreadable');
      }
      var duration = asNumber(track.durationMs);
      var position = bookmark && asNumber(bookmark.positionMs);
      var sameEntry =
        bookmark &&
        bookmark.queueEntryId &&
        bookmark.queueEntryId === track.queueEntryId;
      if (
        sameEntry &&
        position > 1500 &&
        (duration === 0 || position < duration - 2000) &&
        Math.abs(position - player.positionMs) > 1200
      ) {
        await ctx.player.seek(position);
        await ctx.log.info('restored seek ' + position);
      }
      if (player.isPlaying || (bookmark && bookmark.playing)) {
        await ctx.player.play();
      }
    }

    unsubscribers.push(
      ctx.events.on('track.changed', function (payload) {
        var title = payload && payload.title ? payload.title : 'none';
        void ctx.log.info('track.changed ' + title);
        void restore();
      }),
    );
    unsubscribers.push(
      ctx.events.on('playback.stateChanged', function () {
        void ctx.player.get().then(function (player) {
          return ctx.log.info('state playing=' + player.isPlaying);
        });
      }),
    );
    unsubscribers.push(
      ctx.events.on('playback.positionCommitted', function (payload) {
        var committed = payload && typeof payload.positionMs === 'number' ? payload.positionMs : null;
        void Promise.all([ctx.track.get(), ctx.player.get()]).then(function (pair) {
          var track = pair[0];
          var player = pair[1];
          return ctx.storage.set(
            'bookmark',
            JSON.stringify({
              queueEntryId: track.queueEntryId,
              positionMs: committed == null ? player.positionMs : committed,
              playing: player.isPlaying,
            }),
          );
        });
      }),
    );
    unsubscribers.push(
      ctx.events.on('lyrics.lineChanged', function () {
        void ctx.lyrics.get().then(function (document) {
          return ctx.storage.set(
            'lastLineCount',
            String(document.lines ? document.lines.length : 0),
          );
        });
      }),
    );
    unsubscribers.push(
      ctx.events.on('theme.changed', function () {
        void ctx.theme.get().then(function (theme) {
          return ctx.log.info('theme.changed ' + theme.source);
        });
      }),
    );

    void restore().catch(function (error) {
      void ctx.log.error(String(error && error.message ? error.message : error));
    });

    return function () {
      unsubscribers.forEach(function (unsubscribe) {
        unsubscribe();
      });
    };
  },
});
