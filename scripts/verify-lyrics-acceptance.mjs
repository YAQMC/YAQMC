#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WINDOWS_CASE_CONTRACT = Object.freeze({
  W01: Object.freeze({
    width: 1280,
    height: 800,
    presentation: 'normal',
    theme: 'light',
    locale: 'en-US',
    backgroundMode: 'default',
    entryPath: 'playerbar-lyrics',
    exitPath: 'lyrics-close',
    reducedMotion: false,
  }),
  W02: Object.freeze({
    width: 1280,
    height: 800,
    presentation: 'focus',
    theme: 'dark',
    locale: 'zh-CN',
    backgroundMode: 'artwork',
    entryPath: 'focus-toggle',
    exitPath: 'focus-toggle',
    reducedMotion: false,
  }),
  W03: Object.freeze({
    width: 1280,
    height: 800,
    presentation: 'native-fullscreen',
    theme: 'dark',
    locale: 'en-US',
    backgroundMode: 'image',
    entryPath: 'header-fullscreen',
    exitPath: 'header-fullscreen',
    reducedMotion: false,
  }),
  W04: Object.freeze({
    width: 1000,
    height: 700,
    presentation: 'normal',
    theme: 'light',
    locale: 'zh-CN',
    backgroundMode: 'color',
    entryPath: 'playerbar-lyrics',
    exitPath: 'escape',
    reducedMotion: true,
  }),
  W05: Object.freeze({
    width: 1000,
    height: 700,
    presentation: 'focus',
    theme: 'dark',
    locale: 'en-US',
    backgroundMode: 'image',
    entryPath: 'focus-toggle',
    exitPath: 'escape',
    reducedMotion: false,
  }),
  W06: Object.freeze({
    width: 1000,
    height: 700,
    presentation: 'native-fullscreen',
    theme: 'dark',
    locale: 'zh-CN',
    backgroundMode: 'artwork',
    entryPath: 'playerbar-fullscreen',
    exitPath: 'escape',
    reducedMotion: true,
  }),
  W07: Object.freeze({
    width: 1000,
    height: 1000,
    presentation: 'normal',
    theme: 'dark',
    locale: 'en-US',
    backgroundMode: 'artwork',
    entryPath: 'playerbar-lyrics',
    exitPath: 'lyrics-close',
    reducedMotion: false,
  }),
  W08: Object.freeze({
    width: 1000,
    height: 1000,
    presentation: 'focus',
    theme: 'light',
    locale: 'zh-CN',
    backgroundMode: 'default',
    entryPath: 'focus-toggle',
    exitPath: 'focus-toggle',
    reducedMotion: true,
  }),
  W09: Object.freeze({
    width: 1000,
    height: 1000,
    presentation: 'native-fullscreen',
    theme: 'light',
    locale: 'en-US',
    backgroundMode: 'color',
    entryPath: 'f11',
    exitPath: 'f11',
    reducedMotion: false,
  }),
});

const SMOKE_CONTRACT = Object.freeze({
  width: 1000,
  height: 680,
  presentation: 'normal',
  theme: 'dark',
  locale: 'en-US',
  backgroundMode: 'default',
  entryPath: 'playerbar-lyrics',
  exitPath: 'escape',
  reducedMotion: false,
});

const INTERACTION_CASE_ID = 'S01-interactions';
const INTERACTION_ACTIONS = Object.freeze([
  'manual-scroll-unfollow',
  'follow-restored',
  'click-seek',
  'pause',
  'resume',
  'focus-playerbar-sizing',
  'transport-hidden',
  'transport-revealed',
  'transport-focus-pinned',
  'fullscreen-track-change',
  'fullscreen-track-restored',
  'escape-fullscreen',
  'escape-focus',
  'escape-close',
  'secondary-lyrics',
]);

