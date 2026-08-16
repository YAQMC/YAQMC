use crate::qqmusic::QQMusicService;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use yaqmc_core::{
    audio::{write_fixture_wav, AudioFormat, PreparedPlaybackLocation, RodioAudioEngine},
    credentials::MemoryCredentialStore,
    media::{
        CachedMediaPreparer, MediaPreparer, PlaybackEpochGuard, PlaybackLocation,
        ResolvedPlaybackSource,
    },
    playback_types::{AudioQuality, AudioQualityPreference, PlaybackSourceSelection},
    player::{
        AlbumSummary, ArtistSummary, Artwork, LyricDocument, LyricLine, LyricMetadata,
        LyricSyncMode, LyricWord, PlayTracksRequest, PlaybackState, PlayerService, Song,
        SongAvailability,
    },
    storage::StorageService,
};

fn song(id: &str, duration_ms: u64) -> Song {
    Song {
        id: id.to_owned(),
        title: id.to_owned(),
        artists: vec![ArtistSummary {
            id: "artist".to_owned(),
            name: "Artist".to_owned(),
        }],
        album: AlbumSummary {
            id: "album".to_owned(),
            title: "Album".to_owned(),
        },
        artwork: Artwork {
            src: "/cover.svg".to_owned(),
            alt: "Cover".to_owned(),
            dominant_color: "#000000".to_owned(),
            variants: Vec::new(),
        },
        duration_ms,
        track_number: 1,
        is_favorite: false,
        quality: AudioQuality::Lossless,
        availability: SongAvailability::Available,
        audio_formats: Vec::new(),
        playback_capability: None,
        provider: None,
    }
}

fn lyric_document() -> LyricDocument {
    LyricDocument {
        song_id: "one".to_owned(),
        sync_mode: LyricSyncMode::Word,
        metadata: LyricMetadata {
            source_label: "fixture".to_owned(),
            language: Some("en".to_owned()),
            translated_language: None,
            offset_ms: 0,
        },
        vocalists: vec![],
        lines: vec![
            LyricLine {
                id: "line-1".to_owned(),
                start_ms: Some(1_000),
                end_ms: Some(3_000),
                text: "one two".to_owned(),
                translation: None,
                romanization: None,
                vocalist_id: None,
                words: vec![
                    LyricWord {
                        start_ms: 1_000,
                        end_ms: 2_000,
                        text: "one ".to_owned(),
                    },
                    LyricWord {
                        start_ms: 2_000,
                        end_ms: 3_000,
                        text: "two".to_owned(),
                    },
                ],
            },
            LyricLine {
                id: "line-2".to_owned(),
                start_ms: Some(4_000),
                end_ms: Some(5_000),
                text: "after gap".to_owned(),
                translation: None,
                romanization: None,
                vocalist_id: None,
                words: vec![],
            },
        ],
    }
}

