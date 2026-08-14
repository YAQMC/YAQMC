import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import { isNativeRuntime } from './native-player-runtime';
import type { LogLevel } from './logger';
import type { PlatformDiagnostics } from './platform-integration';

/**
 * Frontend bindings for the Rust `diagnostics_*` and `issue_reporter_*` commands.
 *
 * Everything in this module talks to the native runtime through Tauri IPC and
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
  kind: 'built-in' | 'custom';
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
}

const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as string[]).includes(value);
}

export async function readDiagnosticsSnapshot(
  request: DiagnosticsRequest = {},
): Promise<DiagnosticsSnapshot | null> {
  if (!isNativeRuntime) return null;
  return invoke<DiagnosticsSnapshot>('diagnostics_snapshot', { request });
}

export async function exportDiagnosticsBundle(
  options: BundleExportOptions,
): Promise<BundleExportResult> {
  const { includeLogs, overrideUnresolved, description, issueCategory, ...base } = options;
  const request = {
    includeLogs: includeLogs ?? true,
    overrideUnresolved: overrideUnresolved ?? false,
    description,
    issueCategory,
    ...base,
  };
  return invoke<BundleExportResult>('diagnostics_export_bundle', { request });
}

export async function revealDiagnosticBundle(path: string): Promise<void> {
  if (!isNativeRuntime) return;
  await invoke('diagnostics_reveal_bundle', { path });
}

export async function openLogFolder(): Promise<string> {
  return invoke<string>('diagnostics_open_log_folder');
}

export async function clearOldLogs(): Promise<number> {
  return invoke<number>('diagnostics_clear_logs');
}

export async function currentLogLevel(): Promise<LogLevel> {
  return invoke<LogLevel>('diagnostics_current_level');
}

export async function setLogLevel(level: LogLevel): Promise<LogLevel> {
  return invoke<LogLevel>('diagnostics_set_log_level', { level });
}

export async function readRecentErrors(): Promise<ErrorRecord[]> {
  return invoke<ErrorRecord[]>('diagnostics_recent_errors');
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
