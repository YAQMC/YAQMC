import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  localApiOrigin,
  resolveSmokeConfig,
  smokeLocalApi,
  takeSseEvents,
} from '../migration/plat06-local-api-sse.mjs';
import { repositoryRoot } from './repo.mjs';

const SCRIPT = path.join(repositoryRoot, 'scripts', 'migration', 'plat06-local-api-sse.mjs');

test('defaults to FACT loopback 127.0.0.1:19532', () => {
  const config = resolveSmokeConfig({ env: { YAQMC_API_TOKEN: 'secret' }, argv: [] });
  assert.equal(config.host, DEFAULT_HOST);
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.token, 'secret');
  assert.equal(localApiOrigin(), 'http://127.0.0.1:19532');
});

test('CLI exits without a token and does not invent a live core', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, YAQMC_API_TOKEN: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /YAQMC_API_TOKEN/);
  assert.match(result.stderr, /Settings/);
});

test('parses axum-style SSE frames including keep-alives', () => {
  const { events, rest } = takeSseEvents(
    [
      ': keep-alive',
      '',
      'event: player.snapshot',
      'data: {"version":1,"type":"player.snapshot","timestampMs":1,"data":{}}',
      '',
      'event: player.volume',
      'data: {"version":1,"type":"player.volume","timestampMs":2,"data":{"volume":0.5}}',
      '',
      'partial',
    ].join('\n'),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'player.snapshot');
  assert.equal(events[0].data.type, 'player.snapshot');
  assert.equal(events[1].event, 'player.volume');
  assert.equal(events[1].data.data.volume, 0.5);
  assert.equal(rest, 'partial');
});

test('smokes health without a token, player with bearer, and a few SSE events', async () => {
  const token = 'plat06-test-token';
  const mock = await listenMock(token);
  try {
    const result = await smokeLocalApi({
      host: '127.0.0.1',
      port: mock.port,
      token,
      eventCount: 3,
      timeoutMs: 2_000,
    });
    assert.deepEqual(result.health, { status: 'ok', version: 1 });
    assert.equal(result.player.playbackState, 'paused');
    assert.deepEqual(
      result.events.map((event) => event.event),
      ['player.snapshot', 'player.volume', 'queue.changed'],
    );
    assert.equal(mock.requests[0].url, '/health');
    assert.equal(mock.requests[0].authorization, null);
    assert.equal(mock.requests[1].url, '/v1/player');
    assert.equal(mock.requests[1].authorization, `Bearer ${token}`);
    assert.equal(mock.requests[2].url, '/v1/events');
    assert.equal(mock.requests[2].authorization, `Bearer ${token}`);
  } finally {
    await mock.close();
  }
});

test('rejects a missing bearer against the mock player route', async () => {
  const mock = await listenMock('expected');
  try {
    await assert.rejects(
      () =>
        smokeLocalApi({
          host: '127.0.0.1',
          port: mock.port,
          token: 'wrong',
          timeoutMs: 1_000,
        }),
      /GET \/v1\/player expected 200, got 401/,
    );
  } finally {
    await mock.close();
  }
});

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function listenMock(token) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization ?? null,
    });

    if (req.url === '/health') {
      if (req.headers.authorization) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'health must not send a bearer token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: 1 }));
      return;
    }

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'unauthorized', message: 'A valid bearer token is required.' },
        }),
      );
      return;
    }

    if (req.url === '/v1/player') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ playbackState: 'paused', volume: 0.5 }));
      return;
    }

    if (req.url === '/v1/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(
        sseFrame('player.snapshot', {
          version: 1,
          type: 'player.snapshot',
          timestampMs: 1,
          data: { playbackState: 'paused' },
        }),
      );
      res.write(
        sseFrame('player.volume', {
          version: 1,
          type: 'player.volume',
          timestampMs: 2,
          data: { volume: 0.5 },
        }),
      );
      res.write(
        sseFrame('queue.changed', {
          version: 1,
          type: 'queue.changed',
          timestampMs: 3,
          data: {},
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('mock server did not bind a TCP port'));
        return;
      }
      resolve({
        port: address.port,
        requests,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            for (const socket of sockets) socket.destroy();
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}
