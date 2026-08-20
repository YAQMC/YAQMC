use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RiskSeverity {
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannerFinding {
    pub severity: RiskSeverity,
    pub kind: String,
    pub count: usize,
    pub detail: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub severity: Option<RiskSeverity>,
    pub findings: Vec<ScannerFinding>,
}

impl ScanReport {
    pub fn rating(&self) -> &'static str {
        match self.severity {
            Some(RiskSeverity::High) => "high",
            Some(RiskSeverity::Medium) => "medium",
            Some(RiskSeverity::Low) => "low",
            None => "none",
        }
    }
}

pub fn scan_css(source: &str) -> ScanReport {
    let mut findings = Vec::new();
    let import_count = count_matches(source, "@import");
    if import_count > 0 {
        findings.push(finding(
            RiskSeverity::High,
            "css-import",
            import_count,
            "Remote or extra @import rules are blocked in v1.",
        ));
    }
    let remote_urls = count_regexish(
        source,
        &["url(http://", "url(https://", "url(\"http", "url('http"],
    );
    if remote_urls > 0 {
        findings.push(finding(
            RiskSeverity::High,
            "css-remote-url",
            remote_urls,
            "Remote url() references are not allowed in v1.",
        ));
    }
    if source.contains("url(file:") || source.contains("url(\"file:") {
        findings.push(finding(
            RiskSeverity::High,
            "css-file-url",
            1,
            "Local filesystem urls are not allowed.",
        ));
    }
    ScanReport {
        severity: max_severity(&findings),
        findings,
    }
}

pub fn scan_script(source: &str) -> ScanReport {
    let mut findings = Vec::new();
    bump(
        &mut findings,
        source,
        &[
            "fetch(",
            "XMLHttpRequest",
            "WebSocket",
            "EventSource",
            "sendBeacon",
        ],
        RiskSeverity::High,
        "network-api",
        "Network APIs are denied in v1.",
    );
    bump(
        &mut findings,
        source,
        &["eval(", "new Function", "import(", "importScripts("],
        RiskSeverity::High,
        "dynamic-code",
        "Dynamic code execution is denied.",
    );
    let legacy_host_global = ["__", "TA", "URI__"].concat();
    let legacy_host_internals = ["window.__", "TA", "URI_INTERNALS__"].concat();
    bump(
        &mut findings,
        source,
        &[
            legacy_host_global.as_str(),
            "invoke(",
            legacy_host_internals.as_str(),
        ],
        RiskSeverity::High,
        "legacy-host-api",
        "Legacy host command access is not part of the Plugin API.",
    );
    bump(
        &mut findings,
        source,
        &[
            "document.querySelector",
            "window.open",
            "location.",
            "navigator.clipboard",
        ],
        RiskSeverity::High,
        "privileged-dom",
        "Main-document and navigation APIs are not provided to plugins.",
    );
    let obfuscation = count_regexish(source, &["String.fromCharCode", "atob(", "fromCharCode"]);
    if obfuscation >= 3 || source.contains("data:application/wasm") {
        findings.push(finding(
            RiskSeverity::Medium,
            "obfuscation",
            obfuscation.max(1),
            "Obfuscation indicators were found. This is not a proof of malice.",
        ));
    }
    ScanReport {
        severity: max_severity(&findings),
        findings,
    }
}

pub fn css_is_blocked(report: &ScanReport) -> bool {
    report
        .findings
        .iter()
        .any(|finding| matches!(finding.severity, RiskSeverity::High))
}

fn bump(
    findings: &mut Vec<ScannerFinding>,
    source: &str,
    needles: &[&str],
    severity: RiskSeverity,
    kind: &str,
    detail: &str,
) {
    let count = needles
        .iter()
        .map(|needle| count_matches(source, needle))
        .sum();
    if count > 0 {
        findings.push(finding(severity, kind, count, detail));
    }
}

fn finding(severity: RiskSeverity, kind: &str, count: usize, detail: &str) -> ScannerFinding {
    ScannerFinding {
        severity,
        kind: kind.to_owned(),
        count,
        detail: detail.to_owned(),
    }
}

fn count_matches(source: &str, needle: &str) -> usize {
    source.matches(needle).count()
}

fn count_regexish(source: &str, needles: &[&str]) -> usize {
    needles
        .iter()
        .map(|needle| count_matches(source, needle))
        .sum()
}

fn max_severity(findings: &[ScannerFinding]) -> Option<RiskSeverity> {
    findings.iter().map(|finding| finding.severity).max()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_remote_import_is_high_risk() {
        let report = scan_css("@import url(\"https://evil.example/x.css\");");
        assert_eq!(report.severity, Some(RiskSeverity::High));
        assert!(css_is_blocked(&report));
    }

    #[test]
    fn script_legacy_host_and_fetch_are_high_risk() {
        let source = [
            "fetch('/x'); window.__",
            "TA",
            "URI__.invoke('player_seek')",
        ]
        .concat();
        let report = scan_script(&source);
        assert_eq!(report.severity, Some(RiskSeverity::High));
        assert!(report
            .findings
            .iter()
            .any(|finding| finding.kind == "legacy-host-api"));
    }
}
