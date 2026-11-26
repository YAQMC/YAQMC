import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import vm from 'node:vm';

const { Event, EventTarget, AbortSignal } = globalThis;

const html = readFileSync(
  process.env.YAQMC_PLAYER_HTML ??
    new URL('../../crates/yaqmc-core/assets/protected_hls_player.html', import.meta.url),
  'utf8',
);
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

async function player() {
  const updates = [];
  const intervals = [];
  let commands;
  const audio = new EventTarget();
  Object.assign(audio, {
    currentTime: 0,
    duration: 195,
    paused: true,
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    },
  });
  const diagnostic = { textContent: '' };
  const hlsEvents = [
    'MEDIA_ATTACHED',
    'MANIFEST_LOADING',
    'MANIFEST_LOADED',
    'MANIFEST_PARSED',
    'BUFFER_CODECS',
    'FRAG_LOADING',
    'FRAG_LOADED',
    'KEY_LOADING',
    'KEY_LOADED',
    'ERROR',
  ];
  class Hls {
    static instances = [];
    static Events = Object.fromEntries(hlsEvents.map((name) => [name, name]));
    static ErrorTypes = { KEY_SYSTEM_ERROR: 'keySystemError' };
    static isSupported() {
      return true;
    }
    listeners = new Map();
    constructor() {
      Hls.instances.push(this);
    }
    on(name, fn) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    }
    emit(name, value) {
      for (const fn of this.listeners.get(name) ?? []) fn(name, value);
    }
    attachMedia() {}
    loadSource() {}
    stopLoad() {}
    destroy() {}
  }
  vm.runInNewContext(script, {
    location: { origin: 'http://127.0.0.1:12345', pathname: '/fixture/player' },
    document: { getElementById: (id) => (id === 'player' ? audio : diagnostic) },
    window: { addEventListener() {} },
    Hls,
    MediaSource: { isTypeSupported: () => true },
    AbortSignal,
    setInterval: (fn) => intervals.push(fn),
    setTimeout,
    fetch: async (url, init) => {
      if (url.endsWith('/state')) {
        updates.push(JSON.parse(init.body));
        return { ok: true };
      }
      if (url.endsWith('/config')) {
        return { ok: true, json: async () => ({ serverCertificate: true }) };
      }
      if (url.includes('/command?')) {
        return new Promise((resolve) => {
          commands = resolve;
        });
      }
      return new Promise(() => {});
    },
  });
  await nextTurn();
  const hls = Hls.instances[0];
  hls.emit('MANIFEST_PARSED');
  commands({ ok: true, json: async () => ({ seq: 1, command: { type: 'play' } }) });
  await nextTurn();
  let sequence = 1;
  return {
    audio,
    hls,
    updates,
    tick: () => intervals.forEach((fn) => fn()),
    command: async (command) => {
      commands({ ok: true, json: async () => ({ seq: ++sequence, command }) });
      await nextTurn();
    },
  };
}

test('an accepted play request stays buffering until audio really starts', async () => {
  const p = await player();
  p.tick();
  assert.equal(p.updates.at(-1).kind, 'buffering');
  p.audio.currentTime = 2;
  p.audio.dispatchEvent(new Event('playing'));
  p.tick();
  assert.equal(p.updates.at(-1).kind, 'playing');
  assert.equal(p.updates.at(-1).positionMs, 2000);
  p.audio.dispatchEvent(new Event('waiting'));
  p.tick();
  assert.equal(p.updates.at(-1).kind, 'buffering');
});

test('a fatal license rejection cannot be replaced by periodic or late media events', async () => {
  const p = await player();
  p.hls.emit('ERROR', {
    fatal: true,
    type: 'keySystemError',
    details: 'keySystemLicenseRequestFailed',
    response: { code: 403 },
  });
  const rejected = p.updates.at(-1);
  assert.equal(rejected.kind, 'error');
  assert.equal(rejected.httpStatus, 403);
  p.audio.dispatchEvent(new Event('playing'));
  p.audio.dispatchEvent(new Event('pause'));
  p.audio.dispatchEvent(new Event('seeked'));
  p.tick();
  assert.equal(p.updates.at(-1), rejected);
  assert.equal(p.audio.paused, true);
});

test('pause and resume reflect audio events without a duplicate play causing buffering', async () => {
  const p = await player();
  p.audio.dispatchEvent(new Event('playing'));
  await p.command({ type: 'play' });
  p.tick();
  assert.equal(p.updates.at(-1).kind, 'playing');
  await p.command({ type: 'pause' });
  p.tick();
  assert.equal(p.updates.at(-1).kind, 'paused');
  await p.command({ type: 'play' });
  p.tick();
  assert.equal(p.updates.at(-1).kind, 'buffering');
  p.audio.dispatchEvent(new Event('playing'));
  p.tick();
  assert.equal(p.updates.at(-1).kind, 'playing');
});