const INTERACTION_STATE = Object.freeze({
  'manual-scroll-unfollow': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: false,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'follow-restored': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: false,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'click-seek': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: false,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  pause: Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: false,
    playerState: 'paused',
    songId: 'quiet-light',
  }),
  resume: Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: false,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'focus-playerbar-sizing': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: true,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'transport-hidden': Object.freeze({
    nativeFullscreen: true,
    lyricsOpen: true,
    focus: true,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'transport-revealed': Object.freeze({
    nativeFullscreen: true,
    lyricsOpen: true,
    focus: true,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'transport-focus-pinned': Object.freeze({
    nativeFullscreen: true,
    lyricsOpen: true,
    focus: true,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'fullscreen-track-change': Object.freeze({
    nativeFullscreen: true,
    lyricsOpen: true,
    focus: true,
    playerState: 'playing',
    songId: 'night-geometry',
  }),
  'fullscreen-track-restored': Object.freeze({
    nativeFullscreen: true,
    lyricsOpen: true,
    focus: true,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'escape-fullscreen': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: true,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'escape-focus': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: false,
    playerState: 'playing',
    songId: 'quiet-light',
  }),
  'escape-close': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: false,
    focus: false,
    playerState: 'playing',
    songId: null,
  }),
  'secondary-lyrics': Object.freeze({
    nativeFullscreen: false,
    lyricsOpen: true,
    focus: false,
    playerState: 'playing',
    songId: 'paper-sun',
  }),
});

const MANIFEST_KEYS = Object.freeze([
  'appVersion',
  'capturedAtUtc',
  'cases',
  'fixtureSongId',
  'gitCommit',
  'gitTree',
  'interactionSequence',
  'monitorId',
  'osVersion',
  'platform',
  'provider',
  'releaseArtifact',
  'schemaVersion',
  'visualBinaryPath',
  'visualBinarySha256',
  'visualBuildKind',
  'webview2Version',
]);

const CASE_KEYS = Object.freeze([
  'backgroundMode',
  'captureLogicalBounds',
  'capturePhysicalBounds',
  'devicePixelRatio',
  'entryPath',
  'exitPath',
  'id',
  'locale',
  'presentation',
  'reducedMotion',
  'restoredLogicalBounds',
  'restoredPhysicalBounds',
  'screenshot',
  'screenshotSha256',
  'sourceLogicalBounds',
  'sourcePhysicalBounds',
  'stateSeqEnd',
  'stateSeqStart',
  'theme',
]);

const STATE_KEYS = Object.freeze([
  'action',
  'assertions',
  'captureMethod',
  'caseId',
  'devicePixelRatio',
  'focus',
  'logicalBounds',
  'lyricsOpen',
  'nativeFullscreen',
  'physicalBounds',
  'playerState',
  'reducedMotion',
  'seq',
  'songId',
  'source',
  'timestampUtc',
]);

const REQUIRED_ROOT_FILES = Object.freeze([
  'checklist.md',
  'manifest.json',
  'commands.log',
  'state.jsonl',
  'sha256.txt',
]);
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40,64}$/;
const EXACT_GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/;
const DECIMAL_PATTERN = /^\d+$/;
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LINUX_PHASES = Object.freeze([
  'startup-idle',
  'playback',
  'seek-pause-resume',
  'main-scroll-resize',
  'lyrics-normal',
  'lyrics-focus',
  'lyrics-fullscreen',
  'desktop-lyrics',
  'island-lyrics',
  'both-surfaces',
  'shutdown',
]);
const LINUX_MODES = Object.freeze(['auto', 'native-wayland', 'x11', 'software']);
const BUILD_IDENTITY_KEYS = Object.freeze([
  'appImage',
  'appVersion',
  'gitCommit',
  'gitTree',
  'schemaVersion',
  'workflowRunAttempt',
  'workflowRunId',
]);
const BUILD_APPIMAGE_KEYS = Object.freeze(['fileName', 'sha256']);
const LINUX_BUNDLE_STATIC_FILES = Object.freeze([
  'ACCEPTANCE.md',
  'BUILD-IDENTITY.json',
  'SHA256SUMS',
  'TESTING.md',
  'collect-linux-diagnostics.sh',
  'verify-lyrics-acceptance.mjs',
]);
const LINUX_MANIFEST_KEYS = Object.freeze([
  'appImage',
  'appVersion',
  'endedAtUtc',
  'gitCommit',
  'gitTree',
  'mode',
  'phases',
  'platform',
  'reportedBackend',
  'requestedMode',
  'schemaVersion',
  'startedAtUtc',
  'status',
  'workflowRunAttempt',
  'workflowRunId',
]);
const LINUX_STATE_KEYS = Object.freeze([
  'graphicsMode',
  'mode',
  'phase',
  'reportedBackend',
  'schemaVersion',
  'seq',
  'timestampUtc',
  'windowState',
]);
const LINUX_REPORT_FILES = Object.freeze([
  'checklist.md',
  'commands.log',
  'environment.txt',
  'launch-environment.txt',
  'manifest.json',
  'process-samples.tsv',
  'process-tree-samples.tsv',
  'sha256.txt',
  'state.jsonl',
  'yaqmc.log',
]);
const LINUX_SAMPLE_HEADER = Object.freeze([
  'phase',
  'timestamp_utc',
  'process_count',
  'total_cpu_percent',
  'total_rss_kib',
  'total_pss_kib',
  'total_threads',
  'window_state',
  'reported_backend',
  'xdg_session_type',
  'gdk_backend',
  'graphics_mode',
  'dmabuf_disabled',
  'software_gl',
]);
const LINUX_TREE_HEADER = Object.freeze([
  'phase',
  'timestamp_utc',
  'pid',
  'ppid',
  'cpu_percent',
  'rss_kib',
  'pss_kib',
  'threads',
  'elapsed',
  'command',
]);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value, expected) {
  return (
    isObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function isUtc(value) {
  return typeof value === 'string' && UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashFile(path) {
  return hashBytes(readFileSync(path));
}

function safeRootPath(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\')
  ) {
    return null;
  }
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, ...relativePath.split('/'));
  const relation = relative(normalizedRoot, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null;
  return candidate;
}

function validateRegularFile(path, label, errors) {
  if (!existsSync(path)) {
    errors.push(`${label}: missing file`);
    return false;
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(`${label}: must be a regular non-symlink file`);
      return false;
    }
  } catch (error) {
    errors.push(`${label}: cannot inspect file (${String(error)})`);
    return false;
  }
  return true;
}

function parseJson(text, label, errors) {
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${label}: invalid JSON (${String(error)})`);
    return null;
  }
}

function validateBounds(value, unit, label, errors) {
  const keys = ['height', 'unit', 'width', 'x', 'y'];
  if (!sameKeys(value, keys)) {
    errors.push(`${label}: bounds must contain exactly x, y, width, height, and unit`);
    return;
  }
  if (value.unit !== unit) errors.push(`${label}: unit must be ${unit}`);
  for (const field of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(value[field])) errors.push(`${label}.${field}: must be finite`);
  }
  if (!(value.width > 0) || !(value.height > 0)) {
    errors.push(`${label}: width and height must be positive`);
  }
}

function compareFields(actual, expected, fields, label, errors) {
  for (const field of fields) {
    if (actual?.[field] !== expected[field]) {
      errors.push(`${label}.${field}: expected ${JSON.stringify(expected[field])}`);
    }
  }
}

function compareBounds(actual, expected, label, errors) {
  for (const field of ['x', 'y', 'width', 'height', 'unit']) {
    if (actual?.[field] !== expected?.[field]) {
      errors.push(`${label}.${field}: expected exact restoration value ${expected?.[field]}`);
    }
  }
}

function validateConversion(logical, physical, dpr, label, errors) {
  if (!Number.isFinite(dpr) || dpr <= 0) {
    errors.push(`${label}: devicePixelRatio must be positive and finite`);
    return;
  }
  const edges = [
    ['left', physical.x, Math.round(logical.x * dpr)],
    ['top', physical.y, Math.round(logical.y * dpr)],
    ['right', physical.x + physical.width, Math.round((logical.x + logical.width) * dpr)],
    ['bottom', physical.y + physical.height, Math.round((logical.y + logical.height) * dpr)],
  ];
  for (const [edge, actual, expected] of edges) {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1) {
      errors.push(`${label}.${edge}: exceeds one physical-pixel rounding tolerance`);
    }
  }
}

function readPngSize(path, label, errors) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    errors.push(`${label}: cannot read PNG (${String(error)})`);
    return null;
  }
  if (
    bytes.length < 26 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    errors.push(`${label}: invalid PNG header`);
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    errors.push(`${label}: PNG dimensions must be positive`);
    return null;
  }
  return { width, height };
}

function parseChecksumFile(text, label, errors) {
  const entries = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line === '') continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    if (!match) {
      errors.push(`${label}:${index + 1}: invalid entry`);
      continue;
    }
    const [, hash, name] = match;
    if (entries.has(name)) errors.push(`${label}: duplicate entry ${name}`);
    entries.set(name, hash);
  }
  return entries;
}

function parseShaFile(text, errors) {
  return parseChecksumFile(text, 'sha256.txt', errors);
}

function checklistValue(checklist, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*-\\s*${escaped}:\\s*(.+?)\\s*$`, 'im').exec(checklist)?.[1] ?? null;
}

function scanPrivateUrls(label, value, errors) {
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    try {
      const url = new URL(match[0]);
      const local =
        url.hostname === 'localhost' ||
        url.hostname.endsWith('.localhost') ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]';
      if (!local) errors.push(`${label}: contains a non-loopback URL`);
    } catch {
      errors.push(`${label}: contains an unparseable URL`);
    }
  }
}

function expectedHashNames() {
  return [
    'checklist.md',
    'manifest.json',
    'commands.log',
    'state.jsonl',
    ...Object.keys(WINDOWS_CASE_CONTRACT).map((id) => `screenshots/${id}.png`),
    'screenshots/S01.png',
    '@visual-binary',
  ];
}

function validateManifestIdentity(manifest, checklist, commands, errors) {
  if (!sameKeys(manifest, MANIFEST_KEYS)) {
    errors.push('manifest.json: fields do not match schemaVersion 1 local-visual schema');
  }
  if (manifest?.schemaVersion !== 1) errors.push('manifest.schemaVersion: expected 1');
  if (!isUtc(manifest?.capturedAtUtc)) errors.push('manifest.capturedAtUtc: expected UTC ISO 8601');
  if (manifest?.platform !== 'windows') errors.push('manifest.platform: expected windows');
  if (manifest?.provider !== 'fake') errors.push('manifest.provider: expected fake');
  if (manifest?.fixtureSongId !== 'quiet-light') {
    errors.push('manifest.fixtureSongId: expected quiet-light');
  }
  if (manifest?.releaseArtifact !== null) {
    errors.push('manifest.releaseArtifact: must be null for the local visual gate');
  }
  if (manifest?.visualBuildKind !== 'electron-local') {
    errors.push('manifest.visualBuildKind: expected electron-local');
  }
  for (const field of ['osVersion', 'appVersion', 'webview2Version', 'monitorId']) {
    if (typeof manifest?.[field] !== 'string' || manifest[field].trim() === '') {
      errors.push(`manifest.${field}: expected nonempty string`);
    }
  }
  for (const field of ['gitCommit', 'gitTree']) {
    if (typeof manifest?.[field] !== 'string' || !GIT_OBJECT_PATTERN.test(manifest[field])) {
      errors.push(`manifest.${field}: expected lowercase Git object ID`);
    }
    if (checklistValue(checklist, field) !== manifest?.[field]) {
      errors.push(`checklist.${field}: does not match manifest`);
    }
  }
  if (!commands.includes(`git rev-parse HEAD => ${manifest?.gitCommit ?? ''}`)) {
    errors.push('commands.log: missing matching git commit evidence');
  }
  if (!commands.includes(`git rev-parse HEAD^{tree} => ${manifest?.gitTree ?? ''}`)) {
    errors.push('commands.log: missing matching git tree evidence');
  }
  if (checklistValue(checklist, 'releasePass') !== 'false') {
    errors.push('checklist.releasePass: must be exactly false');
  }
  if (checklistValue(checklist, 'checkpoint') !== 'local-visual-only') {
    errors.push('checklist.checkpoint: must be local-visual-only');
  }
}