#[tokio::test]
async fn qqmusic_http_client_still_prepares_media() {
    let root = tempfile::tempdir().expect("temp root");
    let fixture_path = root.path().join("served.wav");
    write_fixture_wav(&fixture_path, Duration::from_millis(250), 7).expect("write fixture WAV");
    let fixture_bytes = tokio::fs::read(&fixture_path)
        .await
        .expect("read fixture WAV");
    let content_length = fixture_bytes.len() as u64;
    let hits = Arc::new(AtomicUsize::new(0));
    let server_hits = Arc::clone(&hits);
    let app = axum::Router::new().route(
        "/fixture.wav",
        axum::routing::get(move || {
            let fixture_bytes = fixture_bytes.clone();
            let server_hits = Arc::clone(&server_hits);
            async move {
                server_hits.fetch_add(1, Ordering::AcqRel);
                (
                    [(axum::http::header::CONTENT_TYPE, "audio/wav")],
                    fixture_bytes,
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("media listener");
    let address = listener.local_addr().expect("media address");
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("media server");
    });
    let storage = Arc::new(
        StorageService::open(root.path().join("data"), root.path().join("cache")).expect("storage"),
    );
    let service = QQMusicService::new(
        Arc::clone(&storage),
        Arc::new(MemoryCredentialStore::default()),
        root.path().join("fixtures"),
    )
    .expect("QQ Music service");
    let preparer = CachedMediaPreparer::new(service.http_client(), storage);

    let prepared = preparer
        .prepare(ResolvedPlaybackSource {
            cache_key: "qqmusic:fixture:ordinary-http".to_owned(),
            location: PlaybackLocation::Http {
                url: format!("http://{address}/fixture.wav"),
                headers: Vec::new(),
            },
            format: AudioFormat::Wav,
            mime_type: Some("audio/wav".to_owned()),
            quality_label: "fixture".to_owned(),
            bitrate_kbps: None,
            sample_rate_hz: Some(16_000),
            bit_depth: Some(16),
            content_length: Some(content_length),
            supports_range: false,
            expires_at_ms: None,
            timeline_offset_ms: 0,
            timeline_end_ms: Some(250),
            is_preview: false,
            selection: PlaybackSourceSelection {
                requested_quality: AudioQualityPreference::Automatic,
                resolved_quality: AudioQuality::Standard,
                fallback_reason: None,
                preview: false,
                quality_capabilities: Vec::new(),
            },
            epoch_guard: PlaybackEpochGuard::unrestricted(),
        })
        .await
        .expect("ordinary client downloads fixture media");

    match prepared.location {
        PreparedPlaybackLocation::Local(path) => assert!(path.is_file()),
        PreparedPlaybackLocation::Progressive(_) => {
            panic!("non-range fixture must be fully cached")
        }
        PreparedPlaybackLocation::EncryptedLocal { .. }
        | PreparedPlaybackLocation::EncryptedProgressive { .. } => {
            panic!("ordinary fixture must not use an encrypted location")
        }
    }
    assert_eq!(hits.load(Ordering::Acquire), 1);
    server.abort();
}

#[tokio::test]
#[ignore = "opt-in audible native output acceptance"]
async fn local_fixture_drives_real_position_pause_seek_lyrics_and_queue_end() {
    let root = tempfile::tempdir().expect("temp root");
    let storage = Arc::new(
        StorageService::open(root.path().join("data"), root.path().join("cache")).expect("storage"),
    );
    let resolver = Arc::new(
        QQMusicService::new(
            Arc::clone(&storage),
            Arc::new(MemoryCredentialStore::default()),
            root.path().join("fixture-media"),
        )
        .expect("fixture resolver"),
    );
    let preparer = Arc::new(CachedMediaPreparer::new(
        resolver.http_client(),
        Arc::clone(&storage),
    ));
    let audio = Arc::new(RodioAudioEngine::open_default().expect("default output"));
    let player = Arc::new(PlayerService::with_runtime(audio, resolver, preparer));
    player.start_clock();
    player
        .set_volume(0.06)
        .await
        .expect("quiet acceptance volume");
    player
        .play_tracks(PlayTracksRequest {
            tracks: vec![song("one", 1_600), song("two", 1_600)],
            start_at_id: Some("one".to_owned()),
            shuffle: None,
        })
        .await
        .expect("local playback starts");
    player.set_lyrics(Some(lyric_document())).await;
    tokio::time::sleep(Duration::from_millis(550)).await;
    let playing = player.snapshot().await;
    assert_eq!(playing.playback_state, PlaybackState::Playing);
    assert!(playing.position_ms >= 350);
    player.pause().await.expect("pause");
    let paused_at = player.snapshot().await.position_ms;
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(player.snapshot().await.position_ms.abs_diff(paused_at) < 100);
    player.seek(1_000).await.expect("seek");
    assert_eq!(player.current_lyric_state().await.line_index, Some(0));
    player.play().await.expect("resume");
    tokio::time::sleep(Duration::from_millis(850)).await;
    let transitioned = player.snapshot().await;
    assert_eq!(transitioned.current_index, Some(1));
    assert_eq!(transitioned.playback_state, PlaybackState::Playing);
    player.stop_clock();
}
