//! Anti-backflow gate: production provider code must not own upstream QQ Music
//! endpoints.
//!
//! Only the YAQMC-side transport boundary and the login/session modules that
//! still run pre-migration OAuth flows may name an upstream business endpoint.
//! Every other module must reach QQ Music through typed `qm-api-rs` calls.
//!
//! Allowed files are frozen with an exact occurrence count. Adding a new
//! endpoint literal fails the gate, and finishing one of the pending migrations
//! also fails the gate until the inventory is updated, so the residue can
//! neither silently grow nor linger unnoticed.

use std::{
    fs,
    path::{Path, PathBuf},
};

/// Upstream endpoint markers. Bare `y.qq.com` is included because a provider
/// module building that origin owns protocol, not just a CDN URL.
const UPSTREAM_MARKERS: &[&str] = &[
    "u.y.qq.com",
    "c.y.qq.com",
    "c6.y.qq.com",
    "api.tencentmusic.com",
    "ssl.ptlogin2",
    "xui.ptlogin2",
    "graph.qq.com",
    "open.weixin.qq.com",
    "musicu.fcg",
    "musics.fcg",
    "fcg_query_lyric",
    "y.qq.com",
];

/// `(relative source path, allowed production occurrences, reason)`.
const ALLOWED_ENDPOINT_OWNERS: &[(&str, usize, &str)] = &[
    (
        "qmapi/transport.rs",
        usize::MAX,
        "YAQMC-side reqwest transport host allowlist and shared musicu endpoint",
    ),
    (
        "qqmusic/auth.rs",
        usize::MAX,
        "QQ/TIM/WeChat login and session flows pending typed auth migration",
    ),
    (
        "qqmusic/oauth.rs",
        usize::MAX,
        "OAuth navigation allowlist pending library-owned authorization policy",
    ),
    (
        "qqmusic/transport.rs",
        usize::MAX,
        "Legacy YAQMC transport boundary still used by the account and auth modules",
    ),
];

fn provider_sources() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect(&root, &mut files);
    files.sort();
    files
        .into_iter()
        // `*_tests.rs` modules are compiled only under `cfg(test)`.
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .is_none_or(|stem| !stem.ends_with("_tests"))
        })
        .map(|path| {
            let relative = path
                .strip_prefix(&root)
                .expect("provider source under src")
                .to_string_lossy()
                .replace('\\', "/");
            let source = fs::read_to_string(&path).expect("provider source readable");
            (relative, source)
        })
        .collect()
}

fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(directory).expect("provider source directory");
    for entry in entries {
        let path = entry.expect("provider source entry").path();
        if path.is_dir() {
            collect(&path, files);
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            files.push(path);
        }
    }
}

fn is_test_gate(trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("#[cfg(") else {
        return false;
    };
    let Some(predicate) = rest.strip_suffix(")]") else {
        return false;
    };
    let predicate = without_string_literals(predicate);
    predicate
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .any(|token| token == "test")
        && !predicate.contains("not(")
}

fn without_string_literals(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(character) = chars.next() {
        if character != '"' {
            stripped.push(character);
            continue;
        }
        let mut escaped = false;
        for inner in chars.by_ref() {
            if escaped {
                escaped = false;
                continue;
            }
            if inner == '\\' {
                escaped = true;
                continue;
            }
            if inner == '"' {
                break;
            }
        }
    }
    stripped
}

/// Removes `#[cfg(test)]`-gated items so only production code is inspected.
fn production_source(source: &str) -> String {
    let mut production = String::with_capacity(source.len());
    let mut cursor = 0usize;
    while cursor < source.len() {
        let end = line_end(source, cursor);
        let line = &source[cursor..end];
        if is_test_gate(line.trim()) {
            cursor = skip_gated_item(source, end);
            continue;
        }
        production.push_str(line);
        cursor = end;
    }
    production
}

fn line_end(source: &str, start: usize) -> usize {
    match source[start..].find('\n') {
        Some(offset) => start + offset + 1,
        None => source.len(),
    }
}

/// Returns the offset just past the item introduced by a `#[cfg(test)]` attribute.
///
/// A gated `mod` item is treated as running to the end of the file. The provider
/// modules keep inline `cfg(test)` helpers next to production code and place the
/// test module last, so the brace matching used for inline blocks cannot be
/// trusted across the whole module; truncating is the conservative choice that
/// cannot hide production code behind a miscount.
fn skip_gated_item(source: &str, start: usize) -> usize {
    let mut cursor = start;
    let mut depth = 0i32;
    let mut opened = false;
    while cursor < source.len() {
        let end = line_end(source, cursor);
        let line = &source[cursor..end];
        let trimmed = line.trim();
        if !opened {
            if trimmed.is_empty()
                || trimmed.starts_with("#[")
                || trimmed.starts_with("//")
                || trimmed.starts_with("/*")
            {
                cursor = end;
                continue;
            }
            if trimmed.starts_with("mod ") {
                return source.len();
            }
            if trimmed.ends_with(';') && !trimmed.contains('{') {
                return end;
            }
        }
        scan_braces(line, &mut depth, &mut opened);
        if opened && depth <= 0 {
            return end;
        }
        cursor = end;
    }
    source.len()
}

