import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfigFromFile } from 'vite';

test('Vite ignores locked native outputs without excluding application sources', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    path.resolve('vite.config.ts'),
  );
  const patterns = loaded.config.server.watch.ignored;
  const ignored = (file) => patterns.some((pattern) => pattern.test(file));
  for (const separator of ['/', '\\']) {
    for (const file of [
      'target/debug/yaqmc-core.exe',
      'apps/android/android/.gradle/cache.bin',
      'apps/android/android/build/report.bin',
      'apps/android/android/app/build/generated/jniLibs/x86_64/libyaqmc_core.so',
    ]) {
      assert.equal(ignored(`D:/YAQMC/${file}`.replaceAll('/', separator)), true, file);
    }
    for (const file of [
      'src/components/PluginManager.tsx',
      'packages/yaqmc-client/src/bridge.ts',
      'apps/android/android/app/src/main/AndroidManifest.xml',
    ]) {
      assert.equal(ignored(`D:/YAQMC/${file}`.replaceAll('/', separator)), false, file);
    }
  }
});