function validateStateRows(states, casesById, errors) {
  let previousSeq = -Infinity;
  for (const [index, state] of states.entries()) {
    const label = `state.jsonl:${index + 1}`;
    if (!sameKeys(state, STATE_KEYS)) errors.push(`${label}: fields do not match state schema`);
    if (!Number.isInteger(state?.seq) || state.seq <= previousSeq) {
      errors.push(`${label}.seq: must be a strictly increasing integer`);
    }
    previousSeq = state?.seq;
    if (!isUtc(state?.timestampUtc)) errors.push(`${label}.timestampUtc: expected UTC ISO 8601`);
    if (
      !casesById.has(state?.caseId) &&
      state?.caseId !== 'external-native-api' &&
      state?.caseId !== INTERACTION_CASE_ID
    ) {
      errors.push(`${label}.caseId: unknown case`);
    }
    validateBounds(state?.logicalBounds, 'logical-px', `${label}.logicalBounds`, errors);
    validateBounds(state?.physicalBounds, 'physical-px', `${label}.physicalBounds`, errors);
    validateConversion(
      state?.logicalBounds ?? {},
      state?.physicalBounds ?? {},
      state?.devicePixelRatio,
      label,
      errors,
    );
    for (const field of ['action', 'source', 'playerState', 'captureMethod']) {
      if (typeof state?.[field] !== 'string' || state[field] === '') {
        errors.push(`${label}.${field}: expected nonempty string`);
      }
    }
    for (const field of ['nativeFullscreen', 'lyricsOpen', 'focus', 'reducedMotion']) {
      if (typeof state?.[field] !== 'boolean') errors.push(`${label}.${field}: expected boolean`);
    }
    if (state?.caseId !== INTERACTION_CASE_ID && state?.songId !== 'quiet-light') {
      errors.push(`${label}.songId: expected quiet-light`);
    }
    if (!isObject(state?.assertions)) errors.push(`${label}.assertions: expected object`);
  }
}

function validateInteractionAssertions(row, errors) {
  const assertions = row?.assertions;
  const fail = () =>
    errors.push(`${INTERACTION_CASE_ID}.${row?.action}: assertions are incomplete`);
  switch (row?.action) {
    case 'manual-scroll-unfollow':
      if (assertions?.followVisible !== true) fail();
      break;
    case 'follow-restored':
      if (assertions?.followVisible !== false) fail();
      break;
    case 'click-seek':
      if (
        assertions?.activeLineIndex !== 4 ||
        !Number.isFinite(assertions?.positionMs) ||
        assertions.positionMs < 74_000 ||
        assertions.positionMs >= 89_000
      ) {
        fail();
      }
      break;
    case 'pause':
    case 'resume':
      if (assertions?.viaControl !== 'playerbar-play') fail();
      break;
    case 'focus-playerbar-sizing':
      if (
        assertions?.horizontalCoverage !== true ||
        !Number.isFinite(assertions?.viewportWidth) ||
        assertions.viewportWidth <= 0 ||
        assertions?.stageX !== 0 ||
        assertions?.playerBarX !== 0 ||
        assertions?.stageWidth !== assertions.viewportWidth ||
        assertions?.playerBarWidth !== assertions.viewportWidth
      ) {
        fail();
      }
      break;
    case 'transport-hidden':
      if (
        assertions?.transportDataVisible !== false ||
        assertions?.transportPointerEvents !== 'none'
      ) {
        fail();
      }
      break;
    case 'transport-revealed':
      if (
        assertions?.transportDataVisible !== true ||
        assertions?.transportPointerEvents !== 'auto'
      ) {
        fail();
      }
      break;
    case 'transport-focus-pinned':
      if (
        assertions?.transportDataVisible !== true ||
        assertions?.transportFocused !== true ||
        !Number.isFinite(assertions?.remainedVisibleAfterMs) ||
        assertions.remainedVisibleAfterMs < 2_400
      ) {
        fail();
      }
      break;
    case 'fullscreen-track-change':
      if (
        assertions?.previousSongId !== 'quiet-light' ||
        assertions?.nextSongId !== 'night-geometry'
      ) {
        fail();
      }
      break;
    case 'fullscreen-track-restored':
      if (
        assertions?.previousSongId !== 'night-geometry' ||
        assertions?.nextSongId !== 'quiet-light'
      ) {
        fail();
      }
      break;
    case 'escape-fullscreen':
      if (assertions?.retainedFocus !== true || assertions?.retainedLyrics !== true) fail();
      break;
    case 'escape-focus':
      if (assertions?.retainedLyrics !== true) fail();
      break;
    case 'escape-close':
      if (assertions?.lyricsClosed !== true) fail();
      break;
    case 'secondary-lyrics':
      if (
        assertions?.translationVisibility !== 'show' ||
        assertions?.romanizationVisibility !== 'show' ||
        !Number.isInteger(assertions?.translationCount) ||
        assertions.translationCount <= 0 ||
        !Number.isInteger(assertions?.romanizationCount) ||
        assertions.romanizationCount <= 0
      ) {
        fail();
      }
      break;
    default:
      fail();
  }
}

function validateInteractionSequence(manifest, states, commands, checklist, errors) {
  const sequence = manifest?.interactionSequence;
  const sequenceKeys = ['actions', 'id', 'stateSeqEnd', 'stateSeqStart'];
  if (!sameKeys(sequence, sequenceKeys)) {
    errors.push('manifest.interactionSequence: fields do not match interaction schema');
    return;
  }
  if (sequence.id !== INTERACTION_CASE_ID) {
    errors.push(`manifest.interactionSequence.id: expected ${INTERACTION_CASE_ID}`);
  }
  if (JSON.stringify(sequence.actions) !== JSON.stringify(INTERACTION_ACTIONS)) {
    errors.push(
      'manifest.interactionSequence.actions: expected exact ordered interaction contract',
    );
  }
  const rows = states.filter((row) => row.caseId === INTERACTION_CASE_ID);
  if (rows.length !== INTERACTION_ACTIONS.length) {
    errors.push(`state.jsonl: expected exactly ${INTERACTION_ACTIONS.length} interaction rows`);
    return;
  }
  if (sequence.stateSeqStart !== rows[0]?.seq || sequence.stateSeqEnd !== rows.at(-1)?.seq) {
    errors.push('manifest.interactionSequence: state sequence range is inaccurate');
  }
  for (const [index, action] of INTERACTION_ACTIONS.entries()) {
    const row = rows[index];
    const expected = INTERACTION_STATE[action];
    if (row?.action !== action || row?.seq !== rows[0].seq + index) {
      errors.push(`${INTERACTION_CASE_ID}: action order or sequence is invalid at ${action}`);
      continue;
    }
    if (
      row.source !== 'cdp-ui-input-and-viewport' ||
      row.captureMethod !== 'semantic-cdp' ||
      row.reducedMotion !== false
    ) {
      errors.push(`${INTERACTION_CASE_ID}.${action}: state provenance is invalid`);
    }
    compareFields(
      row,
      expected,
      ['nativeFullscreen', 'lyricsOpen', 'focus', 'playerState', 'songId'],
      `${INTERACTION_CASE_ID}.${action}`,
      errors,
    );
    validateInteractionAssertions(row, errors);
    if (!commands.includes(`interaction ${action}: passed`)) {
      errors.push(`commands.log: missing interaction ${action}`);
    }
  }
  if (!checklist.match(/^\s*-\s*\[x\]\s+S01-interactions\s*$/im)) {
    errors.push('checklist.md: missing completed S01-interactions entry');
  }
}

