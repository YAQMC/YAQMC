import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The production verifier is an executable ESM file; this cast keeps its test seam explicit without a second API file.
// @ts-expect-error TypeScript does not infer declarations from the tracked .mjs CLI entry point.
import { verifyLyricsAcceptance as verifyLyricsAcceptanceModule } from './verify-lyrics-acceptance.mjs';

const verifyLyricsAcceptance = verifyLyricsAcceptanceModule as (options: {
  platform: string;
  root: string;
}) => string[];

type Presentation = 'normal' | 'focus' | 'native-fullscreen';

interface MatrixRow {
  width: number;
  height: number;
  presentation: Presentation;
  theme: 'light' | 'dark';
  locale: 'en-US' | 'zh-CN';
  backgroundMode: 'default' | 'artwork' | 'color' | 'image';
  entryPath: string;
  exitPath: string;
  reducedMotion: boolean;
}

const matrix = {
  W01: {
    width: 1280,
    height: 800,
    presentation: 'normal',
    theme: 'light',
    locale: 'en-US',
    backgroundMode: 'default',
    entryPath: 'playerbar-lyrics',
    exitPath: 'lyrics-close',
    reducedMotion: false,
  },
  W02: {
    width: 1280,
    height: 800,
    presentation: 'focus',
    theme: 'dark',
    locale: 'zh-CN',
    backgroundMode: 'artwork',
    entryPath: 'focus-toggle',
    exitPath: 'focus-toggle',
    reducedMotion: false,
  },
  W03: {
    width: 1280,
    height: 800,
    presentation: 'native-fullscreen',
    theme: 'dark',
    locale: 'en-US',
    backgroundMode: 'image',
    entryPath: 'header-fullscreen',
    exitPath: 'header-fullscreen',
    reducedMotion: false,
  },
  W04: {
    width: 1000,
    height: 700,
    presentation: 'normal',
    theme: 'light',
    locale: 'zh-CN',
    backgroundMode: 'color',
    entryPath: 'playerbar-lyrics',
    exitPath: 'escape',
    reducedMotion: true,
  },
  W05: {
    width: 1000,
    height: 700,
    presentation: 'focus',
    theme: 'dark',
    locale: 'en-US',
    backgroundMode: 'image',
    entryPath: 'focus-toggle',
    exitPath: 'escape',
    reducedMotion: false,
  },
  W06: {
    width: 1000,
    height: 700,
    presentation: 'native-fullscreen',
    theme: 'dark',
    locale: 'zh-CN',
    backgroundMode: 'artwork',
    entryPath: 'playerbar-fullscreen',
    exitPath: 'escape',
    reducedMotion: true,
  },
  W07: {
    width: 1000,
    height: 1000,
    presentation: 'normal',
    theme: 'dark',
    locale: 'en-US',
    backgroundMode: 'artwork',
    entryPath: 'playerbar-lyrics',
    exitPath: 'lyrics-close',
    reducedMotion: false,
  },
  W08: {
    width: 1000,
    height: 1000,
    presentation: 'focus',
    theme: 'light',
    locale: 'zh-CN',
    backgroundMode: 'default',
    entryPath: 'focus-toggle',
    exitPath: 'focus-toggle',
    reducedMotion: true,
  },
  W09: {
    width: 1000,
    height: 1000,
    presentation: 'native-fullscreen',
    theme: 'light',
    locale: 'en-US',
    backgroundMode: 'color',
    entryPath: 'f11',
    exitPath: 'f11',
    reducedMotion: false,
  },
} as const satisfies Record<string, MatrixRow>;

const smoke: MatrixRow = {
  width: 1000,
  height: 680,
  presentation: 'normal',
  theme: 'dark',
  locale: 'en-US',
  backgroundMode: 'default',
  entryPath: 'playerbar-lyrics',
  exitPath: 'escape',
  reducedMotion: false,
};

const interactionActions = [
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
] as const;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'logical-px' | 'physical-px';
}

interface EvidenceCase extends Omit<MatrixRow, 'width' | 'height'> {
  id: string;
  devicePixelRatio: number;
  sourceLogicalBounds: Bounds;
  sourcePhysicalBounds: Bounds;
  captureLogicalBounds: Bounds;
  capturePhysicalBounds: Bounds;
  restoredLogicalBounds: Bounds;
  restoredPhysicalBounds: Bounds;
  screenshot: string;
  screenshotSha256: string;
  stateSeqStart: number;
  stateSeqEnd: number;
}

