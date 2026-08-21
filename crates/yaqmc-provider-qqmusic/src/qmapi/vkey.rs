//! Row I: library `MediaSource` URLs sanitized through the in-tree CDN allowlist.
//!
//! Entitlement / quality ladder (`choose_source`) stays in-tree. Encrypted
//! evkey stays on in-tree `zzb` HTTP. Under `qmapi` (non-test) clear vkey HTTP
//! uses library `UrlGetVkey` / `get_song_urls`.

use std::collections::HashMap;
use std::sync::Arc;

use qqmusic_api::modules::song::{FileTypeLike, SongFileInfo, SongFileType};
use qqmusic_api::Platform;
use yaqmc_provider_api::PlaybackLocation;

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::credential::credential_from_uin_and_cookie;
use crate::qmapi::qmapi_client_with;
use crate::qmc::EncryptedMediaKey;
use crate::qqmusic::{normalize_cdn_url, playback_headers, QQMusicError};

/// Library unplayable result used when the account cannot stream this quality.
pub(crate) const QMAP_UNPLAYABLE_RESULT: i64 = 104_003;
const LIBRARY_FALLBACK_ORIGIN: &str = "https://isure.stream.qqmusic.qq.com/";

pub(crate) fn playback_location_from_qmapi(
    result: i64,
    url: &str,
    ekey: &str,
    encrypted: bool,
) -> Result<PlaybackLocation, QQMusicError> {
    if result != 0 {
        return Err(QQMusicError::EntitlementUnavailable);
    }
    let url = url.trim();
    if url.is_empty() {
        return Err(QQMusicError::MalformedResponse);
    }
    let url = sanitize_qmapi_playback_url(url)?;
    if encrypted {
        if ekey.trim().is_empty() {
            return Err(QQMusicError::MalformedResponse);
        }
        let encryption =
            EncryptedMediaKey::new(ekey.to_owned()).map_err(|_| QQMusicError::MalformedResponse)?;
        Ok(PlaybackLocation::EncryptedHttp {
            url,
            headers: playback_headers(),
            encryption: Arc::new(encryption),
        })
    } else {
        Ok(PlaybackLocation::Http {
            url,
            headers: playback_headers(),
        })
    }
}

pub(crate) fn sanitize_qmapi_playback_url(url: &str) -> Result<String, QQMusicError> {
    let parsed = reqwest::Url::parse(url).map_err(|_| QQMusicError::MalformedResponse)?;
    let host = parsed.host_str().ok_or(QQMusicError::MalformedResponse)?;
    let origin = format!("{}://{}/", parsed.scheme(), host);
    let mut path = parsed.path().trim_start_matches('/').to_owned();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    normalize_cdn_url(&origin, &path)
}

fn clear_file_type(filename: &str) -> Option<&'static (dyn FileTypeLike + Send + Sync)> {
    if filename.starts_with("F000") && filename.ends_with(".flac") {
        Some(&SongFileType::Flac)
    } else if filename.starts_with("M800") && filename.ends_with(".mp3") {
        Some(&SongFileType::Mp3_320)
    } else if filename.starts_with("M500") && filename.ends_with(".mp3") {
        Some(&SongFileType::Mp3_128)
    } else if filename.starts_with("C400") && filename.ends_with(".m4a") {
        Some(&SongFileType::Acc96)
    } else {
        None
    }
}