function validateExternalProbe(states, casesById, interactionSequence, commands, errors) {
  const probes = states.filter((row) => row.caseId === 'external-native-api');
  if (probes.length !== 1) {
    errors.push('state.jsonl: expected exactly one external-native-api probe');
    return;
  }
  const probe = probes[0];
  const lastCaseSeq = Math.max(...[...casesById.values()].map((item) => item.stateSeqEnd));
  if (probe.seq <= lastCaseSeq) errors.push('external-native-api: probe must follow all W/S cases');
  if (
    Number.isInteger(interactionSequence?.stateSeqEnd) &&
    probe.seq <= interactionSequence.stateSeqEnd
  ) {
    errors.push('external-native-api: probe must follow the interaction sequence');
  }
  if (
    probe.action !== 'external-native-api' ||
    probe.source !== 'cdp-native-api' ||
    probe.captureMethod !== 'semantic-cdp' ||
    probe.nativeFullscreen !== false ||
    probe.focus !== false
  ) {
    errors.push('external-native-api: state provenance is invalid');
  }
  const assertions = probe.assertions;
  if (
    assertions?.windowLabel !== 'main' ||
    assertions?.nativeFullscreenBefore !== true ||
    assertions?.setFullscreenFulfilled !== true ||
    assertions?.nativeFullscreenAfter !== false ||
    assertions?.reconciledFullscreen !== false ||
    assertions?.exactRestoration !== true
  ) {
    errors.push('external-native-api: native transition assertions are incomplete');
  }
  if (
    !commands.includes(
      'external-native-api: label main, true -> fulfilled set(false) -> false, reconciled',
    )
  ) {
    errors.push('commands.log: missing external-native-api transition evidence');
  }
}

function validateCase(evidenceCase, expected, states, root, shaEntries, errors) {
  const label = `manifest.cases.${evidenceCase?.id ?? '<missing-id>'}`;
  if (!sameKeys(evidenceCase, CASE_KEYS)) errors.push(`${label}: fields do not match case schema`);
  compareFields(
    evidenceCase,
    expected,
    ['presentation', 'theme', 'locale', 'backgroundMode', 'entryPath', 'exitPath', 'reducedMotion'],
    label,
    errors,
  );
  validateBounds(
    evidenceCase?.sourceLogicalBounds,
    'logical-px',
    `${label}.sourceLogicalBounds`,
    errors,
  );
  validateBounds(
    evidenceCase?.sourcePhysicalBounds,
    'physical-px',
    `${label}.sourcePhysicalBounds`,
    errors,
  );
  validateBounds(
    evidenceCase?.captureLogicalBounds,
    'logical-px',
    `${label}.captureLogicalBounds`,
    errors,
  );
  validateBounds(
    evidenceCase?.capturePhysicalBounds,
    'physical-px',
    `${label}.capturePhysicalBounds`,
    errors,
  );
  validateBounds(
    evidenceCase?.restoredLogicalBounds,
    'logical-px',
    `${label}.restoredLogicalBounds`,
    errors,
  );
  validateBounds(
    evidenceCase?.restoredPhysicalBounds,
    'physical-px',
    `${label}.restoredPhysicalBounds`,
    errors,
  );
  if (
    evidenceCase?.sourceLogicalBounds?.width !== expected.width ||
    evidenceCase?.sourceLogicalBounds?.height !== expected.height
  ) {
    errors.push(`${label}.sourceLogicalBounds: expected ${expected.width}x${expected.height}`);
  }
  validateConversion(
    evidenceCase?.sourceLogicalBounds ?? {},
    evidenceCase?.sourcePhysicalBounds ?? {},
    evidenceCase?.devicePixelRatio,
    `${label}.source`,
    errors,
  );
  validateConversion(
    evidenceCase?.captureLogicalBounds ?? {},
    evidenceCase?.capturePhysicalBounds ?? {},
    evidenceCase?.devicePixelRatio,
    `${label}.capture`,
    errors,
  );
  compareBounds(
    evidenceCase?.restoredLogicalBounds,
    evidenceCase?.sourceLogicalBounds,
    `${label}.restoredLogicalBounds`,
    errors,
  );
  compareBounds(
    evidenceCase?.restoredPhysicalBounds,
    evidenceCase?.sourcePhysicalBounds,
    `${label}.restoredPhysicalBounds`,
    errors,
  );

  const expectedScreenshot = `screenshots/${evidenceCase.id}.png`;
  if (evidenceCase?.screenshot !== expectedScreenshot) {
    errors.push(`${label}.screenshot: expected ${expectedScreenshot}`);
  }
  const screenshotPath = safeRootPath(root, evidenceCase?.screenshot);
  if (!screenshotPath) {
    errors.push(`${label}.screenshot: path must stay under evidence root`);
  } else if (validateRegularFile(screenshotPath, `${label}.screenshot`, errors)) {
    const actualHash = hashFile(screenshotPath);
    if (!SHA_PATTERN.test(evidenceCase?.screenshotSha256 ?? '')) {
      errors.push(`${label}.screenshotSha256: expected lowercase SHA-256`);
    }
    if (evidenceCase?.screenshotSha256 !== actualHash) {
      errors.push(`${label}.screenshotSha256: does not match screenshot`);
    }
    if (shaEntries.get(expectedScreenshot) !== actualHash) {
      errors.push(`sha256.txt: ${expectedScreenshot} does not match screenshot`);
    }
    const pngSize = readPngSize(screenshotPath, `${label}.screenshot`, errors);
    const captureWidth = evidenceCase?.capturePhysicalBounds?.width;
    const captureHeight = evidenceCase?.capturePhysicalBounds?.height;
    if (
      pngSize &&
      (!Number.isFinite(captureWidth) ||
        !Number.isFinite(captureHeight) ||
        pngSize.width !== Math.round(captureWidth) ||
        pngSize.height !== Math.round(captureHeight))
    ) {
      errors.push(`${label}.screenshot: PNG dimensions do not match native client crop`);
    }
  }

  if (
    !Number.isInteger(evidenceCase?.stateSeqStart) ||
    !Number.isInteger(evidenceCase?.stateSeqEnd)
  ) {
    errors.push(`${label}: state sequence bounds must be integers`);
    return;
  }
  if (evidenceCase.stateSeqStart >= evidenceCase.stateSeqEnd) {
    errors.push(`${label}: stateSeqStart must precede stateSeqEnd`);
  }
  const rows = states.filter(
    (row) => row.seq >= evidenceCase.stateSeqStart && row.seq <= evidenceCase.stateSeqEnd,
  );
  if (rows.length < 3 || rows.some((row) => row.caseId !== evidenceCase.id)) {
    errors.push(`${label}: state sequence range must contain only this case`);
  }
  const start = states.find((row) => row.seq === evidenceCase.stateSeqStart);
  const restored = states.find((row) => row.seq === evidenceCase.stateSeqEnd);
  const captures = rows.filter((row) => row.action === 'capture');
  const capture = captures[0];
  if (captures.length !== 1) errors.push(`${label}: state range must contain exactly one capture`);
  if (start?.caseId !== evidenceCase.id || restored?.caseId !== evidenceCase.id || !capture) {
    errors.push(`${label}: state sequence endpoints are missing or mismatched`);
    return;
  }
  compareBounds(
    start.logicalBounds,
    evidenceCase.sourceLogicalBounds,
    `${label}.sourceState`,
    errors,
  );
  compareBounds(
    start.physicalBounds,
    evidenceCase.sourcePhysicalBounds,
    `${label}.sourceState`,
    errors,
  );
  if (
    start.devicePixelRatio !== evidenceCase.devicePixelRatio ||
    start.reducedMotion !== evidenceCase.reducedMotion ||
    start.focus !== false ||
    start.nativeFullscreen !== false
  ) {
    errors.push(`${label}: starting semantic state does not match the case`);
  }
  if (
    start.assertions?.provider !== 'fake' ||
    start.assertions?.search !== '?provider=fake' ||
    start.assertions?.entryPath !== evidenceCase.entryPath
  ) {
    errors.push(`${label}: starting provider, query, or entry-path assertion is stale`);
  }
  if (restored.action !== 'restored') errors.push(`${label}: final state action must be restored`);
  compareBounds(
    restored.logicalBounds,
    evidenceCase.restoredLogicalBounds,
    `${label}.restoredState`,
    errors,
  );
  compareBounds(
    restored.physicalBounds,
    evidenceCase.restoredPhysicalBounds,
    `${label}.restoredState`,
    errors,
  );
  if (
    restored.devicePixelRatio !== evidenceCase.devicePixelRatio ||
    restored.nativeFullscreen !== false ||
    restored.focus !== false ||
    restored.assertions?.exactRestoration !== true ||
    restored.assertions?.exitPath !== evidenceCase.exitPath
  ) {
    errors.push(`${label}: restored semantic state is incomplete or stale`);
  }
  if (capture.source !== 'native-hwnd-client') {
    errors.push(`${label}: capture source must be native-hwnd-client`);
  }
  if (capture.captureMethod !== 'native-hwnd-client') {
    errors.push(`${label}: capture method must be native-hwnd-client`);
  }
  compareBounds(
    capture.logicalBounds,
    evidenceCase.captureLogicalBounds,
    `${label}.captureState`,
    errors,
  );
  compareBounds(
    capture.physicalBounds,
    evidenceCase.capturePhysicalBounds,
    `${label}.captureState`,
    errors,
  );
  if (capture.devicePixelRatio !== evidenceCase.devicePixelRatio) {
    errors.push(`${label}: capture DPR does not match case`);
  }
  if (capture.reducedMotion !== evidenceCase.reducedMotion) {
    errors.push(`${label}: capture reduced-motion state does not match case`);
  }
  if (capture.focus !== (evidenceCase.presentation === 'focus')) {
    errors.push(`${label}: capture focus state does not match presentation`);
  }
  if (capture.nativeFullscreen !== (evidenceCase.presentation === 'native-fullscreen')) {
    errors.push(`${label}: native fullscreen state does not match presentation`);
  }
  if (!capture.lyricsOpen || capture.songId !== 'quiet-light') {
    errors.push(`${label}: capture must show quiet-light Lyrics`);
  }
  if (
    capture.assertions?.provider !== 'fake' ||
    capture.assertions?.fixtureSongId !== 'quiet-light' ||
    capture.assertions?.clientCropMatchesBounds !== true ||
    capture.assertions?.exitPath !== evidenceCase.exitPath
  ) {
    errors.push(`${label}: capture provenance assertions are incomplete`);
  }
  if (evidenceCase.reducedMotion) {
    for (const field of [
      'maxTransitionDurationMs',
      'maxAnimationDurationMs',
      'activeWordRafProgressWrites',
    ]) {
      if (capture.assertions?.[field] !== 0) {
        errors.push(`${label}: reduced-motion assertion ${field} must be numeric zero`);
      }
    }
  }
}

