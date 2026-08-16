definePlugin({
  activate(ctx) {
    const attempts = [];
    try {
      attempts.push('fetch=' + typeof fetch);
      fetch('https://example.com');
    } catch (error) {
      attempts.push('fetch-threw');
    }
    try {
      attempts.push('document=' + typeof document);
    } catch (error) {
      attempts.push('document-threw');
    }
    try {
      attempts.push('tauri=' + typeof __TAURI__);
    } catch (error) {
      attempts.push('tauri-threw');
    }
    try {
      new Worker('data:text/javascript,');
      attempts.push('worker-created');
    } catch (error) {
      attempts.push('worker-blocked');
    }
    try {
      eval('1+1');
      attempts.push('eval-ran');
    } catch (error) {
      attempts.push('eval-blocked');
    }
    void ctx.log.info(attempts.join(','));
    void ctx.storage.set('probe', attempts.join(','));
  },
});
