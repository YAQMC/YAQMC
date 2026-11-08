//! Plugin store discovery over the public GitHub REST API.
//!
//! Discovery is anonymous and read-only: repositories are found only through the
//! mandatory `topic:yaqmc-plugin` qualifier, and release metadata is fetched per
//! repository on demand. Store packages are never trusted publishers; they enter
//! the existing reviewed installation transaction as unverified sources.

use super::updates::remote::UpdateHttp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub const STORE_TOPIC: &str = "yaqmc-plugin";
pub const PACKAGE_SUFFIX: &str = ".yaqmc-plugin";
const API_ORIGIN: &str = "https://api.github.com";
/// Asset downloads 302 from the API to GitHub's release CDN (verified 2026-11).
pub const DOWNLOAD_ORIGINS: [&str; 4] = [
    API_ORIGIN,
    "https://github.com",
    "https://release-assets.githubusercontent.com",
    "https://objects.githubusercontent.com",
];
const SEARCH_PER_PAGE: u32 = 20;
/// GitHub search serves at most 1000 results; the store stops well before that.
const MAX_SEARCH_PAGE: u32 = 10;
const RELEASES_PER_PAGE: u32 = 10;
const MAX_RELEASE_PAGE: u32 = 10;
const MAX_ASSET_PAGES: u32 = 5;
const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;
const FRESH_FOR: Duration = Duration::from_secs(300);
const MAX_CACHE_ENTRIES: usize = 64;
const MAX_QUERY_TERMS: usize = 8;
const MAX_TERM_CHARS: usize = 64;
const MAX_BODY_CHARS: usize = 20_000;
const MAX_DESCRIPTION_CHARS: usize = 500;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StoreSort {
    #[default]
    BestMatch,
    Stars,
    Updated,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StoreFilter {
    /// GitHub's default repository fields: name, description and topics.
    #[default]
    All,
    Name,
    Description,
    /// Repository owner (user or organization) login.
    Author,
    /// Exact `owner/repo`.
    Repository,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreSearchRequest {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub filter: StoreFilter,
    #[serde(default)]
    pub sort: StoreSort,
    #[serde(default = "first_page")]
    pub page: u32,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreReleasesRequest {
    pub owner: String,
    pub repo: String,
    #[serde(default)]
    pub include_prereleases: bool,
    #[serde(default = "first_page")]
    pub page: u32,
    #[serde(default)]
    pub refresh: bool,
}

/// Identifies one release asset; the host resolves and validates everything else.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreAssetRef {
    pub owner: String,
    pub repo: String,
    pub release_id: u64,
    pub asset_id: u64,
}

fn first_page() -> u32 {
    1
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreRepository {
    pub id: u64,
    pub owner: String,
    pub repo: String,
    pub full_name: String,
    pub description: Option<String>,
    pub html_url: String,
    pub owner_type: String,
    pub owner_avatar_url: Option<String>,
    /// Owned by the `YAQMC` GitHub organization. Ownership is not a signature.
    pub organization_owned: bool,
    pub stars: u64,
    pub license: Option<String>,
    pub topics: Vec<String>,
    pub archived: bool,
    pub fork: bool,
    pub updated_at: Option<String>,
    pub pushed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSearchPage {
    pub query: String,
    pub page: u32,
    pub total_count: u64,
    pub incomplete_results: bool,
    pub has_more: bool,
    pub items: Vec<StoreRepository>,
    /// Served from the local cache because GitHub could not be reached.
    pub stale: bool,
    pub fetched_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreAsset {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub download_count: u64,
    pub updated_at: Option<String>,
    /// GitHub-computed digest when present. Integrity only, not publisher trust.
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoreRelease {
    pub id: u64,
    pub tag_name: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub html_url: String,
    pub assets: Vec<StoreAsset>,
    /// Release attachments that are not `.yaqmc-plugin` packages.
    pub other_asset_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreReleasesPage {
    pub owner: String,
    pub repo: String,
    pub page: u32,
    pub has_more: bool,
    pub releases: Vec<StoreRelease>,
    /// Releases skipped on this page because they are prereleases.
    pub hidden_prereleases: usize,
    pub stale: bool,
    pub fetched_at_ms: u64,
}

/// A resolved, validated asset ready to download.
#[derive(Clone, Debug)]
pub struct ResolvedAsset {
    pub full_name: String,
    pub release_id: u64,
    pub asset: StoreAsset,
    pub download_url: String,
}

struct CacheEntry {
    etag: Option<String>,
    body: Value,
    has_next: bool,
    fetched: Instant,
    fetched_at_ms: u64,
}

struct Fetched {
    body: Value,
    has_next: bool,
    stale: bool,
    fetched_at_ms: u64,
}

#[derive(Default)]
pub struct StoreCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn bounded(value: Option<&str>, max_chars: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(max_chars).collect())
}

/// GitHub logins/repository names: ASCII alphanumerics, `-`, `_`, `.`.
pub fn valid_github_name(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Builds the search `q`. User text can narrow results but can never remove or
/// override the mandatory topic: qualifiers, boolean operators and grouping are
/// dropped so every term is ANDed with `topic:yaqmc-plugin`.
pub fn search_query(query: &str, filter: StoreFilter) -> Result<String, String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| {
            term.chars()
                .filter(|c| !matches!(c, '"' | '(' | ')' | '\\' | ':'))
                .take(MAX_TERM_CHARS)
                .collect::<String>()
        })
        .filter(|term| {
            !term.is_empty()
                && !["or", "and", "not"].contains(&term.to_ascii_lowercase().as_str())
                && !term.starts_with('-')
        })
        .take(MAX_QUERY_TERMS)
        .collect();
    let mut q = format!("topic:{STORE_TOPIC}");
    match filter {
        StoreFilter::Author | StoreFilter::Repository if terms.is_empty() => {}
        StoreFilter::Author => {
            let login = &terms[0];
            if !valid_github_name(login) {
                return Err("store-invalid-query".into());
            }
            q.push_str(&format!(" user:{login}"));
        }
        StoreFilter::Repository => {
            let raw = query.trim();
            let (owner, repo) = raw.split_once('/').ok_or("store-invalid-query")?;
            if !valid_github_name(owner) || !valid_github_name(repo) {
                return Err("store-invalid-query".into());
            }
            q.push_str(&format!(" repo:{owner}/{repo}"));
        }
        StoreFilter::All | StoreFilter::Name | StoreFilter::Description => {
            for term in &terms {
                q.push(' ');
                q.push_str(term);
            }
            match filter {
                StoreFilter::Name if !terms.is_empty() => q.push_str(" in:name"),
                StoreFilter::Description if !terms.is_empty() => q.push_str(" in:description"),
                _ => {}
            }
        }
    }
    Ok(q)
}

fn parse_repository(item: &Value) -> Option<StoreRepository> {
    let owner_value = item.get("owner")?;
    let owner = owner_value.get("login")?.as_str()?.to_owned();
    let repo = item.get("name")?.as_str()?.to_owned();
    if !valid_github_name(&owner) || !valid_github_name(&repo) {
        return None;
    }
    let full_name = format!("{owner}/{repo}");
    let topics: Vec<String> = item
        .get("topics")
        .and_then(Value::as_array)
        .map(|topics| {
            topics
                .iter()
                .filter_map(Value::as_str)
                .filter(|t| t.len() <= 50)
                .take(20)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    // Defend against search-index drift: listing always requires the topic.
    if !topics.iter().any(|t| t == STORE_TOPIC) {
        return None;
    }
    let owner_type = match owner_value.get("type").and_then(Value::as_str) {
        Some("Organization") => "Organization",
        _ => "User",
    }
    .to_owned();
    Some(StoreRepository {
        id: item.get("id")?.as_u64()?,
        organization_owned: owner == "YAQMC" && owner_type == "Organization",
        html_url: format!("https://github.com/{full_name}"),
        owner_avatar_url: owner_value
            .get("avatar_url")
            .and_then(Value::as_str)
            .filter(|url| {
                url.starts_with("https://avatars.githubusercontent.com/") && url.len() < 512
            })
            .map(str::to_owned),
        description: bounded(
            item.get("description").and_then(Value::as_str),
            MAX_DESCRIPTION_CHARS,
        ),
        stars: item
            .get("stargazers_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        license: item
            .get("license")
            .and_then(|l| l.get("spdx_id"))
            .and_then(Value::as_str)
            .filter(|id| *id != "NOASSERTION")
            .and_then(|id| bounded(Some(id), 64)),
        archived: item
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        fork: item.get("fork").and_then(Value::as_bool).unwrap_or(false),
        updated_at: bounded(item.get("updated_at").and_then(Value::as_str), 32),
        pushed_at: bounded(item.get("pushed_at").and_then(Value::as_str), 32),
        topics,
        owner_type,
        full_name,
        owner,
        repo,
    })
}

/// Exact, case-insensitive `.yaqmc-plugin` suffix. `.sig`, archives, installers
/// and source bundles never match; the downloaded manifest stays authoritative.
pub fn is_package_asset_name(name: &str) -> bool {
    name.len() > PACKAGE_SUFFIX.len()
        && name.len() <= 255
        && name.to_ascii_lowercase().ends_with(PACKAGE_SUFFIX)
        && !name.contains(['/', '\\'])
}

fn parse_asset(asset: &Value) -> Option<StoreAsset> {
    let name = asset.get("name")?.as_str()?;
    if !is_package_asset_name(name)
        || asset.get("state").and_then(Value::as_str) != Some("uploaded")
    {
        return None;
    }
    Some(StoreAsset {
        id: asset.get("id")?.as_u64()?,
        name: name.to_owned(),
        size: asset.get("size")?.as_u64()?,
        download_count: asset
            .get("download_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        updated_at: bounded(asset.get("updated_at").and_then(Value::as_str), 32),
        sha256: asset
            .get("digest")
            .and_then(Value::as_str)
            .and_then(|d| d.strip_prefix("sha256:"))
            .filter(|hex| super::updates::valid_sha256(hex))
            .map(str::to_owned),
    })
}

fn parse_release(release: &Value, full_name: &str) -> Option<StoreRelease> {
    if release.get("draft").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    let raw_assets = release
        .get("assets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let assets: Vec<StoreAsset> = raw_assets.iter().filter_map(parse_asset).collect();
    let id = release.get("id")?.as_u64()?;
    Some(StoreRelease {
        id,
        tag_name: bounded(release.get("tag_name").and_then(Value::as_str), 128)?,
        name: bounded(release.get("name").and_then(Value::as_str), 256),
        body: bounded(release.get("body").and_then(Value::as_str), MAX_BODY_CHARS),
        published_at: bounded(release.get("published_at").and_then(Value::as_str), 32),
        prerelease: release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        html_url: format!("https://github.com/{full_name}/releases"),
        other_asset_count: raw_assets.len() - assets.len(),
        assets,
    })
}

fn has_next_link(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(reqwest::header::LINK)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|link| link.split(',').any(|part| part.contains("rel=\"next\"")))
}

/// Maps GitHub failures to stable codes the renderer localizes.
fn http_error(response: &reqwest::Response) -> String {
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
    };
    let exhausted = header("x-ratelimit-remaining") == Some(0);
    if status == 429 || (status == 403 && (exhausted || header("retry-after").is_some())) {
        let reset_ms = header("retry-after")
            .map(|seconds| now_ms() + seconds * 1000)
            .or_else(|| header("x-ratelimit-reset").map(|epoch| epoch * 1000))
            .unwrap_or(0);
        return format!("store-rate-limited:{reset_ms}");
    }
    match status {
        404 => "store-not-found".into(),
        422 => "store-invalid-query".into(),
        _ => format!("store-http-{status}"),
    }
}

fn store_network_error(error: String) -> String {
    match error.as_str() {
        "update-download-timeout" | "update-dns-timeout" => "store-timeout".into(),
        "update-cancelled" => "store-cancelled".into(),
        _ => "store-offline".into(),
    }
}

impl StoreCache {
    async fn get_json(
        &self,
        http: &UpdateHttp,
        url: &str,
        refresh: bool,
        cancel: &CancellationToken,
    ) -> Result<Fetched, String> {
        let cached = {
            let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            entries.get(url).map(|entry| {
                (
                    entry.etag.clone(),
                    entry.body.clone(),
                    entry.has_next,
                    entry.fetched.elapsed() < FRESH_FOR,
                    entry.fetched_at_ms,
                )
            })
        };
        if let Some((_, body, has_next, true, fetched_at_ms)) = &cached {
            if !refresh {
                return Ok(Fetched {
                    body: body.clone(),
                    has_next: *has_next,
                    stale: false,
                    fetched_at_ms: *fetched_at_ms,
                });
            }
        }
        let etag = cached.as_ref().and_then(|c| c.0.clone());
        let mut headers = vec![
            ("accept", "application/vnd.github+json"),
            ("x-github-api-version", "2022-11-28"),
        ];
        if let Some(etag) = etag.as_deref() {
            headers.push(("if-none-match", etag));
        }
        let fallback = |error: String| match &cached {
            // Offline and rate-limited reads keep showing the last good result.
            Some((_, body, has_next, _, fetched_at_ms)) if error != "store-cancelled" => {
                Ok(Fetched {
                    body: body.clone(),
                    has_next: *has_next,
                    stale: true,
                    fetched_at_ms: *fetched_at_ms,
                })
            }
            _ => Err(error),
        };
        let origins = [API_ORIGIN.to_owned()];
        let action = async {
            let mut response = http
                .request(url, &origins, &headers)
                .await
                .map_err(store_network_error)?;
            if response.status() == reqwest::StatusCode::NOT_MODIFIED {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(http_error(&response));
            }
            let etag = response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() < 256 && v.is_ascii())
                .map(str::to_owned);
            let has_next = has_next_link(response.headers());
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "store-offline")? {
                if bytes.len() as u64 + chunk.len() as u64 > MAX_METADATA_BYTES {
                    return Err("store-response-too-large".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value =
                serde_json::from_slice(&bytes).map_err(|_| "store-response-invalid")?;
            Ok(Some((etag, body, has_next)))
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err("store-cancelled".to_owned()),
            result = tokio::time::timeout(Duration::from_secs(30), action) => result.unwrap_or_else(|_| Err("store-timeout".into())),
        };
        let fetched_at_ms = now_ms();
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        match result {
            Ok(None) => {
                let Some(entry) = entries.get_mut(url) else {
                    drop(entries);
                    return fallback("store-response-invalid".into());
                };
                entry.fetched = Instant::now();
                entry.fetched_at_ms = fetched_at_ms;
                Ok(Fetched {
                    body: entry.body.clone(),
                    has_next: entry.has_next,
                    stale: false,
                    fetched_at_ms,
                })
            }
            Ok(Some((etag, body, has_next))) => {
                if entries.len() >= MAX_CACHE_ENTRIES && !entries.contains_key(url) {
                    if let Some(oldest) = entries
                        .iter()
                        .min_by_key(|(_, entry)| entry.fetched)
                        .map(|(key, _)| key.clone())
                    {
                        entries.remove(&oldest);
                    }
                }
                entries.insert(
                    url.to_owned(),
                    CacheEntry {
                        etag,
                        body: body.clone(),
                        has_next,
                        fetched: Instant::now(),
                        fetched_at_ms,
                    },
                );
                Ok(Fetched {
                    body,
                    has_next,
                    stale: false,
                    fetched_at_ms,
                })
            }
            Err(error) => {
                drop(entries);
                fallback(error)
            }
        }
    }

    pub(crate) async fn search(
        &self,
        http: &UpdateHttp,
        request: StoreSearchRequest,
        cancel: &CancellationToken,
    ) -> Result<StoreSearchPage, String> {
        let page = request.page.clamp(1, MAX_SEARCH_PAGE);
        let q = search_query(&request.query, request.filter)?;
        let mut url = reqwest::Url::parse(&format!("{API_ORIGIN}/search/repositories"))
            .map_err(|_| "store-invalid-query")?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("q", &q);
            match request.sort {
                StoreSort::BestMatch => {}
                StoreSort::Stars => {
                    pairs
                        .append_pair("sort", "stars")
                        .append_pair("order", "desc");
                }
                StoreSort::Updated => {
                    pairs
                        .append_pair("sort", "updated")
                        .append_pair("order", "desc");
                }
            }
            pairs
                .append_pair("per_page", &SEARCH_PER_PAGE.to_string())
                .append_pair("page", &page.to_string());
        }
        let fetched = self
            .get_json(http, url.as_str(), request.refresh, cancel)
            .await?;
        let items = fetched
            .body
            .get("items")
            .and_then(Value::as_array)
            .ok_or("store-response-invalid")?;
        let mut seen = std::collections::HashSet::new();
        let items: Vec<StoreRepository> = items
            .iter()
            .filter_map(parse_repository)
            .filter(|repo| seen.insert(repo.id))
            .collect();
        let total_count = fetched
            .body
            .get("total_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        Ok(StoreSearchPage {
            query: q,
            page,
            has_more: page < MAX_SEARCH_PAGE
                && (fetched.has_next || u64::from(page * SEARCH_PER_PAGE) < total_count),
            total_count,
            incomplete_results: fetched
                .body
                .get("incomplete_results")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            items,
            stale: fetched.stale,
            fetched_at_ms: fetched.fetched_at_ms,
        })
    }

    pub(crate) async fn releases(
        &self,
        http: &UpdateHttp,
        request: StoreReleasesRequest,
        cancel: &CancellationToken,
    ) -> Result<StoreReleasesPage, String> {
        if !valid_github_name(&request.owner) || !valid_github_name(&request.repo) {
            return Err("store-invalid-repository".into());
        }
        let page = request.page.clamp(1, MAX_RELEASE_PAGE);
        let full_name = format!("{}/{}", request.owner, request.repo);
        let url = format!(
            "{API_ORIGIN}/repos/{full_name}/releases?per_page={RELEASES_PER_PAGE}&page={page}"
        );
        let fetched = self.get_json(http, &url, request.refresh, cancel).await?;
        let all: Vec<StoreRelease> = fetched
            .body
            .as_array()
            .ok_or("store-response-invalid")?
            .iter()
            .filter_map(|release| parse_release(release, &full_name))
            .collect();
        let hidden_prereleases = if request.include_prereleases {
            0
        } else {
            all.iter().filter(|r| r.prerelease).count()
        };
        Ok(StoreReleasesPage {
            releases: all
                .into_iter()
                .filter(|r| request.include_prereleases || !r.prerelease)
                .collect(),
            hidden_prereleases,
            has_more: fetched.has_next && page < MAX_RELEASE_PAGE,
            page,
            owner: request.owner,
            repo: request.repo,
            stale: fetched.stale,
            fetched_at_ms: fetched.fetched_at_ms,
        })
    }

    /// Re-reads the repository, release and asset from GitHub (never from the
    /// renderer) and checks the topic, draft state, package suffix and size limit.
    pub(crate) async fn resolve_asset(
        &self,
        http: &UpdateHttp,
        reference: &StoreAssetRef,
        max_bytes: u64,
        cancel: &CancellationToken,
    ) -> Result<ResolvedAsset, String> {
        if !valid_github_name(&reference.owner)
            || !valid_github_name(&reference.repo)
            || reference.release_id == 0
            || reference.asset_id == 0
        {
            return Err("store-invalid-repository".into());
        }
        let repo_url = format!("{API_ORIGIN}/repos/{}/{}", reference.owner, reference.repo);
        let repository = self.get_json(http, &repo_url, true, cancel).await?;
        if repository.stale {
            return Err("store-offline".into());
        }
        let repository =
            parse_repository(&repository.body).ok_or("store-not-a-plugin-repository")?;
        let release_url = format!(
            "{API_ORIGIN}/repos/{}/releases/{}",
            repository.full_name, reference.release_id
        );
        let release = self.get_json(http, &release_url, true, cancel).await?;
        if release.stale {
            return Err("store-offline".into());
        }
        let parsed = parse_release(&release.body, &repository.full_name)
            .ok_or("store-release-unavailable")?;
        let mut asset = parsed
            .assets
            .iter()
            .find(|asset| asset.id == reference.asset_id)
            .cloned();
        // Large releases list further assets on a separate paginated endpoint.
        let mut page = 1;
        while asset.is_none() && page <= MAX_ASSET_PAGES {
            let url = format!(
                "{API_ORIGIN}/repos/{}/releases/{}/assets?per_page=100&page={page}",
                repository.full_name, reference.release_id
            );
            let fetched = self.get_json(http, &url, true, cancel).await?;
            asset = fetched
                .body
                .as_array()
                .ok_or("store-response-invalid")?
                .iter()
                .filter_map(parse_asset)
                .find(|asset| asset.id == reference.asset_id);
            if !fetched.has_next {
                break;
            }
            page += 1;
        }
        let asset = asset.ok_or("store-asset-unavailable")?;
        if asset.size == 0 || asset.size > max_bytes {
            return Err("store-asset-too-large".into());
        }
        Ok(ResolvedAsset {
            download_url: format!(
                "{API_ORIGIN}/repos/{}/releases/assets/{}",
                repository.full_name, asset.id
            ),
            full_name: repository.full_name,
            release_id: reference.release_id,
            asset,
        })
    }
}

/// Plugin-state `source` for a store installation.
pub fn source_label(asset: &ResolvedAsset) -> String {
    format!("github:{}/releases/{}", asset.full_name, asset.release_id)
}

/// The `github:owner/repo` part of a store source, compared to detect a plugin id
/// moving between repositories.
pub fn source_repository(source: &str) -> Option<&str> {
    let rest = source.strip_prefix("github:")?;
    Some(rest.split("/releases/").next().unwrap_or(rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::updates::remote::tests::TestServer;
    use serde_json::json;

    fn repo(owner: &str, name: &str, id: u64, topics: &[&str]) -> Value {
        json!({
            "id": id, "name": name, "full_name": format!("{owner}/{name}"),
            "owner": {"login": owner, "type": if owner == "YAQMC" { "Organization" } else { "User" },
                      "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4"},
            "description": "Provider plugin", "stargazers_count": 3,
            "license": {"spdx_id": "MIT"}, "topics": topics,
            "archived": false, "fork": false, "updated_at": "2026-11-01T00:00:00Z"
        })
    }

    fn release(id: u64, prerelease: bool, assets: Value) -> Value {
        json!({"id": id, "tag_name": format!("v{id}"), "name": "Release", "body": "notes",
               "draft": false, "prerelease": prerelease,
               "published_at": "2026-11-02T00:00:00Z", "assets": assets})
    }

    fn asset(id: u64, name: &str, size: u64) -> Value {
        json!({"id": id, "name": name, "size": size, "state": "uploaded", "download_count": 1,
               "digest": format!("sha256:{}", "a".repeat(64))})
    }

    fn put_json(server: &TestServer, path: &str, status: u16, headers: Vec<String>, body: Value) {
        server.routes.lock().unwrap().insert(
            path.into(),
            (status, headers, serde_json::to_vec(&body).unwrap()),
        );
    }

    /// External-service check, excluded from deterministic runs:
    /// `cargo test -p yaqmc-core --lib live_github -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "queries the live GitHub API"]
    async fn live_github_topic_search_and_releases() {
        let cache = StoreCache::default();
        let http = UpdateHttp::default();
        let cancel = CancellationToken::new();
        let page = cache
            .search(&http, StoreSearchRequest::default(), &cancel)
            .await
            .expect("live topic search");
        println!(
            "total={} incomplete={}",
            page.total_count, page.incomplete_results
        );
        for repo in &page.items {
            assert!(repo.topics.iter().any(|topic| topic == STORE_TOPIC));
            let releases = cache
                .releases(
                    &http,
                    StoreReleasesRequest {
                        owner: repo.owner.clone(),
                        repo: repo.repo.clone(),
                        include_prereleases: true,
                        page: 1,
                        refresh: false,
                    },
                    &cancel,
                )
                .await
                .expect("live releases");
            println!(
                "{} org={} releases={} packages={}",
                repo.full_name,
                repo.organization_owned,
                releases.releases.len(),
                releases
                    .releases
                    .iter()
                    .map(|r| r.assets.len())
                    .sum::<usize>()
            );
        }
    }

    #[test]
    fn user_text_cannot_remove_the_topic_constraint() {
        let q = |text, filter| search_query(text, filter).unwrap();
        assert_eq!(q("", StoreFilter::All), "topic:yaqmc-plugin");
        assert_eq!(
            q(
                "lyrics OR topic:other -topic:yaqmc-plugin (x) \"y\"",
                StoreFilter::All
            ),
            "topic:yaqmc-plugin lyrics topicother x y"
        );
        assert_eq!(
            q("netease", StoreFilter::Name),
            "topic:yaqmc-plugin netease in:name"
        );
        assert_eq!(
            q("YAQMC", StoreFilter::Author),
            "topic:yaqmc-plugin user:YAQMC"
        );
        assert_eq!(
            q("YAQMC/yaqmc-music-providers", StoreFilter::Repository),
            "topic:yaqmc-plugin repo:YAQMC/yaqmc-music-providers"
        );
        assert!(search_query("a b/c d", StoreFilter::Repository).is_err());
        assert!(search_query("bad*login", StoreFilter::Author).is_err());
        let long = "x ".repeat(40);
        assert_eq!(
            q(&long, StoreFilter::All).split(' ').count(),
            1 + MAX_QUERY_TERMS
        );
    }

    #[test]
    fn only_exact_package_suffixes_are_candidates() {
        for name in ["a.yaqmc-plugin", "A.YAQMC-PLUGIN"] {
            assert!(is_package_asset_name(name), "{name}");
        }
        for name in [
            ".yaqmc-plugin",
            "a.yaqmc-plugin.sig",
            "a.yaqmc-plugin.zip",
            "source.zip",
            "a.apk",
            "a.exe",
            "a.tar.gz",
            "dir/a.yaqmc-plugin",
        ] {
            assert!(!is_package_asset_name(name), "{name}");
        }
    }

    #[tokio::test]
    async fn search_filters_topic_dedupes_paginates_and_serves_stale_cache_on_rate_limit() {
        let server = TestServer::start().await;
        let path = "/search/repositories?q=topic%3Ayaqmc-plugin&per_page=20&page=1";
        put_json(
            &server,
            path,
            200,
            vec!["ETag: \"v1\"".into(), "Link: <x>; rel=\"next\"".into()],
            json!({"total_count": 45, "incomplete_results": true, "items": [
                repo("YAQMC", "yaqmc-music-providers", 1, &["yaqmc-plugin"]),
                repo("YAQMC", "yaqmc-music-providers", 1, &["yaqmc-plugin"]),
                repo("someone", "untagged", 2, &["music"]),
                repo("YAQMC-fan", "fork", 3, &["yaqmc-plugin"]),
            ]}),
        );
        let cache = StoreCache::default();
        let cancel = CancellationToken::new();
        let page = cache
            .search(&server.http, StoreSearchRequest::default(), &cancel)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.items[0].organization_owned);
        assert!(
            !page.items[1].organization_owned,
            "name prefix is not ownership"
        );
        assert!(page.has_more && page.incomplete_results && !page.stale);

        // Fresh cache answers without a request.
        let before = server.requests.load(std::sync::atomic::Ordering::SeqCst);
        cache
            .search(&server.http, StoreSearchRequest::default(), &cancel)
            .await
            .unwrap();
        assert_eq!(
            server.requests.load(std::sync::atomic::Ordering::SeqCst),
            before
        );

        // A forced refresh that is rate limited returns the cached page marked stale.
        put_json(
            &server,
            path,
            403,
            vec![
                "x-ratelimit-remaining: 0".into(),
                "x-ratelimit-reset: 1800000000".into(),
            ],
            json!({"message": "API rate limit exceeded"}),
        );
        let refreshed = StoreSearchRequest {
            refresh: true,
            ..Default::default()
        };
        assert!(
            cache
                .search(&server.http, refreshed.clone(), &cancel)
                .await
                .unwrap()
                .stale
        );
        // Without a cache entry the caller gets the reset time to show.
        let empty = StoreCache::default();
        assert_eq!(
            empty
                .search(&server.http, refreshed, &cancel)
                .await
                .unwrap_err(),
            "store-rate-limited:1800000000000"
        );
        put_json(
            &server,
            path,
            429,
            vec!["retry-after: 30".into()],
            json!({}),
        );
        assert!(empty
            .search(&server.http, StoreSearchRequest::default(), &cancel)
            .await
            .unwrap_err()
            .starts_with("store-rate-limited:"));
        // Unreachable paths surface as stable error codes, never as "no results".
        let missing = StoreSearchRequest {
            query: "nothing".into(),
            ..Default::default()
        };
        assert_eq!(
            empty
                .search(&server.http, missing, &cancel)
                .await
                .unwrap_err(),
            "store-not-found"
        );
    }

    #[tokio::test]
    async fn releases_hide_prereleases_and_non_package_assets_by_default() {
        let server = TestServer::start().await;
        put_json(
            &server,
            "/repos/o/r/releases?per_page=10&page=1",
            200,
            vec![],
            json!([
                release(3, true, json!([asset(31, "beta.yaqmc-plugin", 10)])),
                release(2, false, json!([
                    asset(21, "music-android.yaqmc-plugin", 10),
                    asset(22, "music-desktop.yaqmc-plugin", 10),
                    asset(23, "music.yaqmc-plugin.sig", 1),
                    asset(24, "source.zip", 1),
                ])),
                release(1, false, json!([])),
                {"id": 9, "tag_name": "draft", "draft": true, "assets": []}
            ]),
        );
        let cache = StoreCache::default();
        let cancel = CancellationToken::new();
        let request = StoreReleasesRequest {
            owner: "o".into(),
            repo: "r".into(),
            include_prereleases: false,
            page: 1,
            refresh: false,
        };
        let page = cache
            .releases(&server.http, request.clone(), &cancel)
            .await
            .unwrap();
        assert_eq!(page.hidden_prereleases, 1);
        assert_eq!(
            page.releases.iter().map(|r| r.id).collect::<Vec<_>>(),
            [2, 1]
        );
        assert_eq!(
            page.releases[0].assets.len(),
            2,
            "multiple candidates stay separate"
        );
        assert_eq!(page.releases[0].other_asset_count, 2);
        assert!(
            page.releases[1].assets.is_empty(),
            "release without packages is listed"
        );
        let with = StoreReleasesRequest {
            include_prereleases: true,
            ..request
        };
        assert_eq!(
            cache
                .releases(&server.http, with, &cancel)
                .await
                .unwrap()
                .releases
                .len(),
            3
        );
        assert!(cache
            .releases(
                &server.http,
                StoreReleasesRequest {
                    owner: "../x".into(),
                    repo: "r".into(),
                    include_prereleases: false,
                    page: 1,
                    refresh: false
                },
                &cancel
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn assets_resolve_only_from_topic_repositories_and_published_packages() {
        let server = TestServer::start().await;
        put_json(
            &server,
            "/repos/o/r",
            200,
            vec![],
            repo("o", "r", 5, &["yaqmc-plugin"]),
        );
        put_json(
            &server,
            "/repos/o/plain",
            200,
            vec![],
            repo("o", "plain", 6, &[]),
        );
        put_json(
            &server,
            "/repos/o/r/releases/7",
            200,
            vec![],
            release(
                7,
                false,
                json!([asset(70, "p.yaqmc-plugin", 100), asset(71, "p.zip", 5)]),
            ),
        );
        put_json(
            &server,
            "/repos/o/r/releases/7/assets?per_page=100&page=1",
            200,
            vec![],
            json!([
                asset(70, "p.yaqmc-plugin", 100),
                asset(72, "late.yaqmc-plugin", 100)
            ]),
        );
        let cache = StoreCache::default();
        let cancel = CancellationToken::new();
        let reference = |repo: &str, asset_id| StoreAssetRef {
            owner: "o".into(),
            repo: repo.into(),
            release_id: 7,
            asset_id,
        };
        let resolved = cache
            .resolve_asset(&server.http, &reference("r", 70), 1000, &cancel)
            .await
            .unwrap();
        assert_eq!(
            resolved.download_url,
            "https://api.github.com/repos/o/r/releases/assets/70"
        );
        assert_eq!(source_label(&resolved), "github:o/r/releases/7");
        assert_eq!(source_repository(&source_label(&resolved)), Some("o/r"));
        // Paginated assets are found; non-packages, oversize and non-topic repos are refused.
        assert!(cache
            .resolve_asset(&server.http, &reference("r", 72), 1000, &cancel)
            .await
            .is_ok());
        for (repo, asset_id, max, error) in [
            ("r", 71, 1000, "store-asset-unavailable"),
            ("r", 70, 99, "store-asset-too-large"),
            ("plain", 70, 1000, "store-not-a-plugin-repository"),
        ] {
            assert_eq!(
                cache
                    .resolve_asset(&server.http, &reference(repo, asset_id), max, &cancel)
                    .await
                    .unwrap_err(),
                error
            );
        }
    }
}