function verifyWindowsLyricsAcceptance({ platform, root }) {
  const errors = [];
  if (platform !== 'windows') errors.push('platform: Task 9 supports only windows');
  if (typeof root !== 'string' || !isAbsolute(root)) {
    errors.push('root: expected an absolute path');
    return errors;
  }
  const normalizedRoot = resolve(root);
  if (!existsSync(normalizedRoot)) {
    errors.push('root: directory does not exist');
    return errors;
  }
  for (const name of REQUIRED_ROOT_FILES) {
    validateRegularFile(join(normalizedRoot, name), name, errors);
  }
  if (errors.some((error) => error.endsWith('missing file'))) return errors;

  const checklist = readFileSync(join(normalizedRoot, 'checklist.md'), 'utf8');
  const commands = readFileSync(join(normalizedRoot, 'commands.log'), 'utf8');
  const manifestText = readFileSync(join(normalizedRoot, 'manifest.json'), 'utf8');
  const stateText = readFileSync(join(normalizedRoot, 'state.jsonl'), 'utf8');
  const shaText = readFileSync(join(normalizedRoot, 'sha256.txt'), 'utf8');
  const screenshotsDirectory = join(normalizedRoot, 'screenshots');
  const expectedScreenshots = [
    ...Object.keys(WINDOWS_CASE_CONTRACT).map((id) => `${id}.png`),
    'S01.png',
  ].sort();
  if (!existsSync(screenshotsDirectory)) {
    errors.push('screenshots: missing directory');
  } else {
    const screenshotStat = lstatSync(screenshotsDirectory);
    if (!screenshotStat.isDirectory() || screenshotStat.isSymbolicLink()) {
      errors.push('screenshots: must be a regular non-symlink directory');
    } else {
      const actualScreenshots = readdirSync(screenshotsDirectory).sort();
      if (JSON.stringify(actualScreenshots) !== JSON.stringify(expectedScreenshots)) {
        errors.push('screenshots: expected exactly W01.png through W09.png and S01.png');
      }
    }
  }
  scanPrivateUrls('checklist.md', checklist, errors);
  scanPrivateUrls('commands.log', commands, errors);
  scanPrivateUrls('manifest.json', manifestText, errors);
  scanPrivateUrls('state.jsonl', stateText, errors);

  const manifest = parseJson(manifestText, 'manifest.json', errors);
  validateManifestIdentity(manifest, checklist, commands, errors);
  const states = [];
  for (const [index, line] of stateText.split(/\r?\n/).entries()) {
    if (line === '') continue;
    const row = parseJson(line, `state.jsonl:${index + 1}`, errors);
    if (row !== null) states.push(row);
  }

  const shaEntries = parseShaFile(shaText, errors);
  const expectedSha = expectedHashNames();
  for (const name of expectedSha) {
    if (!shaEntries.has(name)) errors.push(`sha256.txt: missing ${name}`);
  }
  for (const name of shaEntries.keys()) {
    if (!expectedSha.includes(name)) errors.push(`sha256.txt: unexpected entry ${name}`);
  }
  for (const name of ['checklist.md', 'manifest.json', 'commands.log', 'state.jsonl']) {
    const actual = hashFile(join(normalizedRoot, name));
    if (shaEntries.get(name) !== actual) errors.push(`sha256.txt: ${name} hash mismatch`);
  }

  if (manifest && Array.isArray(manifest.cases)) {
    const casesById = new Map();
    for (const evidenceCase of manifest.cases) {
      if (typeof evidenceCase?.id !== 'string') {
        errors.push('manifest.cases: every case requires a string ID');
        continue;
      }
      if (casesById.has(evidenceCase.id))
        errors.push(`manifest.cases: duplicate ${evidenceCase.id}`);
      casesById.set(evidenceCase.id, evidenceCase);
    }
    const expectedIds = [...Object.keys(WINDOWS_CASE_CONTRACT), 'S01'];
    for (const id of expectedIds) {
      if (!casesById.has(id)) errors.push(`manifest.cases: missing ${id}`);
      if (!checklist.match(new RegExp(`\\b${id}\\b`))) errors.push(`checklist.md: missing ${id}`);
    }
    for (const id of casesById.keys()) {
      if (!expectedIds.includes(id)) errors.push(`manifest.cases: unexpected ${id}`);
    }
    if (manifest.cases.length !== expectedIds.length) {
      errors.push(`manifest.cases: expected exactly ${expectedIds.length} cases`);
    }
    validateStateRows(states, casesById, errors);
    for (const [id, expected] of Object.entries(WINDOWS_CASE_CONTRACT)) {
      const evidenceCase = casesById.get(id);
      if (evidenceCase) {
        validateCase(evidenceCase, expected, states, normalizedRoot, shaEntries, errors);
      }
    }
    const smoke = casesById.get('S01');
    if (smoke) validateCase(smoke, SMOKE_CONTRACT, states, normalizedRoot, shaEntries, errors);
    validateInteractionSequence(manifest, states, commands, checklist, errors);
    validateExternalProbe(states, casesById, manifest.interactionSequence, commands, errors);
  } else {
    errors.push('manifest.cases: expected array');
  }

  if (manifest) {
    const binaryPath = manifest.visualBinaryPath;
    if (typeof binaryPath !== 'string' || !isAbsolute(binaryPath)) {
      errors.push('manifest.visualBinaryPath: expected absolute path');
    } else if (validateRegularFile(binaryPath, 'visual binary', errors)) {
      const actual = hashFile(binaryPath);
      if (!SHA_PATTERN.test(manifest.visualBinarySha256 ?? '')) {
        errors.push('manifest.visualBinarySha256: expected lowercase SHA-256');
      }
      if (manifest.visualBinarySha256 !== actual) {
        errors.push('manifest.visualBinarySha256: does not match visual binary');
      }
      if (shaEntries.get('@visual-binary') !== actual) {
        errors.push('sha256.txt: visual binary hash mismatch');
      }
    }
  }

  return errors;
}

