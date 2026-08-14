import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../application/native-player-runtime', () => ({
  isNativeRuntime: true,
}));

import '../i18n';
import { IssueReporterDialog } from './IssueReporterDialog';

const samplePreview = {
  title: '[bug] cannot play track',
  body: 'preview body content',
  url: 'https://github.com/YAQMC/YAQMC/issues/new?title=x',
  tooLongForBrowser: false,
  includedFields: ['title'],
  template: 'bug-report.yml',
};

const sampleBundle = {
  path: 'C:\\Users\\demo\\AppData\\Local\\Velune\\YAQMC\\logs\\YAQMC-diagnostics-20260814-133000.zip',
  bytes: 4096,
  sha256: 'a'.repeat(64),
  redaction: {
    scannerVersion: 'v1',
    filesScanned: 3,
    valuesRedacted: 2,
    unresolvedPatterns: [],
  },
  manifestPath: 'manifest.json',
};

// jsdom does not implement showModal.
beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };

  invokeMock.mockReset();
  openUrlMock.mockReset();
  openUrlMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function configureDefaultInvokes() {
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'issue_reporter_preview':
        return samplePreview;
      case 'issue_reporter_validate_url':
        return undefined;
      case 'diagnostics_export_bundle':
        return sampleBundle;
      case 'diagnostics_reveal_bundle':
        return undefined;
      case 'diagnostics_log_frontend':
      case 'diagnostics_record_error':
        return undefined;
      default:
        throw new Error(`unexpected command ${command} args=${JSON.stringify(args)}`);
    }
  });
}

describe('IssueReporterDialog', () => {
  it('renders the seven initial categories and updates the draft when a new one is chosen', async () => {
    configureDefaultInvokes();
    render(<IssueReporterDialog open onClose={vi.fn()} />);
    const select = (await screen.findByLabelText(/category|类别/i)) as HTMLSelectElement;
    expect(select.options).toHaveLength(7);
    fireEvent.change(select, { target: { value: 'linux' } });
    expect(select.value).toBe('linux');
  });

  it('debounces preview requests and shows the returned title/body', async () => {
    configureDefaultInvokes();
    render(<IssueReporterDialog open onClose={vi.fn()} initialSummary="broken audio" />);
    await waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith(
          'issue_reporter_preview',
          expect.objectContaining({
            draft: expect.objectContaining({ summary: 'broken audio' }),
          }),
        );
      },
      { timeout: 2000 },
    );
    expect(await screen.findByText(samplePreview.title)).toBeTruthy();
    expect(screen.getByText(samplePreview.body)).toBeTruthy();
  });

  it('generates a diagnostic bundle when the user clicks the button', async () => {
    configureDefaultInvokes();
    render(<IssueReporterDialog open onClose={vi.fn()} />);
    const generate = await screen.findByRole('button', { name: /generate bundle|生成诊断/i });
    await act(async () => {
      fireEvent.click(generate);
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'diagnostics_export_bundle',
        expect.objectContaining({ request: expect.any(Object) }),
      );
    });
    const matches = await screen.findAllByText(/YAQMC-diagnostics-20260814-133000\.zip/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('copies the rendered issue text to the clipboard', async () => {
    configureDefaultInvokes();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<IssueReporterDialog open onClose={vi.fn()} initialSummary="broken audio" />);
    await screen.findByText(samplePreview.title);
    const copyButton = screen.getByRole('button', { name: /copy issue|复制/i });
    await act(async () => {
      fireEvent.click(copyButton);
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`${samplePreview.title}\n\n${samplePreview.body}`);
    });
  });

  it('validates and opens the prefilled URL through the scoped opener', async () => {
    configureDefaultInvokes();
    render(<IssueReporterDialog open onClose={vi.fn()} initialSummary="broken audio" />);
    await screen.findByText(samplePreview.title);
    // Turn off "include bundle" so the open flow does not first block on the bundle export.
    const toggle = screen.getByRole('checkbox');
    fireEvent.click(toggle);
    const openButton = screen.getByRole('button', { name: /open github|打开 github/i });
    await act(async () => {
      fireEvent.click(openButton);
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'issue_reporter_validate_url',
        expect.objectContaining({ url: samplePreview.url }),
      );
      expect(openUrlMock).toHaveBeenCalledWith(samplePreview.url);
    });
  });

  it('surfaces a preview failure without crashing', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'issue_reporter_preview') {
        throw new Error('preview boom');
      }
      return undefined;
    });
    render(<IssueReporterDialog open onClose={vi.fn()} initialSummary="broken audio" />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/preview boom/);
    });
  });

  it('surfaces a bundle failure without crashing', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'issue_reporter_preview') return samplePreview;
      if (command === 'issue_reporter_validate_url') return undefined;
      if (command === 'diagnostics_export_bundle') throw new Error('bundle boom');
      return undefined;
    });
    render(<IssueReporterDialog open onClose={vi.fn()} />);
    const generate = await screen.findByRole('button', { name: /generate bundle|生成诊断/i });
    await act(async () => {
      fireEvent.click(generate);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/bundle boom/);
    });
  });
});
