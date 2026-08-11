#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

const MANIFEST_KEYS = Object.freeze([
  'appVersion',
  'capturedAtUtc',
  'cases',
  'fixtureSongId',
  'gitCommit',
  'gitTree',
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

function parseShaFile(text, errors) {
  const entries = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line === '') continue;
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      errors.push(`sha256.txt:${index + 1}: invalid entry`);
      continue;
    }
    const [, hash, name] = match;
    if (entries.has(name)) errors.push(`sha256.txt: duplicate entry ${name}`);
    entries.set(name, hash);
  }
  return entries;
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
  if (manifest?.visualBuildKind !== 'tauri-no-bundle') {
    errors.push('manifest.visualBuildKind: expected tauri-no-bundle');
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
    if (!casesById.has(state?.caseId) && state?.caseId !== 'external-native-api') {
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
    if (state?.songId !== 'quiet-light') errors.push(`${label}.songId: expected quiet-light`);
    if (!isObject(state?.assertions)) errors.push(`${label}.assertions: expected object`);
  }
}

function validateExternalProbe(states, casesById, commands, errors) {
  const probes = states.filter((row) => row.caseId === 'external-native-api');
  if (probes.length !== 1) {
    errors.push('state.jsonl: expected exactly one external-native-api probe');
    return;
  }
  const probe = probes[0];
  const lastCaseSeq = Math.max(...[...casesById.values()].map((item) => item.stateSeqEnd));
  if (probe.seq <= lastCaseSeq) errors.push('external-native-api: probe must follow all W/S cases');
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

export function verifyLyricsAcceptance({ platform, root }) {
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
    validateExternalProbe(states, casesById, commands, errors);
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

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== '--platform' && flag !== '--root') || value === undefined) return null;
    result[flag.slice(2)] = value;
  }
  return result.platform && result.root ? result : null;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error(
      'Usage: node scripts/verify-lyrics-acceptance.mjs --platform windows --root <absolute-root>',
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
  console.log(`Lyrics acceptance evidence verified: ${resolve(options.root)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