function listRegularRootFiles(root, label, errors, { allowDirectories = false } = {}) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (allowDirectories && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      errors.push(`${label}: ${entry.name} must be a regular non-symlink file`);
      continue;
    }
    files.push(entry.name);
  }
  return files.sort();
}

function validateChecksumSet(root, checksumName, expectedNames, errors) {
  const checksumPath = join(root, checksumName);
  if (!validateRegularFile(checksumPath, checksumName, errors)) return new Map();
  const entries = parseChecksumFile(readFileSync(checksumPath, 'utf8'), checksumName, errors);
  const expected = [...expectedNames].sort();
  for (const name of expected) {
    if (!entries.has(name)) errors.push(`${checksumName}: missing ${name}`);
  }
  for (const name of entries.keys()) {
    if (
      name === '' ||
      name.includes('/') ||
      name.includes('\\') ||
      basename(name) !== name ||
      !expected.includes(name)
    ) {
      errors.push(`${checksumName}: unexpected or unsafe entry ${name}`);
    }
  }
  for (const name of expected) {
    const path = join(root, name);
    if (validateRegularFile(path, `${checksumName}:${name}`, errors)) {
      const actual = hashFile(path);
      if (entries.get(name) !== actual) errors.push(`${checksumName}: ${name} hash mismatch`);
    }
  }
  return entries;
}

function validateBuildIdentity(buildIdentityPath, errors) {
  if (typeof buildIdentityPath !== 'string' || !isAbsolute(buildIdentityPath)) {
    errors.push('buildIdentity: expected an absolute path');
    return null;
  }
  const identityPath = resolve(buildIdentityPath);
  if (!validateRegularFile(identityPath, 'BUILD-IDENTITY.json', errors)) return null;
  const packageRoot = dirname(identityPath);
  const identity = parseJson(readFileSync(identityPath, 'utf8'), 'BUILD-IDENTITY.json', errors);
  if (!sameKeys(identity, BUILD_IDENTITY_KEYS)) {
    errors.push('BUILD-IDENTITY.json: fields do not match schemaVersion 1');
  }
  if (identity?.schemaVersion !== 1) errors.push('buildIdentity.schemaVersion: expected 1');
  for (const field of ['gitCommit', 'gitTree']) {
    if (typeof identity?.[field] !== 'string' || !EXACT_GIT_OBJECT_PATTERN.test(identity[field])) {
      errors.push(`buildIdentity.${field}: expected 40 lowercase hexadecimal characters`);
    }
  }
  for (const field of ['workflowRunId', 'workflowRunAttempt']) {
    if (typeof identity?.[field] !== 'string' || !DECIMAL_PATTERN.test(identity[field])) {
      errors.push(`buildIdentity.${field}: expected a nonempty decimal string`);
    }
  }
  if (typeof identity?.appVersion !== 'string' || !APP_VERSION_PATTERN.test(identity.appVersion)) {
    errors.push('buildIdentity.appVersion: expected a semantic application version');
  }
  if (!sameKeys(identity?.appImage, BUILD_APPIMAGE_KEYS)) {
    errors.push('buildIdentity.appImage: expected exactly fileName and sha256');
  }
  const imageName = identity?.appImage?.fileName;
  if (
    typeof imageName !== 'string' ||
    basename(imageName) !== imageName ||
    imageName.includes('\\') ||
    !imageName.endsWith('.AppImage')
  ) {
    errors.push('buildIdentity.appImage.fileName: expected a root AppImage filename');
  }
  if (
    typeof identity?.appImage?.sha256 !== 'string' ||
    !SHA_PATTERN.test(identity.appImage.sha256)
  ) {
    errors.push('buildIdentity.appImage.sha256: expected lowercase SHA-256');
  }

  if (!existsSync(packageRoot)) {
    errors.push('buildIdentity: package root does not exist');
    return { identity, packageRoot };
  }
  const packageFiles = listRegularRootFiles(packageRoot, 'tester bundle', errors, {
    allowDirectories: true,
  });
  const expectedPackageFiles = [
    ...LINUX_BUNDLE_STATIC_FILES,
    ...(typeof imageName === 'string' && basename(imageName) === imageName ? [imageName] : []),
  ].sort();
  if (JSON.stringify(packageFiles) !== JSON.stringify(expectedPackageFiles)) {
    errors.push('tester bundle: file set does not match the final AppImage bundle schema');
  }
  const expectedFiles = expectedPackageFiles.filter((name) => name !== 'SHA256SUMS');
  const sums = validateChecksumSet(packageRoot, 'SHA256SUMS', expectedFiles, errors);
  if (typeof imageName === 'string' && basename(imageName) === imageName) {
    const imagePath = join(packageRoot, imageName);
    if (validateRegularFile(imagePath, 'packaged AppImage', errors)) {
      const imageHash = hashFile(imagePath);
      if (identity?.appImage?.sha256 !== imageHash) {
        errors.push('buildIdentity.appImage.sha256: does not match packaged AppImage');
      }
      if (sums.get(imageName) !== imageHash) {
        errors.push('SHA256SUMS: packaged AppImage hash mismatch');
      }
    }
  }
  if (sums.get('BUILD-IDENTITY.json') !== hashFile(identityPath)) {
    errors.push('SHA256SUMS: BUILD-IDENTITY.json hash mismatch');
  }
  return { identity, packageRoot };
}

