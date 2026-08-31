#![no_std]

extern crate alloc;

use alloc::{
    alloc::{alloc, dealloc, realloc, Layout},
    format,
    string::{String, ToString},
    vec::Vec,
};
use serde_json::{json, Value};

#[global_allocator]
static ALLOCATOR: dlmalloc::GlobalDlmalloc = dlmalloc::GlobalDlmalloc;

#[unsafe(no_mangle)]
unsafe extern "C" fn memcmp(left: *const u8, right: *const u8, length: usize) -> i32 {
    for index in 0..length {
        let left = left.add(index).read();
        let right = right.add(index).read();
        if left != right {
            return i32::from(left) - i32::from(right);
        }
    }
    0
}

#[unsafe(export_name = "cabi_realloc")]
unsafe extern "C" fn canonical_realloc(
    old_ptr: *mut u8,
    old_len: usize,
    align: usize,
    new_len: usize,
) -> *mut u8 {
    if old_len == 0 {
        if new_len == 0 {
            return align as *mut u8;
        }
        let layout = Layout::from_size_align_unchecked(new_len, align);
        let ptr = alloc(layout);
        if ptr.is_null() {
            core::arch::wasm32::unreachable();
        }
        return ptr;
    }

    let layout = Layout::from_size_align_unchecked(old_len, align);
    if new_len == 0 {
        dealloc(old_ptr, layout);
        return align as *mut u8;
    }
    let ptr = realloc(old_ptr, layout, new_len);
    if ptr.is_null() {
        core::arch::wasm32::unreachable();
    }
    ptr
}

wit_bindgen::generate!({
    path: "../../../wit/yaqmc-provider",
    world: "provider-account",
});

const PROVIDER_ID: &str = "dev.yaqmc.example.platform";
const ACCOUNT_ORIGIN: &str = "https://accounts.example.com";
const ACCOUNT_HANDLE_KEY: &str = "account.credential-handle";
const ACCOUNT_ACTIVE_KEY: &str = "account.authenticated";
const AUDIO_CACHE_KEY: &str = "fixture-audio-v1";
const QUALITY_KEY: &str = "playback.preferred-quality";

struct PlatformExample;

impl Guest for PlatformExample {
    fn invoke(
        capability: String,
        operation: String,
        payload_json: String,
    ) -> Result<String, String> {
        let value = match (capability.as_str(), operation.as_str()) {
            ("provider.catalog", "catalog.search") => catalog_search(&payload_json)?,
            ("provider.catalog", "catalog.song") => song(),
            ("provider.catalog", "catalog.album") => album(),
            ("provider.catalog", "catalog.artist") => artist(),
            ("provider.catalog", "catalog.artist-page") => artist_page(&payload_json)?,
            ("provider.catalog", "catalog.playlist") => playlist(),
            ("provider.catalog", "catalog.home") => home_feed(),
            ("provider.catalog", "catalog.discover") => discover_feed(),
            ("provider.catalog", "catalog.area") => area_feed(),
            ("provider.catalog", "catalog.artwork-data-uri") => json!(""),
            ("provider.playback", "playback.resolve")
            | ("provider.playback", "playback.resolve-client-fallback") => playback_resolution()?,
            ("provider.playback", "playback.set-preferred-quality") => {
                set_preferred_quality(&payload_json)?
            }
            ("provider.playback", "playback.set-current-quality") => Value::Null,
            ("provider.recommendation", "recommendation.next") => recommendation_batch(),
            ("provider.lyrics", "lyrics.get") => lyrics(),
            ("provider.account", "account.auth.login-methods") => login_methods(),
            ("provider.account", "account.auth.prepare-oauth") => prepare_oauth(&payload_json)?,
            ("provider.account", "account.auth.complete-oauth") => complete_oauth(&payload_json)?,
            ("provider.account", "account.auth.cancel-oauth") => account_snapshot()?,
            ("provider.account", "account.snapshot") => account_snapshot()?,
            ("provider.account", "account.favorite-songs") => favorite_songs(),
            ("provider.account", "account.playlists")
            | ("provider.account", "account.recently-played") => empty_account_page(),
            ("provider.account", "account.restore-session") => Value::Null,
            ("provider.account", "account.sign-out") => sign_out()?,
            _ => {
                return Err(error(
                    "unsupported-operation",
                    "the complete example does not implement this operation",
                ));
            }
        };
        Ok(value.to_string())
    }
}