/// Brace scanner that ignores braces inside string and char literals.
fn scan_braces(line: &str, depth: &mut i32, opened: &mut bool) {
    let mut chars = line.chars();
    while let Some(character) = chars.next() {
        match character {
            '"' => skip_quoted(&mut chars, '"'),
            '\'' if starts_char_literal(&chars) => skip_quoted(&mut chars, '\''),
            '{' => {
                *depth += 1;
                *opened = true;
            }
            '}' => *depth -= 1,
            _ => {}
        }
    }
}

/// Distinguishes `'x'` / `'\n'` from lifetimes such as `&'static str`.
fn starts_char_literal(rest: &std::str::Chars<'_>) -> bool {
    let mut lookahead = rest.clone();
    match lookahead.next() {
        Some('\\') => true,
        Some(_) => lookahead.next() == Some('\''),
        None => false,
    }
}

fn skip_quoted(chars: &mut std::str::Chars<'_>, quote: char) {
    let mut escaped = false;
    for inner in chars.by_ref() {
        if escaped {
            escaped = false;
            continue;
        }
        if inner == '\\' {
            escaped = true;
            continue;
        }
        if inner == quote {
            break;
        }
    }
}

fn marker_occurrences(source: &str) -> usize {
    UPSTREAM_MARKERS
        .iter()
        .map(|marker| source.matches(marker).count())
        .sum()
}

#[test]
fn production_provider_code_owns_no_undocumented_upstream_endpoint() {
    let mut undocumented = Vec::new();
    let mut observed = Vec::new();
    for (path, source) in provider_sources() {
        let count = marker_occurrences(&production_source(&source));
        match ALLOWED_ENDPOINT_OWNERS
            .iter()
            .find(|(allowed, _, _)| *allowed == path)
        {
            Some((_, limit, _)) if *limit != usize::MAX => {
                assert_eq!(
                    count, *limit,
                    "endpoint inventory for {path} changed; update ALLOWED_ENDPOINT_OWNERS \
                     for the migrated or newly added endpoint"
                );
                observed.push((path, count));
            }
            Some(_) => observed.push((path, count)),
            None if count > 0 => undocumented.push(format!("{path}: {count}")),
            None => {}
        }
    }
    assert!(
        undocumented.is_empty(),
        "production provider code must not own upstream QQ Music endpoints: {undocumented:?}"
    );
    for (path, _, _) in ALLOWED_ENDPOINT_OWNERS {
        assert!(
            observed.iter().any(|(seen, _)| seen == path),
            "endpoint exception {path} no longer exists; drop it from ALLOWED_ENDPOINT_OWNERS"
        );
    }
    println!("allowed endpoint owners: {observed:?}");
}

#[test]
fn migration_scope_baseline_is_recorded() {
    let observed: Vec<(String, usize)> = provider_sources()
        .into_iter()
        .map(|(path, source)| (path, marker_occurrences(&production_source(&source))))
        .filter(|(_, count)| *count > 0)
        .collect();
    println!("production endpoint residue: {observed:?}");
    assert!(!observed.is_empty(), "expected a recorded baseline");
}

#[test]
fn test_gated_items_are_excluded_from_the_production_scan() {
    let sample = "\
use a::b;
#[cfg(test)]
use c::d;
#[cfg(test)]
fn inline_helper() {
    let brace = \"{ not a brace }\";
    assert_eq!(brace.len(), 17);
}
fn production() {
    let _ = \"u.y.qq.com\";
}
#[cfg(not(test))]
fn also_production() {}
#[cfg(test)]
mod tests {
    fn helper() {
        let escaped = \"}\";
        assert_eq!(escaped.len(), 1);
    }
    const URL: &str = \"https://u.y.qq.com/cgi-bin/musicu.fcg\";
}
";
    let production = production_source(sample);
    assert!(production.contains("use a::b;"));
    assert!(!production.contains("use c::d;"));
    assert!(!production.contains("fn inline_helper()"));
    assert!(production.contains("fn production()"));
    assert!(production.contains("fn also_production() {}"));
    assert!(!production.contains("fn helper()"));
    assert!(!production.contains("musicu.fcg"));
    // `u.y.qq.com` also matches the bare `y.qq.com` marker, by design.
    assert_eq!(marker_occurrences(&production), 2);
}
