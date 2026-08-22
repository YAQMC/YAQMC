import { logger } from './logger';
import { isNativeRuntime } from './native-player-runtime';
import type { DiagnosticsRequest } from './diagnostics-runtime';
import { getYaqmcClient } from './yaqmc-runtime';

/**
 * TypeScript surface for the pure Rust issue-reporter core. The frontend never
 * assembles GitHub URLs directly: it always asks the native runtime for a
 * validated preview and then hands the returned URL back through the scoped
 * `host.shell.openExternal` capability. This preserves the invariant that only
 * URLs matching the YAQMC issue prefix ever escape into the default browser.
 */

export type IssueCategory = 'bug' | 'linux' | 'playback' | 'provider' | 'lyrics' | 'ui' | 'other';

export const ISSUE_CATEGORIES: IssueCategory[] = [
  'bug',
  'linux',
  'playback',
  'provider',
  'lyrics',
  'ui',
  'other',
];

export interface IssueDraft {
  category: IssueCategory;
  summary: string;
  description: string;
  bundleFileName?: string;
  linkedErrorCode?: string;
  linkedOpId?: string;
}

export interface IssuePreview {
  title: string;
  body: string;
  url: string;
  tooLongForBrowser: boolean;
  includedFields: string[];
  template: string;
}

export async function previewIssue(
  draft: IssueDraft,
  request: DiagnosticsRequest = {},
): Promise<IssuePreview> {
  return getYaqmcClient().invoke('issue_reporter_preview', { draft, request });
}

export async function validateIssueUrl(url: string): Promise<void> {
  await getYaqmcClient().invoke('issue_reporter_validate_url', { url });
}

export async function openIssueUrl(url: string): Promise<void> {
  await validateIssueUrl(url);
  logger.info('issue.report', 'opening prefilled issue url', { length: url.length });
  if (!isNativeRuntime) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  // Electron Main's allowlist (`apps/desktop/main/open-external.ts`) restricts
  // openExternal to approved HTTPS destinations; Core's `validate_open_url`
  // applies the narrower GitHub Issue prefix for this workflow.
  await getYaqmcClient().host.shell.openExternal(url);
}

export async function copyIssueText(preview: IssuePreview): Promise<void> {
  const text = `${preview.title}\n\n${preview.body}`;
  try {
    await navigator.clipboard.writeText(text);
    logger.info('issue.report', 'issue text copied to clipboard', {
      titleLength: preview.title.length,
      bodyLength: preview.body.length,
    });
  } catch (error) {
    logger.error('issue.report', 'clipboard write failed', { error: String(error) });
    throw error;
  }
}

export function categoryLabelKey(category: IssueCategory): string {
  return `issueReporter.categories.${category}`;
}
