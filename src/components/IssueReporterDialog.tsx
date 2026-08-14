import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardCopy, ExternalLink, X } from 'lucide-react';
import {
  copyIssueText,
  ISSUE_CATEGORIES,
  openIssueUrl,
  previewIssue,
  type IssueCategory,
  type IssueDraft,
  type IssuePreview,
} from '../application/issue-reporter';
import {
  exportDiagnosticsBundle,
  revealDiagnosticBundle,
  type BundleExportResult,
  type DiagnosticsRequest,
} from '../application/diagnostics-runtime';
import { logger } from '../application/logger';
import { isNativeRuntime } from '../application/native-player-runtime';

interface Props {
  open: boolean;
  onClose: () => void;
  initialCategory?: IssueCategory;
  initialSummary?: string;
  initialDescription?: string;
  linkedError?: { code: string; opId?: string };
  diagnosticsRequest?: DiagnosticsRequest;
}

/**
 * Issue Reporter dialog. Presents a category picker, summary/description inputs,
 * a live preview of the generated GitHub issue body, and separate actions for
 * generating the diagnostic bundle, copying the issue text, and launching the
 * scoped browser opener with the prefilled URL.
 *
 * YAQMC never auto-submits: the browser always opens the GitHub Issue form and
 * the user is responsible for the final Submit button.
 */
