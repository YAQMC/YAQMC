import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TauriCore from '@tauri-apps/api/core';

const invokeMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: invokeMock,
  isTauri: () => true,
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: openUrlMock,
}));

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
    openUrlMock.mockReset();
  });

  afterEach(() => {
    invokeMock.mockReset();
    openUrlMock.mockReset();
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

  it('validates URLs before opening and only invokes openUrl on success', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await openIssueUrl(samplePreview.url);
    expect(invokeMock).toHaveBeenCalledWith(
      'issue_reporter_validate_url',
      expect.objectContaining({ url: samplePreview.url }),
    );
    expect(openUrlMock).toHaveBeenCalledWith(samplePreview.url);
  });

  it('propagates validation failures without calling the opener', async () => {
    invokeMock.mockRejectedValueOnce(new Error('rejected origin'));
    await expect(openIssueUrl('https://evil.example/issues/new')).rejects.toThrow(
      /rejected origin/,
    );
    expect(openUrlMock).not.toHaveBeenCalled();
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
