definePlugin({
  activate(ctx) {
    const unsubscribe = ctx.events.on('track.changed', (track) => {
      void ctx.log.info(`track changed: ${track && track.title ? track.title : 'none'}`);
    });
    return function () {
      unsubscribe();
    };
  },
});