/// Full CDN URLs for playable clear candidates. Missing filenames were queried
/// and are unplayable. Returns `Err` when a filename cannot be mapped so the
/// caller can fall back to in-tree `CgiGetVkey`.
pub(crate) async fn clear_playable_urls(
    track_id: &str,
    media_mid: &str,
    filenames: &[String],
    uin: Option<&str>,
    cookie_header: Option<&str>,
) -> Result<HashMap<String, String>, QQMusicError> {
    if filenames.is_empty() {
        return Ok(HashMap::new());
    }
    let mut infos = Vec::with_capacity(filenames.len());
    for filename in filenames {
        let file_type = clear_file_type(filename).ok_or(QQMusicError::MalformedResponse)?;
        infos.push(
            SongFileInfo::new(track_id)
                .with_media_mid(media_mid)
                .with_song_type(0)
                .with_type_ref(file_type),
        );
    }
    let credential = match (uin, cookie_header) {
        (Some(uin), Some(cookie)) => {
            Some(credential_from_uin_and_cookie(uin, cookie, None, u64::MAX)?)
        }
        _ => None,
    };
    let client =
        qmapi_client_with(credential.clone(), Some(Platform::Android)).map_err(map_qmapi_error)?;
    let response = client
        .song
        .get_song_urls(&infos, &SongFileType::Mp3_128, credential.as_ref())
        .await
        .map_err(map_qmapi_error)?;
    let mut urls = HashMap::new();
    for (filename, item) in filenames.iter().zip(response.data) {
        if item.result != 0 || item.purl.trim().is_empty() {
            continue;
        }
        let joined = if item.purl.starts_with("https://") || item.purl.starts_with("http://") {
            item.purl
        } else {
            format!(
                "{LIBRARY_FALLBACK_ORIGIN}{}",
                item.purl.trim_start_matches('/')
            )
        };
        let sanitized = sanitize_qmapi_playback_url(&joined)?;
        urls.insert(filename.clone(), sanitized);
    }
    Ok(urls)
}

#[cfg(test)]
mod tests {
    use yaqmc_provider_api::PlaybackLocation;

    use super::*;

    const LIBRARY_FALLBACK: &str =
        "https://isure.stream.qqmusic.qq.com/C400fixture.m4a?vkey=redacted";
    const INTREE_SIP: &str =
        "https://aqqmusic.tc.qq.com/amobile.music.tc.qq.com/C400fixture.m4a?vkey=redacted";

    #[test]
    fn library_fallback_domain_is_on_the_intree_allowlist() {
        let url = sanitize_qmapi_playback_url(LIBRARY_FALLBACK).expect("allowed");
        assert!(url.starts_with("https://isure.stream.qqmusic.qq.com/"));
        assert!(url.contains("vkey=redacted"));
    }

    #[test]
    fn intree_sip_style_url_stays_allowed() {
        sanitize_qmapi_playback_url(INTREE_SIP).expect("allowed");
    }

    #[test]
    fn unknown_cdn_host_is_rejected() {
        assert!(matches!(
            sanitize_qmapi_playback_url("https://example.invalid/C400fixture.m4a?vkey=redacted"),
            Err(QQMusicError::MalformedResponse)
        ));
    }

    #[test]
    fn unplayable_result_does_not_become_a_fake_url() {
        assert!(matches!(
            playback_location_from_qmapi(QMAP_UNPLAYABLE_RESULT, "", "", false),
            Err(QQMusicError::EntitlementUnavailable)
        ));
    }

    #[test]
    fn clear_playable_url_maps_to_http_location() {
        let location =
            playback_location_from_qmapi(0, LIBRARY_FALLBACK, "", false).expect("mapped");
        match location {
            PlaybackLocation::Http { url, .. } => {
                assert!(url.starts_with("https://isure.stream.qqmusic.qq.com/"));
            }
            other => panic!("expected HTTP location, got {other:?}"),
        }
    }

    #[test]
    fn encrypted_playable_url_keeps_ekey_and_allowlisted_host() {
        let location = playback_location_from_qmapi(0, LIBRARY_FALLBACK, "fixture-ekey", true)
            .expect("mapped");
        match location {
            PlaybackLocation::EncryptedHttp {
                url, encryption, ..
            } => {
                assert!(url.starts_with("https://isure.stream.qqmusic.qq.com/"));
                assert_eq!(encryption.key_len(), "fixture-ekey".len());
            }
            other => panic!("expected encrypted HTTP location, got {other:?}"),
        }
    }

    #[test]
    fn clear_file_types_match_intree_candidate_prefixes() {
        assert!(clear_file_type("F000MEDIA.flac").is_some());
        assert!(clear_file_type("M800MEDIA.mp3").is_some());
        assert!(clear_file_type("M500MEDIA.mp3").is_some());
        assert!(clear_file_type("C400MEDIA.m4a").is_some());
        assert!(clear_file_type("RS02MEDIA.mp3").is_none());
        assert!(clear_file_type("AIM0MEDIA.mflac").is_none());
    }
}