fn parse_payload(payload_json: &str) -> Result<Value, String> {
    serde_json::from_str(payload_json)
        .map_err(|_| error("invalid-request", "the request payload is not valid JSON"))
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 4_096)
        .ok_or_else(|| error("invalid-request", "a required request field is invalid"))
}

fn error(code: &str, message: &str) -> String {
    json!({ "code": code, "message": message, "retryable": false }).to_string()
}

fn artwork() -> Value {
    json!({
        "src": "",
        "alt": "YAQMC complete Provider Component fixture",
        "dominantColor": "#334155"
    })
}

fn artist_preview() -> Value {
    json!({
        "id": "platform-artist-1",
        "name": "YAQMC Example",
        "artwork": artwork()
    })
}

fn album_preview() -> Value {
    json!({
        "id": "platform-album-1",
        "title": "Provider Platform",
        "artist": artist_preview(),
        "artwork": artwork(),
        "releaseYear": 2026
    })
}

fn playlist_preview() -> Value {
    json!({
        "id": "platform-playlist-1",
        "title": "Component Platform",
        "creator": "YAQMC Example",
        "artwork": artwork(),
        "trackCount": 1
    })
}

fn song() -> Value {
    json!({
        "id": "platform-song-1",
        "title": "Capability Boundaries",
        "artists": [{ "id": "platform-artist-1", "name": "YAQMC Example" }],
        "album": { "id": "platform-album-1", "title": "Provider Platform" },
        "artwork": artwork(),
        "durationMs": 1000,
        "trackNumber": 1,
        "isFavorite": false,
        "quality": "standard",
        "availability": { "status": "available" },
        "provider": { "providerId": PROVIDER_ID, "trackId": "platform-song-1" }
    })
}

fn album() -> Value {
    json!({
        "id": "platform-album-1",
        "title": "Provider Platform",
        "artist": { "id": "platform-artist-1", "name": "YAQMC Example" },
        "artwork": artwork(),
        "releaseYear": 2026,
        "genre": "Example",
        "description": "A deterministic full-capability Provider Component fixture.",
        "tracks": [song()]
    })
}

fn artist() -> Value {
    json!({
        "id": "platform-artist-1",
        "name": "YAQMC Example",
        "artwork": artwork(),
        "description": "A sandboxed cross-platform provider example.",
        "topSongs": [song()],
        "albums": [album_preview()]
    })
}

fn playlist() -> Value {
    json!({
        "id": "platform-playlist-1",
        "title": "Component Platform",
        "description": "Catalog, playback, recommendation, lyrics, and account in one fixture.",
        "owner": { "id": "platform-owner-1", "displayName": "YAQMC Example" },
        "artwork": artwork(),
        "updatedLabel": "Deterministic fixture",
        "tracks": [song()]
    })
}

fn catalog_search(payload_json: &str) -> Result<Value, String> {
    let payload = parse_payload(payload_json)?;
    let kind = field(&payload, "kind")?;
    let query = field(&payload, "query")?;
    let page = payload.get("page").and_then(Value::as_u64).unwrap_or(1);
    let items = match kind {
        "song" => json!([song()]),
        "artist" => json!([artist_preview()]),
        "album" => json!([album_preview()]),
        "playlist" => json!([playlist_preview()]),
        _ => return Err(error("invalid-request", "the search kind is unsupported")),
    };
    Ok(json!({
        "kind": kind,
        "query": query,
        "page": page,
        "hasMore": false,
        "items": items
    }))
}

fn artist_page(payload_json: &str) -> Result<Value, String> {
    let payload = parse_payload(payload_json)?;
    let kind = field(&payload, "kind")?;
    let artist_id = field(&payload, "id")?;
    let page = payload.get("page").and_then(Value::as_u64).unwrap_or(1);
    let items = match kind {
        "song" => json!([song()]),
        "album" => json!([album_preview()]),
        _ => {
            return Err(error(
                "invalid-request",
                "the artist section is unsupported",
            ))
        }
    };
    Ok(json!({
        "kind": kind,
        "artistId": artist_id,
        "page": page,
        "hasMore": false,
        "items": items
    }))
}

