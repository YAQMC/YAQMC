import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@yaqmc/client';

const invokeMock = vi.hoisted(() => vi.fn());
const openExternalMock = vi.hoisted(() => vi.fn());
const exportBundleMock = vi.hoisted(() => vi.fn());
const revealBundleMock = vi.hoisted(() => vi.fn());

vi.mock('../application/yaqmc-runtime', async () => {
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

vi.mock('../application/native-player-runtime', () => ({
  isNativeRuntime: true,
}));

vi.mock('../application/diagnostics-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    exportDiagnosticsBundle: exportBundleMock,
    revealDiagnosticBundle: revealBundleMock,
  };
});

import '../i18n';
import { DiagnosticsExportAbortedError } from '../application/diagnostics-runtime';
import { logger } from '../application/logger';
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
  path: 'C:\\Users\\demo\\AppData\\Local\\org.yaqmc.desktop\\logs\\YAQMC-diagnostics-20260814-133000.zip',
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
  openExternalMock.mockReset();
  exportBundleMock.mockReset();
  revealBundleMock.mockReset();
  openExternalMock.mockResolvedValue(undefined);
  exportBundleMock.mockResolvedValue(sampleBundle);
  revealBundleMock.mockResolvedValue(undefined);
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
      expect(exportBundleMock).toHaveBeenCalledWith(
        expect.objectContaining({
          includeLogs: true,
          overrideUnresolved: false,
        }),
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
      expect(openExternalMock).toHaveBeenCalledWith(samplePreview.url);
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
    configureDefaultInvokes();
    exportBundleMock.mockRejectedValue(new Error('bundle boom'));
    render(<IssueReporterDialog open onClose={vi.fn()} />);
    const generate = await screen.findByRole('button', { name: /generate bundle|生成诊断/i });
    await act(async () => {
      fireEvent.click(generate);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/bundle boom/);
    });
  });

  it('does not treat a cancelled save dialog as a bundle failure', async () => {
    configureDefaultInvokes();
    const warn = vi.spyOn(logger, 'warn');
    exportBundleMock.mockRejectedValue(new DiagnosticsExportAbortedError());
    render(<IssueReporterDialog open onClose={vi.fn()} />);
    const generate = await screen.findByRole('button', { name: /generate bundle|生成诊断/i });
    await act(async () => {
      fireEvent.click(generate);
    });
    await waitFor(() => {
      expect(exportBundleMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(warn).not.toHaveBeenCalledWith(
      'issue.bundle',
      'bundle export failed',
      expect.anything(),
    );
    warn.mockRestore();
  });
});
