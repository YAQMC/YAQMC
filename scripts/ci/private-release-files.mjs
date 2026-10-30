// Private review records are never part of a public source or binary release.
export function isPrivateReleaseFile(file) {
  const normalized = file.replaceAll('\\', '/');
  return (
    /(^|\/)(audit-reports|\.agent-briefs|output)\//iu.test(normalized) ||
    /(^|\/)PROVENANCE\.md$/iu.test(normalized) ||
    /^(?:AUDIT_REPORT.*|audit-report.*|.*-report)\.md$/iu.test(normalized) ||
    normalized === 'docs/migration/provenance-audit.md' ||
    (normalized.startsWith('docs/release/') &&
      !['docs/release/README.md', 'docs/release/licensing-consent-record.json'].includes(
        normalized,
      )) ||
    [
      'artifacts/perf-baseline.md',
      'artifacts/soak-last.json',
      'artifacts/acc03-windows-last.json',
    ].includes(normalized)
  );
}