fn home_feed() -> Value {
    json!({
        "featured": { "eyebrow": "Component platform", "album": album() },
        "recentlyPlayed": [],
        "madeForYou": [playlist()],
        "newReleases": [album()]
    })
}

fn discover_feed() -> Value {
    json!({
        "charts": [playlist()],
        "newSongs": playlist(),
        "newAlbums": [album()],
        "popularSonglists": [playlist()],
        "categories": [],
        "podcasts": [],
        "newMvs": [],
        "featured": []
    })
}

fn area_feed() -> Value {
    json!({
        "title": "Component area",
        "songlists": [playlist()],
        "playlists": [],
        "artists": [{ "id": "platform-artist-1", "name": "YAQMC Example", "cover": "" }]
    })
}

fn recommendation_batch() -> Value {
    json!({ "songs": [song()], "nextCursor": null, "ended": true })
}

fn lyrics() -> Value {
    json!({
        "songId": "platform-song-1",
        "syncMode": "line",
        "metadata": {
            "sourceLabel": "YAQMC Provider Component example",
            "language": "en",
            "translatedLanguage": null,
            "offsetMs": 0
        },
        "vocalists": [],
        "lines": [{
            "id": "line-1",
            "startMs": 0,
            "endMs": 1000,
            "text": "Capabilities stay behind the Host boundary.",
            "words": []
        }]
    })
}

fn set_preferred_quality(payload_json: &str) -> Result<Value, String> {
    let payload = parse_payload(payload_json)?;
    let quality = normalize_quality(field(&payload, "quality")?);
    yaqmc::provider::storage::kv_set(QUALITY_KEY, quality)?;
    Ok(provider_status(quality))
}

fn normalize_quality(value: &str) -> &'static str {
    match value {
        "standard" => "standard",
        "high" => "high",
        "lossless" => "lossless",
        "hi-res" => "hi-res",
        "master" => "master",
        _ => "automatic",
    }
}

fn provider_status(preferred_quality: &str) -> Value {
    json!({
        "providerId": PROVIDER_ID,
        "displayName": "YAQMC Platform Example",
        "connection": "ready",
        "message": "deterministic component fixture",
        "preferredQuality": preferred_quality,
        "capabilities": {
            "search": true,
            "album": true,
            "artist": true,
            "playlist": true,
            "lyrics": true,
            "wordTimedLyrics": true,
            "streaming": true,
            "qualitySelection": true
        }
    })
}

fn playback_resolution() -> Result<Value, String> {
    let audio = wav_fixture();
    yaqmc::provider::storage::cache_put(AUDIO_CACHE_KEY, &audio)?;
    let stored = yaqmc::provider::storage::kv_get(QUALITY_KEY)?;
    let requested = normalize_quality(stored.as_deref().unwrap_or("automatic"));
    let fallback = if matches!(requested, "automatic" | "standard") {
        Value::Null
    } else {
        json!("source-unavailable")
    };
    Ok(json!({
        "source": { "kind": "cache", "key": AUDIO_CACHE_KEY },
        "cacheKey": "platform-song-1:standard",
        "format": "wav",
        "mimeType": "audio/wav",
        "qualityLabel": "standard",
        "sampleRateHz": 8000,
        "bitDepth": 8,
        "contentLength": audio.len(),
        "isPreview": false,
        "selection": {
            "requestedQuality": requested,
            "resolvedQuality": "standard",
            "fallbackReason": fallback,
            "preview": false,
            "qualityCapabilities": []
        }
    }))
}

fn wav_fixture() -> Vec<u8> {
    const SAMPLE_RATE: u32 = 8_000;
    const SAMPLE_COUNT: u32 = SAMPLE_RATE;
    let mut bytes = Vec::with_capacity(44 + SAMPLE_COUNT as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + SAMPLE_COUNT).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&8_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&SAMPLE_COUNT.to_le_bytes());
    for sample in 0..SAMPLE_COUNT {
        bytes.push(if sample % 18 < 9 { 0x48 } else { 0xb8 });
    }
    bytes
}