interface StateRow {
  seq: number;
  timestampUtc: string;
  caseId: string;
  action: string;
  source: string;
  logicalBounds: Bounds;
  physicalBounds: Bounds;
  devicePixelRatio: number;
  nativeFullscreen: boolean;
  lyricsOpen: boolean;
  focus: boolean;
  reducedMotion: boolean;
  songId: string | null;
  playerState: string;
  captureMethod: string;
  assertions: Record<string, unknown>;
}

interface Manifest {
  schemaVersion: number;
  capturedAtUtc: string;
  gitCommit: string;
  gitTree: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  webview2Version: string;
  monitorId: string;
  visualBinaryPath: string;
  visualBinarySha256: string;
  visualBuildKind: string;
  provider: string;
  fixtureSongId: string;
  interactionSequence: {
    id: 'S01-interactions';
    actions: string[];
    stateSeqStart: number;
    stateSeqEnd: number;
  };
  releaseArtifact: null | Record<string, unknown>;
  cases: EvidenceCase[];
  releasePass?: boolean;
}

interface EvidenceDraft {
  manifest: Manifest;
  states: StateRow[];
  checklist: string;
  commands: string;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pngHeader(width: number, height: number, tag: string): Buffer {
  const header = Buffer.alloc(48);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  header[25] = 6;
  Buffer.from(tag).copy(header, 32, 0, 16);
  return header;
}

function logicalBounds(width: number, height: number, fullscreen = false): Bounds {
  return fullscreen
    ? { x: 0, y: 0, width: 1920, height: 1080, unit: 'logical-px' }
    : { x: 40, y: 24, width, height, unit: 'logical-px' };
}

function physicalBounds(bounds: Bounds, dpr: number): Bounds {
  return {
    x: Math.round(bounds.x * dpr),
    y: Math.round(bounds.y * dpr),
    width: Math.round(bounds.width * dpr),
    height: Math.round(bounds.height * dpr),
    unit: 'physical-px',
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findCase(draft: EvidenceDraft, id: string): EvidenceCase {
  const evidenceCase = draft.manifest.cases.find((candidate) => candidate.id === id);
  if (!evidenceCase) throw new Error(`missing test case ${id}`);
  return evidenceCase;
}

function findCapture(draft: EvidenceDraft, id: string): StateRow {
  const row = draft.states.find(
    (candidate) => candidate.caseId === id && candidate.action === 'capture',
  );
  if (!row) throw new Error(`missing capture row ${id}`);
  return row;
}

describe('Windows lyrics evidence verifier', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yaqmc-lyrics-evidence-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  function writeEvidence(mutate?: (draft: EvidenceDraft) => void): EvidenceDraft {
    const screenshots = join(root, 'screenshots');
    mkdirSync(screenshots, { recursive: true });
    const binaryPath = join(root, 'visual-binary.exe');
    const binary = Buffer.from('YAQMC visual test binary');
    writeFileSync(binaryPath, binary);

    let seq = 1;
    const states: StateRow[] = [];
    const cases: EvidenceCase[] = [];
    for (const [id, row] of [...Object.entries(matrix), ['S01', smoke] as const]) {
      const dpr = 1.25;
      const sourceLogical = logicalBounds(row.width, row.height);
      const captureLogical = logicalBounds(
        row.width,
        row.height,
        row.presentation === 'native-fullscreen',
      );
      const sourcePhysical = physicalBounds(sourceLogical, dpr);
      const capturePhysical = physicalBounds(captureLogical, dpr);
      const screenshot = `screenshots/${id}.png`;
      const screenshotBytes = pngHeader(capturePhysical.width, capturePhysical.height, id);
      writeFileSync(join(root, ...screenshot.split('/')), screenshotBytes);
      const stateSeqStart = seq++;
      states.push({
        seq: stateSeqStart,
        timestampUtc: '2026-08-11T03:00:00.000Z',
        caseId: id,
        action: 'presentation-ready',
        source: 'cdp-semantic-state',
        logicalBounds: clone(sourceLogical),
        physicalBounds: clone(sourcePhysical),
        devicePixelRatio: dpr,
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        reducedMotion: row.reducedMotion,
        songId: 'quiet-light',
        playerState: 'playing',
        captureMethod: 'semantic-cdp',
        assertions: {
          entryPath: row.entryPath,
          provider: 'fake',
          search: '?provider=fake',
        },
      });
      const captureSeq = seq++;
      states.push({
        seq: captureSeq,
        timestampUtc: '2026-08-11T03:00:01.000Z',
        caseId: id,
        action: 'capture',
        source: 'native-hwnd-client',
        logicalBounds: clone(captureLogical),
        physicalBounds: clone(capturePhysical),
        devicePixelRatio: dpr,
        nativeFullscreen: row.presentation === 'native-fullscreen',
        lyricsOpen: true,
        focus: row.presentation === 'focus',
        reducedMotion: row.reducedMotion,
        songId: 'quiet-light',
        playerState: 'playing',
        captureMethod: 'native-hwnd-client',
        assertions: {
          activeWordRafProgressWrites: row.reducedMotion ? 0 : null,
          clientCropMatchesBounds: true,
          exitPath: row.exitPath,
          fixtureSongId: 'quiet-light',
          maxAnimationDurationMs: row.reducedMotion ? 0 : null,
          maxTransitionDurationMs: row.reducedMotion ? 0 : null,
          provider: 'fake',
        },
      });
      const stateSeqEnd = seq++;
      states.push({
        seq: stateSeqEnd,
        timestampUtc: '2026-08-11T03:00:02.000Z',
        caseId: id,
        action: 'restored',
        source: 'native-hwnd-client',
        logicalBounds: clone(sourceLogical),
        physicalBounds: clone(sourcePhysical),
        devicePixelRatio: dpr,
        nativeFullscreen: false,
        lyricsOpen: row.exitPath !== 'lyrics-close',
        focus: false,
        reducedMotion: row.reducedMotion,
        songId: 'quiet-light',
        playerState: 'playing',
        captureMethod: 'native-hwnd-client',
        assertions: {
          exactRestoration: true,
          exitPath: row.exitPath,
          fixtureSongId: 'quiet-light',
          provider: 'fake',
        },
      });
      cases.push({
        id,
        presentation: row.presentation,
        theme: row.theme,
        locale: row.locale,
        backgroundMode: row.backgroundMode,
        entryPath: row.entryPath,
        exitPath: row.exitPath,
        reducedMotion: row.reducedMotion,
        devicePixelRatio: dpr,
        sourceLogicalBounds: clone(sourceLogical),
        sourcePhysicalBounds: clone(sourcePhysical),
        captureLogicalBounds: clone(captureLogical),
        capturePhysicalBounds: clone(capturePhysical),
        restoredLogicalBounds: clone(sourceLogical),
        restoredPhysicalBounds: clone(sourcePhysical),
        screenshot,
        screenshotSha256: sha256(screenshotBytes),
        stateSeqStart,
        stateSeqEnd,
      });
    }

    const interactionStateSeqStart = seq;
    const interactionRows: Array<
      Pick<
        StateRow,
        'action' | 'nativeFullscreen' | 'lyricsOpen' | 'focus' | 'playerState' | 'songId'
      > & { assertions: Record<string, unknown> }
    > = [
      {
        action: 'manual-scroll-unfollow',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { followVisible: true },
      },
      {
        action: 'follow-restored',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { followVisible: false },
      },
      {
        action: 'click-seek',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { activeLineIndex: 4, positionMs: 74_200 },
      },
      {
        action: 'pause',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        playerState: 'paused',
        songId: 'quiet-light',
        assertions: { viaControl: 'playerbar-play' },
      },
      {
        action: 'resume',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { viaControl: 'playerbar-play' },
      },
      {
        action: 'focus-playerbar-sizing',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: true,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: {
          horizontalCoverage: true,
          playerBarWidth: 1000,
          playerBarX: 0,
          stageWidth: 1000,
          stageX: 0,
          viewportWidth: 1000,
        },
      },
      {
        action: 'transport-hidden',
        nativeFullscreen: true,
        lyricsOpen: true,
        focus: true,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { transportDataVisible: false, transportPointerEvents: 'none' },
      },
      {
        action: 'transport-revealed',
        nativeFullscreen: true,
        lyricsOpen: true,
        focus: true,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { transportDataVisible: true, transportPointerEvents: 'auto' },
      },
      {
        action: 'transport-focus-pinned',
        nativeFullscreen: true,
        lyricsOpen: true,
        focus: true,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: {
          remainedVisibleAfterMs: 2600,
          transportDataVisible: true,
          transportFocused: true,
        },
      },
      {
        action: 'fullscreen-track-change',
        nativeFullscreen: true,
        lyricsOpen: true,
        focus: true,
        playerState: 'playing',
        songId: 'night-geometry',
        assertions: { nextSongId: 'night-geometry', previousSongId: 'quiet-light' },
      },
      {
        action: 'fullscreen-track-restored',
        nativeFullscreen: true,
        lyricsOpen: true,
        focus: true,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { nextSongId: 'quiet-light', previousSongId: 'night-geometry' },
      },
      {
        action: 'escape-fullscreen',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: true,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { retainedFocus: true, retainedLyrics: true },
      },
      {
        action: 'escape-focus',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        playerState: 'playing',
        songId: 'quiet-light',
        assertions: { retainedLyrics: true },
      },
      {
        action: 'escape-close',
        nativeFullscreen: false,
        lyricsOpen: false,
        focus: false,
        playerState: 'playing',
        songId: null,
        assertions: { lyricsClosed: true },
      },
      {
        action: 'secondary-lyrics',
        nativeFullscreen: false,
        lyricsOpen: true,
        focus: false,
        playerState: 'playing',
        songId: 'paper-sun',
        assertions: {
          romanizationCount: 2,
          romanizationVisibility: 'show',
          translationCount: 2,
          translationVisibility: 'show',
        },
      },
    ];
    for (const row of interactionRows) {
      const interactionLogical = logicalBounds(
        row.nativeFullscreen ? 1920 : smoke.width,
        row.nativeFullscreen ? 1080 : smoke.height,
      );
      states.push({
        seq: seq++,
        timestampUtc: '2026-08-11T03:00:02.500Z',
        caseId: 'S01-interactions',
        action: row.action,
        source: 'cdp-ui-input-and-viewport',
        logicalBounds: interactionLogical,
        physicalBounds: physicalBounds(interactionLogical, 1.25),
        devicePixelRatio: 1.25,
        nativeFullscreen: row.nativeFullscreen,
        lyricsOpen: row.lyricsOpen,
        focus: row.focus,
        reducedMotion: false,
        songId: row.songId,
        playerState: row.playerState,
        captureMethod: 'semantic-cdp',
        assertions: row.assertions,
      });
    }
    const interactionStateSeqEnd = seq - 1;

    const externalLogical = logicalBounds(1000, 680);
    const externalPhysical = physicalBounds(externalLogical, 1.25);
    states.push({
      seq,
      timestampUtc: '2026-08-11T03:00:03.000Z',
      caseId: 'external-native-api',
      action: 'external-native-api',
      source: 'cdp-native-api',
      logicalBounds: externalLogical,
      physicalBounds: externalPhysical,
      devicePixelRatio: 1.25,
      nativeFullscreen: false,
      lyricsOpen: true,
      focus: false,
      reducedMotion: false,
      songId: 'quiet-light',
      playerState: 'playing',
      captureMethod: 'semantic-cdp',
      assertions: {
        exactRestoration: true,
        nativeFullscreenAfter: false,
        nativeFullscreenBefore: true,
        reconciledFullscreen: false,
        setFullscreenFulfilled: true,
        windowLabel: 'main',
      },
    });

    const gitCommit = 'a'.repeat(40);
    const gitTree = 'b'.repeat(40);
    const manifest: Manifest = {
      schemaVersion: 1,
      capturedAtUtc: '2026-08-11T03:00:02.000Z',
      gitCommit,
      gitTree,
      platform: 'windows',
      osVersion: 'Windows 11 test',
      appVersion: '0.1.0',
      webview2Version: '139.0.0.0',
      monitorId: '\\\\.\\DISPLAY1',
      visualBinaryPath: binaryPath,
      visualBinarySha256: sha256(binary),
      visualBuildKind: 'tauri-no-bundle',
      provider: 'fake',
      fixtureSongId: 'quiet-light',
      interactionSequence: {
        id: 'S01-interactions',
        actions: [...interactionActions],
        stateSeqStart: interactionStateSeqStart,
        stateSeqEnd: interactionStateSeqEnd,
      },
      releaseArtifact: null,
      cases,
    };
    const draft: EvidenceDraft = {
      manifest,
      states,
      checklist: [
        '# YAQMC Windows lyrics acceptance',
        '- checkpoint: local-visual-only',
        '- releasePass: false',
        `- gitCommit: ${gitCommit}`,
        `- gitTree: ${gitTree}`,
        '- provider: fake',
        '- fixtureSongId: quiet-light',
        ...cases.map((evidenceCase) => `- [x] ${evidenceCase.id}`),
        '- [x] S01-interactions',
        '',
      ].join('\n'),
      commands: [
        `git rev-parse HEAD => ${gitCommit}`,
        `git rev-parse HEAD^{tree} => ${gitTree}`,
        ...cases.map((evidenceCase) => `capture ${evidenceCase.id} via native-hwnd-client`),
        ...interactionActions.map((action) => `interaction ${action}: passed`),
        'external-native-api: label main, true -> fulfilled set(false) -> false, reconciled',
        '',
      ].join('\n'),
    };
    mutate?.(draft);

    writeFileSync(join(root, 'checklist.md'), draft.checklist);
    writeFileSync(join(root, 'commands.log'), draft.commands);
    writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(draft.manifest, null, 2)}\n`);
    writeFileSync(
      join(root, 'state.jsonl'),
      `${draft.states.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );

    const rootFiles = ['checklist.md', 'manifest.json', 'commands.log', 'state.jsonl'];
    const screenshotFiles = [...Object.keys(matrix), 'S01'].map((id) => `screenshots/${id}.png`);
    const lines = [...rootFiles, ...screenshotFiles]
      .map((relative) => `${sha256(readFileSync(join(root, ...relative.split('/'))))}  ${relative}`)
      .concat(`${sha256(readFileSync(binaryPath))}  @visual-binary`);
    writeFileSync(join(root, 'sha256.txt'), `${lines.join('\n')}\n`);
    return draft;
  }

  function expectInvalid(mutate: (draft: EvidenceDraft) => void): void {
    writeEvidence(mutate);
    expect(verifyLyricsAcceptance({ platform: 'windows', root })).not.toEqual([]);
  }

  it('accepts the complete immutable local visual fixture', () => {
    writeEvidence();
    expect(verifyLyricsAcceptance({ platform: 'windows', root })).toEqual([]);
  });

  it('rejects missing, reordered, or semantically false interaction evidence', () => {
    expectInvalid((draft) => {
      draft.states = draft.states.filter((row) => row.action !== 'manual-scroll-unfollow');
    });
    expectInvalid((draft) => {
      const sequence = draft.manifest.interactionSequence.actions;
      [sequence[0], sequence[1]] = [sequence[1]!, sequence[0]!];
    });
    expectInvalid((draft) => {
      const row = draft.states.find((candidate) => candidate.action === 'transport-focus-pinned');
      if (!row) throw new Error('missing interaction fixture');
      row.assertions.transportFocused = false;
    });
    expectInvalid((draft) => {
      const row = draft.states.find((candidate) => candidate.action === 'secondary-lyrics');
      if (!row) throw new Error('missing interaction fixture');
      row.assertions.translationCount = 0;
    });
    expectInvalid((draft) => {
      draft.commands = draft.commands.replace(
        'interaction click-seek: passed',
        'interaction click-seek: missing',
      );
    });
  });

  it('ships exact zero-duration reduced-motion CSS for native numeric assertions', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles', 'base.css'), 'utf8');
    const reducedMotion = css.split('@media (prefers-reduced-motion: reduce)')[1] ?? '';
    expect(reducedMotion).toContain('animation-duration: 0ms !important');
    expect(reducedMotion).toContain('transition-duration: 0ms !important');
    expect(reducedMotion).not.toContain('0.01ms');
  });

  it('rejects missing, extra, and duplicate cases', () => {
    expectInvalid((draft) => draft.manifest.cases.pop());
    expectInvalid((draft) =>
      draft.manifest.cases.push({ ...clone(draft.manifest.cases[0]!), id: 'X99' }),
    );
    expectInvalid((draft) => draft.manifest.cases.push(clone(draft.manifest.cases[0]!)));
  });

  it.each([
    ['provider', (draft: EvidenceDraft) => (draft.manifest.provider = 'qqmusic')],
    ['fixture song', (draft: EvidenceDraft) => (draft.manifest.fixtureSongId = 'paper-sun')],
    ['commit', (draft: EvidenceDraft) => (draft.manifest.gitCommit = 'c'.repeat(40))],
    ['tree', (draft: EvidenceDraft) => (draft.manifest.gitTree = 'd'.repeat(40))],
    [
      'release artifact',
      (draft: EvidenceDraft) => (draft.manifest.releaseArtifact = { path: 'x' }),
    ],
    ['release pass field', (draft: EvidenceDraft) => (draft.manifest.releasePass = true)],
  ])('rejects mutated %s identity', (_label, mutate) => expectInvalid(mutate));

  it('rejects a release-pass claim in the checklist', () => {
    expectInvalid((draft) => {
      draft.checklist = draft.checklist.replace('releasePass: false', 'releasePass: passed');
    });
  });

  it('rejects sequence, hash, traversal, private URL, geometry, restoration, and crop mutations', () => {
    expectInvalid((draft) => (draft.states[1]!.seq = draft.states[0]!.seq));

    writeEvidence();
    writeFileSync(join(root, 'screenshots', 'W01.png'), pngHeader(1600, 1000, 'tampered'));
    expect(verifyLyricsAcceptance({ platform: 'windows', root })).not.toEqual([]);

    expectInvalid((draft) => (findCase(draft, 'W01').screenshot = '../W01.png'));
    expectInvalid((draft) => (draft.commands += 'GET https://qpic.y.qq.com/private/token\n'));
    expectInvalid((draft) => (findCase(draft, 'W02').devicePixelRatio = 0));
    expectInvalid((draft) => (findCase(draft, 'W03').sourcePhysicalBounds.width += 2));
    expectInvalid((draft) => (findCase(draft, 'W03').restoredLogicalBounds.x += 1));
    expectInvalid((draft) => (findCase(draft, 'W03').restoredPhysicalBounds.y += 1));
    expectInvalid((draft) => (findCase(draft, 'W03').capturePhysicalBounds.width += 2));
    expectInvalid((draft) => (findCapture(draft, 'W03').captureMethod = 'cdp-page'));
    expectInvalid((draft) => (findCapture(draft, 'W03').source = 'cdp-screenshot'));
    expectInvalid((draft) => {
      findCapture(draft, 'W03').assertions.clientCropMatchesBounds = false;
    });

    writeEvidence();
    writeFileSync(join(root, 'screenshots', 'extra.png'), pngHeader(1, 1, 'extra'));
    expect(verifyLyricsAcceptance({ platform: 'windows', root })).not.toEqual([]);

    writeEvidence();
    unlinkSync(join(root, 'screenshots', 'W09.png'));
    expect(() => verifyLyricsAcceptance({ platform: 'windows', root })).not.toThrow();
    expect(verifyLyricsAcceptance({ platform: 'windows', root })).not.toEqual([]);
  });

  it('collects malformed bounds errors instead of aborting verification', () => {
    writeEvidence((draft) => {
      delete (findCase(draft, 'W01') as unknown as Record<string, unknown>).capturePhysicalBounds;
    });
    expect(() => verifyLyricsAcceptance({ platform: 'windows', root })).not.toThrow();
    expect(verifyLyricsAcceptance({ platform: 'windows', root })).not.toEqual([]);
  });

  describe.each(Object.entries(matrix))('%s immutable tuple', (id, expected) => {
    const mutations: Array<[string, (evidenceCase: EvidenceCase) => void]> = [
      ['source geometry', (evidenceCase) => (evidenceCase.sourceLogicalBounds.width += 1)],
      [
        'presentation',
        (evidenceCase) =>
          (evidenceCase.presentation = expected.presentation === 'normal' ? 'focus' : 'normal'),
      ],
      [
        'theme',
        (evidenceCase) => (evidenceCase.theme = expected.theme === 'dark' ? 'light' : 'dark'),
      ],
      [
        'locale',
        (evidenceCase) => (evidenceCase.locale = expected.locale === 'en-US' ? 'zh-CN' : 'en-US'),
      ],
      [
        'background',
        (evidenceCase) =>
          (evidenceCase.backgroundMode =
            expected.backgroundMode === 'default' ? 'artwork' : 'default'),
      ],
      ['entry path', (evidenceCase) => (evidenceCase.entryPath = 'mutated-entry')],
      ['exit path', (evidenceCase) => (evidenceCase.exitPath = 'mutated-exit')],
      ['reduced motion', (evidenceCase) => (evidenceCase.reducedMotion = !expected.reducedMotion)],
    ];

    it.each(mutations)('rejects a changed %s', (_field, mutate) => {
      expectInvalid((draft) => mutate(findCase(draft, id)));
    });
  });

  it.each([
    ['W01', 'W02'],
    ['W02', 'W03'],
    ['W04', 'W05'],
    ['W06', 'W07'],
    ['W08', 'W09'],
  ])('rejects complete case swaps between %s and %s', (leftId, rightId) => {
    expectInvalid((draft) => {
      const leftIndex = draft.manifest.cases.findIndex(({ id }) => id === leftId);
      const rightIndex = draft.manifest.cases.findIndex(({ id }) => id === rightId);
      const left = clone(draft.manifest.cases[leftIndex]!);
      const right = clone(draft.manifest.cases[rightIndex]!);
      draft.manifest.cases[leftIndex] = { ...right, id: leftId };
      draft.manifest.cases[rightIndex] = { ...left, id: rightId };
    });
  });

  it('rejects screenshot name/hash swaps even when each pair remains internally consistent', () => {
    expectInvalid((draft) => {
      const left = findCase(draft, 'W01');
      const right = findCase(draft, 'W02');
      [left.screenshot, right.screenshot] = [right.screenshot, left.screenshot];
      [left.screenshotSha256, right.screenshotSha256] = [
        right.screenshotSha256,
        left.screenshotSha256,
      ];
    });
  });

  it.each([
    ['W04', 'W01'],
    ['W06', 'W03'],
    ['W08', 'W09'],
  ])('rejects moving reduced motion from %s to %s', (reducedId, replacementId) => {
    expectInvalid((draft) => {
      findCase(draft, reducedId).reducedMotion = false;
      findCase(draft, replacementId).reducedMotion = true;
    });
  });

  it.each(['W04', 'W06', 'W08'])('requires exact zero motion assertions for %s', (id) => {
    for (const field of [
      'maxTransitionDurationMs',
      'maxAnimationDurationMs',
      'activeWordRafProgressWrites',
    ]) {
      expectInvalid((draft) => {
        findCapture(draft, id).assertions[field] = 1;
      });
    }
  });

  it.each([
    ['windowLabel', 'lyrics'],
    ['nativeFullscreenBefore', false],
    ['setFullscreenFulfilled', false],
    ['nativeFullscreenAfter', true],
    ['reconciledFullscreen', true],
    ['exactRestoration', false],
  ])('rejects a mutated external native assertion %s', (field, value) => {
    expectInvalid((draft) => {
      const probe = draft.states.find((row) => row.caseId === 'external-native-api');
      if (!probe) throw new Error('external probe fixture is missing');
      probe.assertions[field] = value;
    });
  });

  it('rejects missing or duplicated external probe provenance', () => {
    expectInvalid((draft) => {
      draft.states = draft.states.filter((row) => row.caseId !== 'external-native-api');
    });
    expectInvalid((draft) => {
      const probe = draft.states.find((row) => row.caseId === 'external-native-api');
      if (!probe) throw new Error('external probe fixture is missing');
      draft.states.push({ ...clone(probe), seq: probe.seq + 1 });
    });
    expectInvalid((draft) => {
      draft.commands = draft.commands.replace(
        'external-native-api:',
        'external-native-api-missing:',
      );
    });
  });
});
