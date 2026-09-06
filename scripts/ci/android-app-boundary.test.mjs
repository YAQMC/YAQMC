import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build, createServer, loadConfigFromFile } from 'vite';

test('desktop renderer builds even when the Android app package cannot be resolved', async () => {
  const previous = process.env.YAQMC_TARGET_PLATFORM;
  process.env.YAQMC_TARGET_PLATFORM = 'desktop';
  try {
    await build({
      logLevel: 'silent',
      build: { write: false },
      plugins: [
        {
          name: 'reject-android-app-in-desktop',
          enforce: 'pre',
          resolveId(id) {
            if (id === '@capacitor/app') throw new Error('Android dependency leaked into desktop');
          },
        },
      ],
    });
  } finally {
    if (previous === undefined) delete process.env.YAQMC_TARGET_PLATFORM;
    else process.env.YAQMC_TARGET_PLATFORM = previous;
  }
});

test('Android builds keep the real Capacitor lifecycle adapter', async () => {
  const previous = process.env.YAQMC_TARGET_PLATFORM;
  process.env.YAQMC_TARGET_PLATFORM = 'android';
  try {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      path.resolve('vite.config.ts'),
    );
    assert.equal(
      loaded.config.resolve.alias['./application/android-app'],
      path.resolve('src/application/android-app.native.ts'),
    );
  } finally {
    if (previous === undefined) delete process.env.YAQMC_TARGET_PLATFORM;
    else process.env.YAQMC_TARGET_PLATFORM = previous;
  }
});

test('desktop development import analysis does not resolve the Android app package', async () => {
  const previous = process.env.YAQMC_TARGET_PLATFORM;
  process.env.YAQMC_TARGET_PLATFORM = 'desktop';
  let server;
  try {
    server = await createServer({
      logLevel: 'silent',
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        {
          name: 'reject-android-dev-import',
          enforce: 'pre',
          resolveId(id) {
            if (id === '@capacitor/app') throw new Error('Mobile dependency in desktop dev');
          },
        },
      ],
    });
    const result = await server.transformRequest('/src/App.tsx');
    assert.ok(result?.code.includes('/src/application/android-app.ts'));
    assert.ok(!result.code.includes('@capacitor/app'));
  } finally {
    await server?.close();
    if (previous === undefined) delete process.env.YAQMC_TARGET_PLATFORM;
    else process.env.YAQMC_TARGET_PLATFORM = previous;
  }
});