export function IssueReporterDialog({
  open,
  onClose,
  initialCategory = 'bug',
  initialSummary = '',
  initialDescription = '',
  linkedError,
  diagnosticsRequest,
}: Props) {
  const { t } = useTranslation('settings');
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [category, setCategory] = useState<IssueCategory>(initialCategory);
  const [summary, setSummary] = useState(initialSummary);
  const [description, setDescription] = useState(initialDescription);
  const [includeBundle, setIncludeBundle] = useState(true);
  const [preview, setPreview] = useState<IssuePreview | null>(null);
  const [bundle, setBundle] = useState<BundleExportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const draft = useMemo<IssueDraft>(
    () => ({
      category,
      summary,
      description,
      bundleFileName: bundle?.path.split(/[\\/]/).pop(),
      linkedErrorCode: linkedError?.code,
      linkedOpId: linkedError?.opId,
    }),
    [category, summary, description, bundle?.path, linkedError?.code, linkedError?.opId],
  );

  // Sync dialog visibility with browser dialog element.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open && !node.open) {
      try {
        node.showModal();
      } catch {
        node.setAttribute('open', '');
      }
    }
    if (!open && node.open) {
      node.close();
    }
  }, [open]);

  const browserPreview = useMemo<IssuePreview | null>(() => {
    if (isNativeRuntime || !open) return null;
    return {
      title: `[${category}] ${summary || 'issue'}`,
      body: `**Summary**\n\n${summary}\n\n**Steps / Details**\n\n${description}\n\nBrowser preview mode — the native runtime is required to compose an issue URL.`,
      url: 'https://github.com/YAQMC/YAQMC/issues/new',
      tooLongForBrowser: false,
      includedFields: ['title'],
      template: 'bug-report.yml',
    };
  }, [category, summary, description, open]);

  // Live preview refresh once inputs settle (native runtime only).
  useEffect(() => {
    if (!open || !isNativeRuntime) return undefined;
    let cancelled = false;
    const handle = setTimeout(() => {
      previewIssue(draft, diagnosticsRequest ?? {})
        .then((next) => {
          if (cancelled) return;
          setPreview(next);
          setError(null);
        })
        .catch((caught) => {
          if (cancelled) return;
          const message = String(caught);
          setError(message);
          logger.warn('issue.report', 'preview failed', { error: message });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, draft, diagnosticsRequest]);

  const effectivePreview = preview ?? browserPreview;

  const handleGenerateBundle = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await exportDiagnosticsBundle({
        ...(diagnosticsRequest ?? {}),
        includeLogs: true,
        overrideUnresolved: false,
        description: description || summary,
        issueCategory: category,
      });
      setBundle(result);
      const name = result.path.split(/[\\/]/).pop() ?? result.path;
      setStatus(t('issueReporter.bundleReady', { name }));
      logger.info('issue.bundle', 'bundle exported', {
        bytes: result.bytes,
        redactedValues: result.redaction.valuesRedacted,
      });
    } catch (caught) {
      const message = String(caught);
      setError(message);
      logger.warn('issue.bundle', 'bundle export failed', { error: message });
    } finally {
      setBusy(false);
    }
  }, [category, description, diagnosticsRequest, summary, t]);

  const handleRevealBundle = useCallback(async () => {
    if (!bundle) return;
    try {
      await revealDiagnosticBundle(bundle.path);
    } catch (caught) {
      const message = String(caught);
      setError(message);
      logger.warn('issue.bundle', 'reveal failed', { error: message });
    }
  }, [bundle]);

  const handleCopy = useCallback(async () => {
    if (!effectivePreview) return;
    try {
      await copyIssueText(effectivePreview);
      setStatus(t('issueReporter.copied'));
    } catch (caught) {
      setError(String(caught));
    }
  }, [effectivePreview, t]);

  const handleOpen = useCallback(async () => {
    if (!effectivePreview) return;
    if (effectivePreview.tooLongForBrowser) {
      setError(t('issueReporter.urlTooLong'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (includeBundle && !bundle) {
        await handleGenerateBundle();
      }
      await openIssueUrl(effectivePreview.url);
      if (bundle) {
        try {
          await revealDiagnosticBundle(bundle.path);
        } catch (caught) {
          logger.warn('issue.bundle', 'reveal after open failed', { error: String(caught) });
        }
      }
      setStatus(t('issueReporter.opened'));
    } catch (caught) {
      const message = String(caught);
      setError(message);
      logger.warn('issue.report', 'browser open failed', { error: message });
    } finally {
      setBusy(false);
    }
  }, [effectivePreview, bundle, includeBundle, handleGenerateBundle, t]);

  return (
    <dialog
      ref={dialogRef}
      className="issue-reporter-dialog"
      aria-label={t('issueReporter.title')}
      onClose={onClose}
    >
      <div className="issue-reporter-dialog__body">
        <header className="issue-reporter-dialog__header">
          <h2>{t('issueReporter.title')}</h2>
          <button
            type="button"
            className="button button--quiet"
            onClick={onClose}
            aria-label={t('issueReporter.close')}
          >
            <X size={16} />
          </button>
        </header>
        <p className="issue-reporter-dialog__intro">{t('issueReporter.intro')}</p>
        <div className="issue-reporter-dialog__field">
          <label htmlFor="issue-reporter-category">{t('issueReporter.category')}</label>
          <select
            id="issue-reporter-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as IssueCategory)}
            disabled={busy}
          >
            {ISSUE_CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {t(`issueReporter.categories.${option}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="issue-reporter-dialog__field">
          <label htmlFor="issue-reporter-summary">{t('issueReporter.summary')}</label>
          <input
            id="issue-reporter-summary"
            type="text"
            value={summary}
            maxLength={200}
            onChange={(event) => setSummary(event.target.value)}
            placeholder={t('issueReporter.summaryPlaceholder')}
            disabled={busy}
          />
        </div>
        <div className="issue-reporter-dialog__field">
          <label htmlFor="issue-reporter-description">{t('issueReporter.description')}</label>
          <textarea
            id="issue-reporter-description"
            value={description}
            rows={6}
            maxLength={4_000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('issueReporter.descriptionPlaceholder')}
            disabled={busy}
          />
        </div>
        <label className="issue-reporter-dialog__toggle">
          <input
            type="checkbox"
            checked={includeBundle}
            onChange={(event) => setIncludeBundle(event.target.checked)}
            disabled={busy}
          />
          <span>{t('issueReporter.includeBundle')}</span>
        </label>
        {effectivePreview && (
          <div className="issue-reporter-dialog__preview" aria-live="polite">
            <h3>{t('issueReporter.preview')}</h3>
            <div className="issue-reporter-dialog__preview-meta">
              <strong>{effectivePreview.title}</strong>
              <small>{t('issueReporter.template', { name: effectivePreview.template })}</small>
              {effectivePreview.tooLongForBrowser && (
                <span className="issue-reporter-dialog__warning">
                  <AlertTriangle size={14} /> {t('issueReporter.urlTooLong')}
                </span>
              )}
            </div>
            <pre className="issue-reporter-dialog__body-text">{effectivePreview.body}</pre>
          </div>
        )}
        {bundle && (
          <div className="issue-reporter-dialog__bundle">
            <p>
              <strong>{bundle.path}</strong>
            </p>
            <ul>
              <li>{t('issueReporter.bundleBytes', { bytes: formatBytes(bundle.bytes) })}</li>
              <li>
                {t('issueReporter.bundleRedacted', {
                  count: bundle.redaction.valuesRedacted,
                })}
              </li>
              <li>SHA-256: {bundle.sha256.slice(0, 16)}…</li>
            </ul>
            <p className="issue-reporter-dialog__hint">{t('issueReporter.bundleHint')}</p>
          </div>
        )}
        {error && (
          <p className="issue-reporter-dialog__error" role="alert">
            <AlertTriangle size={14} /> {error}
          </p>
        )}
        {status && !error && (
          <p className="issue-reporter-dialog__status" role="status">
            {status}
          </p>
        )}
        <footer className="issue-reporter-dialog__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void handleGenerateBundle()}
            disabled={busy || !isNativeRuntime}
          >
            {t('issueReporter.generateBundle')}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void handleRevealBundle()}
            disabled={busy || !bundle}
          >
            {t('issueReporter.revealBundle')}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void handleCopy()}
            disabled={busy || !effectivePreview}
          >
            <ClipboardCopy size={14} /> {t('issueReporter.copy')}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void handleOpen()}
            disabled={busy || !effectivePreview}
          >
            <ExternalLink size={14} /> {t('issueReporter.open')}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(2)} MiB`;
}
