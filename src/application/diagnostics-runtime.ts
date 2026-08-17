import { useCallback, useEffect, useState } from 'react';
import type { DiagnosticsHostPayload } from '@yaqmc/client';
import { isNativeRuntime } from './native-player-runtime';
import type { LogLevel } from './logger';
import type { PlatformDiagnostics } from './platform-integration';
import { getYaqmcClient } from './yaqmc-runtime';

const client = getYaqmcClient();

/**
 * Frontend bindings for the Rust `diagnostics_*` and `issue_reporter_*` commands.
 *
 * Everything in this module talks to the native runtime through YaqmcClient and
 * degrades gracefully when the app runs inside the Vite browser preview
 * (isNativeRuntime === false).
 */

export interface DiagnosticsRequest {
  accountState?: string;
  membershipTier?: string;
  membershipStatus?: string;
  lyricsPreset?: LyricsPresetDiagnostics;
}

export interface LyricsPresetDiagnostics {
  id: string;
  kind: 'built-in' | 'custom' | 'plugin';
  schemaVersion: number;
  rendererVersion?: number;
}

export interface AppSection {
  name: string;
  version: string;
  commit: string | null;
  channel: string;
  buildType: string;
}

export interface ProviderSection {
  id: string;
  connection: string;
  accountState: string;
  membershipTier: string | null;
  membershipStatus: string | null;
}

export interface PlaybackSection {
  state: 'playing' | 'paused' | 'idle';
  selectedQuality: string | null;
  decoderHint: string | null;
  queueLength: number;
  currentSourceKind: string | null;
  playbackOrder: string;
  repeatMode: string;
  primaryPlaybackMode: string;
  playbackSessionId?: number;
  snapshotRevision?: number;
  sourceGeneration?: number;
  lastSeekRevision?: number;
}

export interface ErrorRecord {
  code: string;
  domain: string;
  message: string;
  opId: string | null;
  capturedAtUnixMs: number;
}

export interface DiagnosticsSnapshot {
  schemaVersion: number;
  sessionId: string;
  generatedAtUnixMs: number;
  app: AppSection;
  platform: PlatformDiagnostics;
  provider: ProviderSection | null;
  playback: PlaybackSection;
  logLevel: LogLevel;
  recentErrors: ErrorRecord[];
  lyricsPreset?: LyricsPresetDiagnostics | null;
  plugins?: PluginDiagnostic[];
}

export interface PluginDiagnostic {
  id: string;
  version: string;
  enabled: boolean;
  status: string;
  entrypointKinds: string[];
  apiVersion: number;
  packageSha256: string;
  permissions: string[];
  riskRating: string;
}

export interface RedactionReport {
  scannerVersion: number;
  filesScanned: number;
  valuesRedacted: number;
  unresolvedPatterns: string[];
}

export interface BundleManifest {
  schemaVersion: number;
  scannerVersion: number;
  appName: string;
  appVersion: string;
  platform: string;
  architecture: string;
  generatedAtUnixMs: number;
  sessionId: string;
  logFiles: string[];
  includeSnapshot: boolean;
  includeLogs: boolean;
}

export interface BundleExportResult {
  path: string;
  bytes: number;
  sha256: string;
  redaction: RedactionReport;
  warnings: string[];
  manifest: BundleManifest;
}

export interface BundleExportOptions extends DiagnosticsRequest {
  includeLogs?: boolean;
  overrideUnresolved?: boolean;
  description?: string;
  issueCategory?: string;
  hostPayload?: DiagnosticsHostPayload;
}

const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as string[]).includes(value);
}

export async function readDiagnosticsSnapshot(
  request: DiagnosticsRequest = {},
): Promise<DiagnosticsSnapshot | null> {
  if (!isNativeRuntime) return null;
  return client.invoke('diagnostics_snapshot', { request }) as Promise<DiagnosticsSnapshot>;
}

export const DIAGNOSTICS_ZIP_DEFAULT_NAME = 'YAQMC-diagnostics.zip';

export class DiagnosticsExportAbortedError extends Error {
  constructor(message = 'Diagnostics export was cancelled') {
    super(message);
    this.name = 'DiagnosticsExportAbortedError';
  }
}

export async function exportDiagnosticsBundle(
  options: BundleExportOptions,
  destPath?: string,
): Promise<BundleExportResult> {
  const { includeLogs, overrideUnresolved, description, issueCategory, ...base } = options;
  const request = {
    includeLogs: includeLogs ?? true,
    overrideUnresolved: overrideUnresolved ?? false,
    description,
    issueCategory,
    ...base,
  };
  if (destPath) {
    return client.invoke('diagnostics_export_bundle_to', { path: destPath, request });
  }
  if (client.bridge.kind === 'electron') {
    const chosen = await client.bridge.dialog?.pickSave({
      defaultPath: DIAGNOSTICS_ZIP_DEFAULT_NAME,
    });
    if (chosen == null) {
      throw new DiagnosticsExportAbortedError();
    }
    return client.invoke('diagnostics_export_bundle_to', { path: chosen, request });
  }
  return client.invoke('diagnostics_export_bundle', { request });
}

export async function revealDiagnosticBundle(path: string): Promise<void> {
  if (!isNativeRuntime) return;
  await client.invoke('diagnostics_reveal_bundle', { path });
}

export async function openLogFolder(): Promise<string> {
  return client.invoke('diagnostics_open_log_folder');
}

export async function clearOldLogs(): Promise<number> {
  return client.invoke('diagnostics_clear_logs');
}

export async function currentLogLevel(): Promise<LogLevel> {
  return client.invoke('diagnostics_current_level');
}

export async function setLogLevel(level: LogLevel): Promise<LogLevel> {
  return client.invoke('diagnostics_set_log_level', { level });
}

export async function readRecentErrors(): Promise<ErrorRecord[]> {
  return client.invoke('diagnostics_recent_errors');
}

export function useDiagnosticsSnapshot(request: DiagnosticsRequest = {}) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestJson = JSON.stringify(request);
  const refresh = useCallback(async () => {
    if (!isNativeRuntime) return null;
    try {
      const parsed = JSON.parse(requestJson) as DiagnosticsRequest;
      const next = await readDiagnosticsSnapshot(parsed);
      setSnapshot(next);
      setError(null);
      return next;
    } catch (caught) {
      setError(String(caught));
      return null;
    }
  }, [requestJson]);
  useEffect(() => {
    if (!isNativeRuntime) return undefined;
    let active = true;
    const parsed = JSON.parse(requestJson) as DiagnosticsRequest;
    readDiagnosticsSnapshot(parsed)
      .then((value) => {
        if (active) {
          setSnapshot(value);
          setError(null);
        }
      })
      .catch((caught) => {
        if (active) setError(String(caught));
      });
    return () => {
      active = false;
    };
  }, [requestJson]);
  return { snapshot, error, refresh };
}