fn login_methods() -> Value {
    json!([{ "id": "example", "label": "Example account", "flow": "oauth" }])
}

fn prepare_oauth(payload_json: &str) -> Result<Value, String> {
    let payload = parse_payload(payload_json)?;
    if field(&payload, "loginProvider")? != "example" {
        return Err(error("invalid-request", "the login method is unavailable"));
    }
    let state = field(&payload, "state")?;
    Ok(json!({
        "url": format!("{ACCOUNT_ORIGIN}/authorize?state={state}"),
        "navigationAllowlist": [format!("{ACCOUNT_ORIGIN}/")],
        "callbackMatcher": { "urlPrefix": format!("{ACCOUNT_ORIGIN}/callback") }
    }))
}

fn complete_oauth(payload_json: &str) -> Result<Value, String> {
    let payload = parse_payload(payload_json)?;
    let callback_url = field(&payload, "callbackUrl")?;
    if let Some(previous) = yaqmc::provider::storage::kv_get(ACCOUNT_HANDLE_KEY)? {
        yaqmc::provider::credentials::delete(&previous)?;
    }
    let handle = yaqmc::provider::credentials::create(ACCOUNT_ORIGIN, callback_url)?;
    if let Err(error) = yaqmc::provider::storage::kv_set(ACCOUNT_HANDLE_KEY, &handle) {
        let _ = yaqmc::provider::credentials::delete(&handle);
        return Err(error);
    }
    if let Err(error) = yaqmc::provider::storage::kv_set(ACCOUNT_ACTIVE_KEY, "true") {
        let _ = yaqmc::provider::storage::kv_delete(ACCOUNT_HANDLE_KEY);
        let _ = yaqmc::provider::credentials::delete(&handle);
        return Err(error);
    }
    Ok(authenticated_snapshot())
}

fn sign_out() -> Result<Value, String> {
    if let Some(handle) = yaqmc::provider::storage::kv_get(ACCOUNT_HANDLE_KEY)? {
        yaqmc::provider::credentials::delete(&handle)?;
    }
    yaqmc::provider::storage::kv_delete(ACCOUNT_HANDLE_KEY)?;
    yaqmc::provider::storage::kv_delete(ACCOUNT_ACTIVE_KEY)?;
    Ok(guest_snapshot())
}

fn account_snapshot() -> Result<Value, String> {
    let active = yaqmc::provider::storage::kv_get(ACCOUNT_ACTIVE_KEY)?.as_deref() == Some("true");
    let has_handle = yaqmc::provider::storage::kv_get(ACCOUNT_HANDLE_KEY)?.is_some();
    Ok(if active && has_handle {
        authenticated_snapshot()
    } else {
        guest_snapshot()
    })
}

fn account_capabilities() -> Value {
    json!({
        "qrLogin": false,
        "favoriteRead": true,
        "favoriteWrite": false,
        "playlistRead": false,
        "playlistWrite": false,
        "recentHistoryRead": false
    })
}

fn guest_snapshot() -> Value {
    json!({
        "state": "guest",
        "profile": null,
        "entitlement": null,
        "revision": 0,
        "capabilities": account_capabilities()
    })
}

fn authenticated_snapshot() -> Value {
    json!({
        "state": "authenticated",
        "profile": {
            "avatarUrl": null,
            "nickname": "Component Listener",
            "maskedIdentity": "EX********NT"
        },
        "entitlement": {
            "tier": "free",
            "membership": "active",
            "expiresAtMs": null,
            "permittedQualities": ["standard"],
            "observedMaximumQuality": "standard",
            "restrictions": []
        },
        "revision": 1,
        "capabilities": account_capabilities()
    })
}

fn favorite_songs() -> Value {
    json!({
        "items": [song()],
        "nextCursor": null,
        "total": 1,
        "fetchedAtMs": yaqmc::provider::utilities::monotonic_millis(),
        "stale": false,
        "authRevision": 0
    })
}

fn empty_account_page() -> Value {
    json!({
        "items": [],
        "nextCursor": null,
        "total": 0,
        "fetchedAtMs": yaqmc::provider::utilities::monotonic_millis(),
        "stale": false,
        "authRevision": 0
    })
}

export!(PlatformExample);

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}