function parseTsv(text, expectedHeader, label, errors) {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  if (lines.length === 0) {
    errors.push(`${label}: empty file`);
    return [];
  }
  const header = lines[0].split('\t');
  if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
    errors.push(`${label}: header does not match schema`);
    return [];
  }
  return lines.slice(1).map((line, index) => {
    const values = line.split('\t');
    if (values.length !== expectedHeader.length) {
      errors.push(`${label}:${index + 2}: column count does not match schema`);
    }
    return Object.fromEntries(expectedHeader.map((name, field) => [name, values[field] ?? '']));
  });
}

function exactPhaseOrder(value) {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(LINUX_PHASES);
}

function validateLinuxModeReport(root, mode, identity, errors) {
  const label = `linux.${mode}`;
  const actualFiles = listRegularRootFiles(root, label, errors);
  if (JSON.stringify(actualFiles) !== JSON.stringify([...LINUX_REPORT_FILES].sort())) {
    errors.push(`${label}: evidence file set does not match schema`);
  }
  for (const name of LINUX_REPORT_FILES) {
    validateRegularFile(join(root, name), `${label}/${name}`, errors);
  }
  if (errors.some((error) => error.startsWith(`${label}/`) && error.endsWith('missing file'))) {
    return;
  }
  validateChecksumSet(
    root,
    'sha256.txt',
    LINUX_REPORT_FILES.filter((name) => name !== 'sha256.txt'),
    errors,
  );

  const checklist = readFileSync(join(root, 'checklist.md'), 'utf8');
  const commands = readFileSync(join(root, 'commands.log'), 'utf8');
  const manifestText = readFileSync(join(root, 'manifest.json'), 'utf8');
  const stateText = readFileSync(join(root, 'state.jsonl'), 'utf8');
  const log = readFileSync(join(root, 'yaqmc.log'), 'utf8');
  scanPrivateUrls(`${label}/checklist.md`, checklist, errors);
  scanPrivateUrls(`${label}/commands.log`, commands, errors);
  scanPrivateUrls(`${label}/manifest.json`, manifestText, errors);
  scanPrivateUrls(`${label}/state.jsonl`, stateText, errors);

  const manifest = parseJson(manifestText, `${label}/manifest.json`, errors);
  if (!sameKeys(manifest, LINUX_MANIFEST_KEYS)) {
    errors.push(`${label}.manifest: fields do not match Linux schemaVersion 1`);
  }
  if (manifest?.schemaVersion !== 1) errors.push(`${label}.manifest.schemaVersion: expected 1`);
  if (manifest?.platform !== 'linux') errors.push(`${label}.manifest.platform: expected linux`);
  if (manifest?.status !== 'captured') {
    errors.push(`${label}.manifest.status: must be captured, never an unverified pass claim`);
  }
  if (manifest?.mode !== mode) errors.push(`${label}.manifest.mode: expected ${mode}`);
  if (
    manifest?.requestedMode !== mode &&
    !(mode === 'auto' && manifest?.requestedMode === 'baseline')
  ) {
    errors.push(`${label}.manifest.requestedMode: invalid alias or mode`);
  }
  if (!isUtc(manifest?.startedAtUtc) || !isUtc(manifest?.endedAtUtc)) {
    errors.push(`${label}.manifest: start/end must be UTC ISO 8601`);
  }
  if (!exactPhaseOrder(manifest?.phases)) {
    errors.push(`${label}.manifest.phases: required phase order changed`);
  }
  for (const field of [
    'gitCommit',
    'gitTree',
    'workflowRunId',
    'workflowRunAttempt',
    'appVersion',
  ]) {
    if (manifest?.[field] !== identity?.[field]) {
      errors.push(`${label}.manifest.${field}: differs from BUILD-IDENTITY.json`);
    }
  }
  if (
    !sameKeys(manifest?.appImage, BUILD_APPIMAGE_KEYS) ||
    manifest?.appImage?.fileName !== identity?.appImage?.fileName ||
    manifest?.appImage?.sha256 !== identity?.appImage?.sha256
  ) {
    errors.push(`${label}.manifest.appImage: differs from BUILD-IDENTITY.json`);
  }
  const backend = manifest?.reportedBackend;
  if (!['wayland-native', 'xwayland', 'x11'].includes(backend)) {
    errors.push(`${label}.manifest.reportedBackend: unknown backend`);
  }
  if (mode === 'native-wayland' && backend !== 'wayland-native') {
    errors.push(`${label}: native-wayland must report wayland-native`);
  }
  if (mode === 'x11' && backend !== 'x11' && backend !== 'xwayland') {
    errors.push(`${label}: x11 mode must report x11 or xwayland`);
  }
  if (!log.includes(`display_backend="${backend ?? ''}"`)) {
    errors.push(`${label}/yaqmc.log: backend does not match manifest`);
  }
  if (checklistValue(checklist, 'verification') !== 'pending') {
    errors.push(`${label}/checklist.verification: must be pending`);
  }
  if (checklistValue(checklist, 'physicalPass') !== 'false') {
    errors.push(`${label}/checklist.physicalPass: must be false before maintainer verification`);
  }
  if (checklistValue(checklist, 'mode') !== mode) {
    errors.push(`${label}/checklist.mode: does not match manifest`);
  }
  if (checklistValue(checklist, 'reportedBackend') !== backend) {
    errors.push(`${label}/checklist.reportedBackend: does not match manifest`);
  }
  for (const phase of LINUX_PHASES) {
    if (!checklist.includes(`- [x] ${phase}`)) errors.push(`${label}/checklist: missing ${phase}`);
    if (!commands.includes(`phase ${phase}: captured`)) {
      errors.push(`${label}/commands.log: missing ${phase}`);
    }
  }

  const states = [];
  for (const [index, line] of stateText.split(/\r?\n/).entries()) {
    if (line === '') continue;
    const row = parseJson(line, `${label}/state.jsonl:${index + 1}`, errors);
    if (row !== null) states.push(row);
  }
  if (states.length !== LINUX_PHASES.length) {
    errors.push(`${label}/state.jsonl: expected exactly one marker per required phase`);
  }
  states.forEach((row, index) => {
    const phase = LINUX_PHASES[index];
    if (!sameKeys(row, LINUX_STATE_KEYS)) {
      errors.push(`${label}/state.jsonl:${index + 1}: fields do not match schema`);
    }
    if (
      row?.schemaVersion !== 1 ||
      row?.seq !== index + 1 ||
      row?.phase !== phase ||
      row?.mode !== mode ||
      row?.reportedBackend !== backend ||
      !isUtc(row?.timestampUtc)
    ) {
      errors.push(`${label}/state.jsonl:${index + 1}: phase state mismatch`);
    }
    const expectedWindow = phase === 'shutdown' ? 'stopped' : 'running';
    if (row?.windowState !== expectedWindow) {
      errors.push(`${label}/state.jsonl:${index + 1}: window state must be ${expectedWindow}`);
    }
    const expectedGraphics = mode === 'software' ? 'software' : 'auto';
    if (row?.graphicsMode !== expectedGraphics) {
      errors.push(`${label}/state.jsonl:${index + 1}: graphics mode mismatch`);
    }
  });

  const samples = parseTsv(
    readFileSync(join(root, 'process-samples.tsv'), 'utf8'),
    LINUX_SAMPLE_HEADER,
    `${label}/process-samples.tsv`,
    errors,
  );
  const treeRows = parseTsv(
    readFileSync(join(root, 'process-tree-samples.tsv'), 'utf8'),
    LINUX_TREE_HEADER,
    `${label}/process-tree-samples.tsv`,
    errors,
  );
  const samplePhases = [];
  for (const [index, row] of samples.entries()) {
    if (!LINUX_PHASES.includes(row.phase)) {
      errors.push(`${label}/process-samples.tsv:${index + 2}: unknown phase`);
      continue;
    }
    if (!samplePhases.includes(row.phase)) samplePhases.push(row.phase);
    if (!isUtc(row.timestamp_utc)) {
      errors.push(`${label}/process-samples.tsv:${index + 2}: invalid UTC timestamp`);
    }
    for (const field of [
      'process_count',
      'total_cpu_percent',
      'total_rss_kib',
      'total_pss_kib',
      'total_threads',
    ]) {
      if (row[field] === '' || !Number.isFinite(Number(row[field])) || Number(row[field]) < 0) {
        errors.push(`${label}/process-samples.tsv:${index + 2}: invalid ${field}`);
      }
    }
    if (row.reported_backend !== backend) {
      errors.push(`${label}/process-samples.tsv:${index + 2}: backend mismatch`);
    }
    const expectedWindow = row.phase === 'shutdown' ? 'stopped' : 'running';
    if (row.window_state !== expectedWindow) {
      errors.push(`${label}/process-samples.tsv:${index + 2}: window state mismatch`);
    }
    if (mode === 'native-wayland' && row.gdk_backend !== 'wayland') {
      errors.push(`${label}/process-samples.tsv:${index + 2}: native mode lost GDK Wayland`);
    }
    if (mode === 'x11' && row.gdk_backend !== 'x11') {
      errors.push(`${label}/process-samples.tsv:${index + 2}: x11 mode lost GDK X11`);
    }
    if (mode === 'auto' && row.gdk_backend !== '') {
      errors.push(`${label}/process-samples.tsv:${index + 2}: auto must leave GDK unset`);
    }
    if (
      mode === 'software' &&
      (row.graphics_mode !== 'software' || row.dmabuf_disabled !== '' || row.software_gl !== '')
    ) {
      errors.push(
        `${label}/process-samples.tsv:${index + 2}: software mode must use the Chromium host switch without legacy renderer overrides`,
      );
    }
  }
  if (JSON.stringify(samplePhases) !== JSON.stringify(LINUX_PHASES)) {
    errors.push(`${label}/process-samples.tsv: required phases are missing or reordered`);
  }

  const treeKeys = new Map();
  for (const [index, row] of treeRows.entries()) {
    if (
      !LINUX_PHASES.includes(row.phase) ||
      row.phase === 'shutdown' ||
      !isUtc(row.timestamp_utc)
    ) {
      errors.push(`${label}/process-tree-samples.tsv:${index + 2}: invalid phase or timestamp`);
    }
    for (const field of ['pid', 'ppid', 'cpu_percent', 'rss_kib', 'pss_kib', 'threads']) {
      if (row[field] === '' || !Number.isFinite(Number(row[field])) || Number(row[field]) < 0) {
        errors.push(`${label}/process-tree-samples.tsv:${index + 2}: invalid ${field}`);
      }
    }
    if (row.command === '' || row.command.includes('\t')) {
      errors.push(`${label}/process-tree-samples.tsv:${index + 2}: invalid command`);
    }
    const key = `${row.phase}\0${row.timestamp_utc}`;
    treeKeys.set(key, (treeKeys.get(key) ?? 0) + 1);
  }
  for (const row of samples) {
    if (row.phase === 'shutdown') continue;
    const count = treeKeys.get(`${row.phase}\0${row.timestamp_utc}`) ?? 0;
    if (count !== Number(row.process_count) || count === 0) {
      errors.push(`${label}: process tree does not match ${row.phase} sample`);
    }
  }
}

