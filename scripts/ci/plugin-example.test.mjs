import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setImmediate } from 'node:timers';
import { runInNewContext } from 'node:vm';
import { crc32 } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/sync-plugin-example.mjs');

test('standalone example packs, activates, synchronizes docs and preserves user code', async () => {
  const prefix = path.join(os.tmpdir(), 'yaqmc-plugin-example-');
  const temporary = mkdtempSync(prefix);
  const output = path.join(temporary, 'copy');
  const run = (...args) =>
    spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const sync = () => run(script, '--export', '--out', output);
  try {
    let result = sync();
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(output, 'API.md'), 'utf8'), /ui\.lyrics\.register/);
    assert.match(
      readFileSync(path.join(output, 'api/sdk.ts'), 'utf8'),
      /interface PluginLyricsAction/,
    );
    assert.equal(run(script, '--check').status, 0);

    const packed = run(path.join(output, 'pack.mjs'));
    assert.equal(packed.status, 0, packed.stderr);
    const archive = readFileSync(
      path.join(output, 'dist/dev.example.lyrics-window-1.0.0.yaqmc-plugin'),
    );
    const entries = new Map();
    let offset = 0;
    while (archive.readUInt32LE(offset) === 0x04034b50) {
      const size = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString();
      const start = offset + 30 + nameLength + extraLength;
      const bytes = archive.subarray(start, start + size);
      assert.equal(crc32(bytes), archive.readUInt32LE(offset + 14));
      entries.set(name, bytes.toString());
      offset = start + size;
    }
    assert.deepEqual([...entries.keys()], ['manifest.json', 'main.js', 'LICENSE']);
    assert.equal(JSON.parse(entries.get('manifest.json')).apiVersion, 4);
    assert.doesNotMatch(entries.get('main.js'), /import\(/);

    let definition;
    runInNewContext(entries.get('main.js'), {
      definePlugin: (value) => {
        definition = value;
      },
    });
    const actions = [];
    const notices = [];
    let handler;
    let unsubscribed = false;
    const dispose = await definition.activate({
      ui: {
        lyrics: {
          register: async (action) => {
            actions.push(action);
          },
        },
        notify: async (notice) => {
          notices.push(notice);
        },
      },
      events: {
        on: (name, callback) => {
          assert.equal(name, 'ui.action');
          handler = callback;
          return () => {
            unsubscribed = true;
          };
        },
      },
      track: { get: async () => ({ title: 'Test song', artists: ['Test artist'] }) },
      log: {
        error: async (message) => {
          assert.fail(message);
        },
      },
    });
    assert.deepEqual(
      actions.map((action) => action.id),
      ['minimize', 'maximize', 'close', 'track-info'],
    );
    handler({ slot: 'sidebar', id: 'track-info' });
    assert.equal(notices.length, 0);
    handler({ slot: 'lyrics', id: 'track-info' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notices[0].message, 'Test song · Test artist');
    dispose();
    assert.equal(unsubscribed, true);

    const customized = `${readFileSync(path.join(output, 'main.js'), 'utf8')}\n// User modification\n`;
    writeFileSync(path.join(output, 'main.js'), customized);
    result = sync();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(output, 'main.js'), 'utf8'), customized);
    assert.match(result.stdout, /Preserved edited plugin file/);
    writeFileSync(path.join(output, 'API.md'), 'User-edited documentation');
    result = sync();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflicts with an edited file/);
    assert.equal(readFileSync(path.join(output, 'API.md'), 'utf8'), 'User-edited documentation');
  } finally {
    assert.ok(
      path.resolve(temporary).startsWith(path.resolve(prefix)),
      'only delete the owned test directory',
    );
    rmSync(temporary, { recursive: true, force: true });
  }
});
