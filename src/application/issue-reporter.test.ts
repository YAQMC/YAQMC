import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@yaqmc/client';

const invokeMock = vi.hoisted(() => vi.fn());
const openExternalMock = vi.hoisted(() => vi.fn());

vi.mock('./yaqmc-runtime', async () => {
  const { YaqmcClient } = await import('@yaqmc/client');
  const bridge = {
    kind: 'electron' as const,
    windowRole: 'main' as const,
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      setFullscreen: async () => undefined,
    },
    shell: {
      openExternal: openExternalMock,
    },
    invoke: invokeMock,
    listen: () => () => undefined,
  };
  const client = new YaqmcClient(bridge as HostBridge);
  client.markReady();
  return {
    getHostBridge: () => bridge,
    getYaqmcClient: () => client,
  };
});

vi.mock('./native-player-runtime', () => ({
  isNativeRuntime: true,
}));

import {
  categoryLabelKey,
  copyIssueText,
  ISSUE_CATEGORIES,
  openIssueUrl,
  previewIssue,
  validateIssueUrl,
  type IssuePreview,
} from './issue-reporter';

const samplePreview: IssuePreview = {
  title: '[bug] cannot play track',
  body: 'body content',
  url: 'https://github.com/YAQMC/YAQMC/issues/new?title=x',
  tooLongForBrowser: false,
  includedFields: ['title'],
  template: 'bug-report.yml',
};

describe('issue reporter runtime', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openExternalMock.mockReset();
  });

  afterEach(() => {
    invokeMock.mockReset();
    openExternalMock.mockReset();
  });

  it('exposes the seven initial issue categories in stable order', () => {
    expect(ISSUE_CATEGORIES).toEqual([
      'bug',
      'linux',
      'playback',
      'provider',
      'lyrics',
      'ui',
      'other',
    ]);
  });

  it('builds category label keys under the localized namespace', () => {
    expect(categoryLabelKey('linux')).toBe('issueReporter.categories.linux');
  });

  it('forwards preview requests to the native command with draft + request payload', async () => {
    invokeMock.mockResolvedValueOnce(samplePreview);
    const preview = await previewIssue(
      {
        category: 'bug',
        summary: 'headline',
        description: 'body',
      },
      { accountState: 'guest' },
    );
    expect(preview).toEqual(samplePreview);
    expect(invokeMock).toHaveBeenCalledWith(
      'issue_reporter_preview',
      expect.objectContaining({
        draft: expect.objectContaining({ category: 'bug' }),
        request: expect.objectContaining({ accountState: 'guest' }),
      }),
    );
  });

  it('validates URLs before opening and only invokes openExternal on success', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await openIssueUrl(samplePreview.url);
    expect(invokeMock).toHaveBeenCalledWith(
      'issue_reporter_validate_url',
      expect.objectContaining({ url: samplePreview.url }),
    );
    expect(openExternalMock).toHaveBeenCalledWith(samplePreview.url);
  });

  it('propagates validation failures without calling the opener', async () => {
    invokeMock.mockRejectedValueOnce(new Error('rejected origin'));
    await expect(openIssueUrl('https://evil.example/issues/new')).rejects.toThrow(
      /rejected origin/,
    );
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('copies rendered issue text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    await copyIssueText(samplePreview);
    expect(writeText).toHaveBeenCalledWith(`${samplePreview.title}\n\n${samplePreview.body}`);
  });

  it('exposes a validate wrapper that surfaces errors', async () => {
    invokeMock.mockRejectedValueOnce(new Error('not-in-allowlist'));
    await expect(validateIssueUrl('https://example.com')).rejects.toThrow(/not-in-allowlist/);
  });
});