function verifyLinuxLyricsAcceptance({ root, buildIdentity, identityOnly }) {
  const errors = [];
  const build = validateBuildIdentity(buildIdentity, errors);
  if (identityOnly) return errors;
  if (typeof root !== 'string' || !isAbsolute(root)) {
    errors.push('root: expected an absolute Linux acceptance path');
    return errors;
  }
  const normalizedRoot = resolve(root);
  if (!existsSync(normalizedRoot)) {
    errors.push('root: Linux acceptance directory does not exist');
    return errors;
  }
  const modes = [];
  for (const entry of readdirSync(normalizedRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !LINUX_MODES.includes(entry.name)) {
      errors.push(`root: unexpected Linux evidence entry ${entry.name}`);
      continue;
    }
    modes.push(entry.name);
  }
  for (const required of ['auto', 'native-wayland', 'x11']) {
    if (!modes.includes(required)) errors.push(`root: missing required ${required} mode`);
  }
  if (!build?.identity) return errors;
  for (const mode of modes) {
    validateLinuxModeReport(join(normalizedRoot, mode), mode, build.identity, errors);
  }
  return errors;
}

export function verifyLyricsAcceptance(options) {
  if (options?.platform === 'windows') {
    if (options.identityOnly || options.buildIdentity) {
      return ['platform: Windows verification does not accept Linux build identity flags'];
    }
    return verifyWindowsLyricsAcceptance(options);
  }
  if (options?.platform === 'linux') return verifyLinuxLyricsAcceptance(options);
  return ['platform: expected windows or linux'];
}

function parseArguments(argv) {
  const result = { identityOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--identity-only') {
      if (result.identityOnly) return null;
      result.identityOnly = true;
      continue;
    }
    if (!['--platform', '--root', '--build-identity'].includes(flag)) return null;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return null;
    const key = flag === '--build-identity' ? 'buildIdentity' : flag.slice(2);
    if (result[key] !== undefined) return null;
    result[key] = value;
    index += 1;
  }
  if (result.platform === 'windows') {
    return result.root && !result.identityOnly && !result.buildIdentity ? result : null;
  }
  if (result.platform === 'linux') {
    if (!result.buildIdentity) return null;
    return result.identityOnly || result.root ? result : null;
  }
  return null;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(
      'Usage: node scripts/verify-lyrics-acceptance.mjs --platform windows --root <absolute-root>\n' +
        '   or: node scripts/verify-lyrics-acceptance.mjs --platform linux --build-identity <absolute-file> [--identity-only | --root <absolute-root>]',
    );
    process.exitCode = 2;
    return;
  }
  const errors = verifyLyricsAcceptance(options);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    console.error(`Lyrics acceptance verification failed with ${errors.length} error(s).`);
    process.exitCode = 1;
    return;
  }
  if (options.identityOnly) {
    console.log(`Linux build identity verified: ${resolve(options.buildIdentity)}`);
  } else {
    console.log(`Lyrics acceptance evidence verified: ${resolve(options.root)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
