/**
 * PLAT-06: maintainer curl/SSE smoke against the FACT loopback Local API.
 *
 * Hits 127.0.0.1:19532 (override with YAQMC_API_HOST / YAQMC_API_PORT):
 *   GET /health          — public, no Authorization
 *   GET /v1/player       — Authorization: Bearer
 *   GET /v1/events       — SSE; read a few events, then exit
 *
 * Token: Settings > Local HTTP API reveal, or YAQMC_API_TOKEN.
 * Does not start yaqmc-core and does not enable the API.
 *
 * Run: node scripts/migration/plat06-local-api-sse.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 19532;
export const DEFAULT_EVENT_COUNT = 3;
export const DEFAULT_TIMEOUT_MS = 8_000;

export function resolveSmokeConfig({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const flags = parseFlags(argv);
  return {
    host: flags.host || env.YAQMC_API_HOST || DEFAULT_HOST,
    port: Number(flags.port || env.YAQMC_API_PORT || DEFAULT_PORT),
    token: flags.token || env.YAQMC_API_TOKEN || '',
    eventCount: Number(flags.events || DEFAULT_EVENT_COUNT),
    timeoutMs: Number(flags.timeout || DEFAULT_TIMEOUT_MS),
  };
}

export function localApiOrigin(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return `http://${host}:${port}`;
}

export function takeSseEvents(buffer) {
  const parts = buffer.split(/\r?\n\r?\n/u);
  const rest = parts.pop() ?? '';
  const events = [];
  for (const block of parts) {
    const parsed = parseSseBlock(block);
    if (parsed) events.push(parsed);
  }
  return { events, rest };
}

export async function smokeLocalApi({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  token = '',
  eventCount = DEFAULT_EVENT_COUNT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  if (!token) {
    throw new Error('missing bearer token (Settings reveal or YAQMC_API_TOKEN)');
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid Local API port: ${port}`);
  }

  const origin = localApiOrigin(host, port);
  const health = await getJson(`${origin}/health`, { fetchImpl, headers: {} });
  if (health.statusCode !== 200) {
    throw new Error(`GET /health expected 200, got ${health.statusCode}`);
  }
  if (health.body?.status !== 'ok' || health.body?.version !== 1) {
    throw new Error('GET /health body is not { status: "ok", version: 1 }');
  }

  const authHeaders = { Authorization: `Bearer ${token}` };
  const player = await getJson(`${origin}/v1/player`, { fetchImpl, headers: authHeaders });
  if (player.statusCode !== 200) {
    throw new Error(`GET /v1/player expected 200, got ${player.statusCode}`);
  }
  if (player.body === null || typeof player.body !== 'object' || Array.isArray(player.body)) {
    throw new Error('GET /v1/player did not return a JSON object');
  }

  const events = await readSseEvents(`${origin}/v1/events`, {
    fetchImpl,
    headers: authHeaders,
    eventCount,
    timeoutMs,
  });
  if (!events.some((event) => event.event === 'player.snapshot')) {
    throw new Error('GET /v1/events did not include player.snapshot');
  }

  return {
    origin,
    health: health.body,
    player: player.body,
    events,
  };
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const assigned = arg.match(/^--([a-zA-Z]+)=(.*)$/u);
    if (assigned) {
      flags[assigned[1]] = assigned[2];
      continue;
    }
    if (arg.startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      flags[arg.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return flags;
}

function parseSseBlock(block) {
  let eventType = '';
  const dataLines = [];
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (!eventType && dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // keep the raw payload when a frame is not JSON
  }
  return { event: eventType || 'message', data, raw };
}

async function getJson(url, { fetchImpl, headers }) {
  const response = await fetchImpl(url, { method: 'GET', headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { statusCode: response.status, body };
}

async function readSseEvents(url, { fetchImpl, headers, eventCount, timeoutMs }) {
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  let reader;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { ...headers, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`GET /v1/events expected 200, got ${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') ?? '');
    if (!contentType.includes('text/event-stream')) {
      throw new Error(`GET /v1/events expected text/event-stream, got ${contentType || 'none'}`);
    }
    if (!response.body) {
      throw new Error('GET /v1/events has no body');
    }

    reader = response.body.getReader();
    const decoder = new globalThis.TextDecoder();
    let buffer = '';
    while (events.length < eventCount) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const taken = takeSseEvents(buffer);
      buffer = taken.rest;
      for (const event of taken.events) {
        events.push(event);
        if (events.length >= eventCount) break;
      }
    }
  } catch (error) {
    if (!isAbort(error)) throw error;
  } finally {
    clearTimeout(timer);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // the client is done; ignore cancel races after abort
      }
    }
  }

  if (events.length === 0) {
    throw new Error('GET /v1/events produced no SSE events');
  }
  return events.slice(0, eventCount);
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const config = resolveSmokeConfig();
  if (!config.token) {
    process.stderr.write(
      [
        'Missing token. Reveal it in Settings > Local HTTP API, or set YAQMC_API_TOKEN.',
        `Default origin: ${localApiOrigin(DEFAULT_HOST, DEFAULT_PORT)}`,
        'Usage: node scripts/migration/plat06-local-api-sse.mjs',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await smokeLocalApi(config);
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            origin: result.origin,
            health: result.health,
            events: result.events.map((event) => event.event),
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exitCode = 1;
    }
  }
}
