use std::{collections::BTreeMap, fs, sync::Mutex};

use serde_json::json;
use tempfile::tempdir;
use yaqmc_core::{
    app_preferences::{
        close_hides_to_tray, global_shortcuts_enabled, load_background, persist_background,
        set_preferences, set_surface_interaction, PreferencesChangeSink, PreferencesRepository,
        MAX_BACKGROUND_BYTES,
    },
    diagnostics::{
        export_bundle, AppSection, BundleOptions, DiagnosticsSnapshot, PlaybackSection,
        PluginDiagnostic, PluginStatus, ProviderSection, BUNDLE_MAX_BYTES,
    },
    issue_reporter::{prepare_preview, validate_open_url, IssueCategory, IssueDraft},
    logging::{
        persisted_log_level, sanitize_field, sanitize_path_with_roots, ErrorRecord, LogLevel,
        LoggingHandle, RECENT_ERROR_CAPACITY,
    },
    platform::{
        capabilities_for_backend, AudioDiagnostics, DesktopIntegrationStatus, LinuxDiagnostics,
        PlatformCapabilities, PlatformDiagnostics, SystemMediaStatus,
    },
};

struct MemoryPreferences {
    value: Mutex<Option<String>>,
}

impl MemoryPreferences {
    fn with(value: Option<&str>) -> Self {
        Self {
            value: Mutex::new(value.map(str::to_owned)),
        }
    }

    fn stored(&self) -> Option<String> {
        self.value.lock().expect("memory preferences lock").clone()
    }
}

impl PreferencesRepository for MemoryPreferences {
    fn load_preferences(&self) -> Result<Option<String>, String> {
        Ok(self.stored())
    }

    fn update_preferences<F>(&self, update: F) -> Result<String, String>
    where
        F: FnOnce(Option<String>) -> String,
    {
        let mut value = self.value.lock().expect("memory preferences lock");
        let next = update(value.clone());
        *value = Some(next.clone());
        Ok(next)
    }
}

#[derive(Default)]
struct RecordingSink {
    values: Mutex<Vec<String>>,
}

impl PreferencesChangeSink for RecordingSink {
    fn preferences_changed(&self, value: &str) {
        self.values
            .lock()
            .expect("recording sink lock")
            .push(value.to_owned());
    }
}

fn platform() -> PlatformDiagnostics {
    PlatformDiagnostics {
        generated_at_unix_ms: 1_755_190_800_000,
        app_name: "YAQMC",
        app_version: "0.1.0".to_owned(),
        os: "windows",
        architecture: "x86_64",
        linux: None,
        capabilities: PlatformCapabilities {
            reliable_always_on_top: true,
            click_through: true,
            transparent_window: true,
            global_positioning: true,
            absolute_window_placement: true,
            fullscreen_detection: true,
            global_shortcuts: true,
            notes: Vec::new(),
        },
        audio: AudioDiagnostics {
            implementation: "Rodio 0.22 / CPAL 0.17 (WASAPI)".to_owned(),
            route: "WASAPI default host".to_owned(),
            available: true,
            selected_output: Some("Speakers".to_owned()),
            selected_output_kind: Some("system-default".to_owned()),
            resolved_output: Some("Speakers".to_owned()),
            resolved_driver: Some("WASAPI".to_owned()),
            resolved_host: Some("WASAPI".to_owned()),
            resolved_sample_rate: Some(48_000),
            resolved_channels: Some(2),
            resolved_sample_format: Some("f32".to_owned()),
        },
        system_media: SystemMediaStatus {
            available: true,
            backend: "SMTC",
            specification: "Windows SMTC",
            error: None,
        },
        desktop_integration: DesktopIntegrationStatus {
            tray_available: true,
            tray_error: None,
            global_shortcuts_supported: true,
            global_shortcuts_enabled: true,
            global_shortcuts: vec!["control+alt+Space"],
            shortcut_error: None,
        },
    }
}

fn playback() -> PlaybackSection {
    PlaybackSection {
        state: "paused",
        selected_quality: Some("automatic".to_owned()),
        decoder_hint: Some("flac".to_owned()),
        queue_length: 0,
        current_source_kind: None,
        playback_order: "sequential",
        repeat_mode: "off",
        primary_playback_mode: "sequential",
        playback_session_id: 0,
        snapshot_revision: 0,
        source_generation: 0,
        last_seek_revision: 0,
    }
}

fn snapshot() -> DiagnosticsSnapshot {
    DiagnosticsSnapshot::assemble(
        "sessionid00000000",
        LogLevel::Info,
        AppSection {
            name: "YAQMC",
            version: "0.1.0".to_owned(),
            commit: Some("deadbeef1234".to_owned()),
            channel: "development".to_owned(),
            build_type: "release".to_owned(),
        },
        platform(),
        Some(ProviderSection {
            id: "qqmusic".to_owned(),
            connection: "online".to_owned(),
            account_state: "authenticated".to_owned(),
            membership_tier: Some("green-diamond".to_owned()),
            membership_status: Some("active".to_owned()),
        }),
        playback(),
        vec![ErrorRecord::new(
            "YAQMC-AUDIO-OUTPUT-001",
            "audio.output",
            "unavailable",
        )],
    )
}

#[test]
fn preferences_apply_atomic_transform_and_emit_the_final_document() {
    let repository = MemoryPreferences::with(Some(
        r#"{"version":2,"surfaces":{"desktop":{"interaction":"passive-locked","locked":true},"island":{"interaction":"interactive"}}}"#,
    ));
    let sink = RecordingSink::default();
    set_preferences(
        &repository,
        &sink,
        r#"{"version":2,"system":{"closeBehavior":"quit","globalShortcutsEnabled":true},"surfaces":{"desktop":{"interaction":"interactive","enabled":false},"island":{"interaction":"passive-locked"}}}"#.to_owned(),
    )
    .expect("preferences persist");

    let stored = repository.stored().expect("stored document");
    let document: serde_json::Value = serde_json::from_str(&stored).expect("stored JSON");
    assert_eq!(document["system"]["closeBehavior"], "quit");
    assert_eq!(
        document["surfaces"]["desktop"]["interaction"],
        "passive-locked"
    );
    assert_eq!(document["surfaces"]["island"]["interaction"], "interactive");
    assert!(document["surfaces"]["desktop"].get("locked").is_none());
    assert_eq!(
        sink.values.lock().expect("recorded sink").as_slice(),
        [stored.clone()]
    );
    assert!(!close_hides_to_tray(&repository));
    assert!(global_shortcuts_enabled(&repository));

    let patched = set_surface_interaction(
        &repository,
        &sink,
        "desktop",
        "interactive",
        r#"{"version":2}"#.to_owned(),
    )
    .expect("surface patch");
    let patched: serde_json::Value = serde_json::from_str(&patched).expect("patched JSON");
    assert_eq!(patched["surfaces"]["desktop"]["interaction"], "interactive");
    assert_eq!(patched["surfaces"]["island"]["interaction"], "interactive");

    let defaults = MemoryPreferences::with(None);
    assert!(close_hides_to_tray(&defaults));
    assert!(!global_shortcuts_enabled(&defaults));
}

#[tokio::test]
async fn managed_background_uses_magic_normalization_and_bounded_managed_paths() {
    let temporary = tempdir().expect("temporary root");
    let source = temporary.path().join("wrong-extension.txt");
    fs::write(&source, b"\xff\xd8\xffjpeg bytes").expect("source image");
    let backgrounds = temporary.path().join("data/backgrounds");
    fs::create_dir_all(&backgrounds).expect("background directory");
    fs::write(backgrounds.join("custom-background.png"), b"old").expect("old image");

    let stored = persist_background(&source, &temporary.path().join("data"))
        .await
        .expect("persist managed background");
    assert_eq!(stored.reference, "backgrounds/custom-background.jpg");
    assert!(stored.data_uri.starts_with("data:image/jpeg;base64,"));
    assert!(!backgrounds.join("custom-background.png").exists());

    let loaded = load_background(&temporary.path().join("data"), &stored.reference)
        .await
        .expect("load managed background")
        .expect("managed background exists");
    assert_eq!(loaded, stored);
    assert!(load_background(
        &temporary.path().join("data"),
        "backgrounds/custom-background.png",
    )
    .await
    .expect("missing is not an error")
    .is_none());
    assert!(
        load_background(&temporary.path().join("data"), "../custom-background.jpg")
            .await
            .is_err()
    );

    let exact = temporary.path().join("exact.png");
    let mut exact_bytes = vec![0u8; MAX_BACKGROUND_BYTES as usize];
    exact_bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    fs::write(&exact, exact_bytes).expect("24 MiB image");
    assert!(persist_background(&exact, &temporary.path().join("data"))
        .await
        .is_ok());

    let oversized = temporary.path().join("oversized.png");
    let file = fs::File::create(&oversized).expect("oversized image");
    file.set_len(MAX_BACKGROUND_BYTES + 1)
        .expect("set oversized length");
    assert!(
        persist_background(&oversized, &temporary.path().join("data"))
            .await
            .is_err()
    );
}

#[test]
fn logging_keeps_bounded_redacted_records_with_injected_paths() {
    let directory = tempdir().expect("temporary log directory");
    let handle = LoggingHandle::for_directory(directory.path().join("logs"), LogLevel::Debug);
    for index in 0..RECENT_ERROR_CAPACITY + 2 {
        handle.record_error(ErrorRecord::new(
            format!("YAQMC-TEST-{index:02}"),
            "test",
            format!("cookie=uin=1; qm_keyst=secret-{index}"),
        ));
    }
    let records = handle.recent_errors();
    assert_eq!(records.len(), RECENT_ERROR_CAPACITY);
    assert_eq!(records.first().expect("first record").code, "YAQMC-TEST-02");
    assert!(records
        .iter()
        .all(|record| !record.message.contains("secret-")));
    assert_eq!(
        sanitize_path_with_roots("/home/alice/logs/yaqmc.log", &["/home/alice"]),
        "<USER_HOME>/logs/yaqmc.log"
    );
    let unicode_input = "你".repeat(300);
    let unicode = sanitize_field(&unicode_input);
    assert!(unicode.is_char_boundary(unicode.len()));
    assert_eq!(
        persisted_log_level(Some("not-a-level")),
        LogLevel::default()
    );
    assert_eq!(persisted_log_level(Some("trace")), LogLevel::Trace);
    assert_eq!(handle.log_dir(), directory.path().join("logs").as_path());
}

#[test]
fn diagnostics_and_issue_wire_contracts_remain_exact_with_injected_renderer() {
    let mut snapshot = snapshot();
    snapshot.plugins = vec![PluginDiagnostic {
        id: "visualizer".to_owned(),
        version: "1.2.3".to_owned(),
        enabled: true,
        status: PluginStatus::Active,
        entrypoint_kinds: vec!["scene".to_owned()],
        api_version: 1,
        package_sha256: "a".repeat(64),
        permissions: vec!["ui.scene".to_owned()],
        risk_rating: "low".to_owned(),
    }];
    let json = serde_json::to_value(&snapshot).expect("snapshot JSON");
    assert_eq!(
        json["provider"],
        json!({
            "id": "qqmusic",
            "connection": "online",
            "accountState": "authenticated",
            "membershipTier": "green-diamond",
            "membershipStatus": "active"
        })
    );
    assert_eq!(json["plugins"][0]["status"], "active");
    assert_eq!(json["platform"]["systemMedia"]["backend"], "SMTC");

    let preview = prepare_preview(
        &IssueDraft {
            category: IssueCategory::Playback,
            summary: "Song pauses at 0:22".to_owned(),
            description: "authorization=Bearer SECRET".to_owned(),
            bundle_file_name: Some("YAQMC-diagnostics.zip".to_owned()),
            linked_error_code: None,
            linked_op_id: None,
        },
        &snapshot,
        "electron/43.4.0",
    );
    assert!(preview.body.contains("Renderer: electron/43.4.0"));
    assert!(!preview.body.contains("SECRET"));
    assert!(preview.url.contains("template=bug-report.yml"));
    validate_open_url(&preview.url).expect("generated issue URL");
}

#[test]
fn diagnostic_bundle_counts_every_uncompressed_entry_and_skips_sparse_oversize_log() {
    let temporary = tempdir().expect("temporary root");
    let logs = temporary.path().join("logs");
    fs::create_dir_all(&logs).expect("log directory");
    fs::write(logs.join("yaqmc-small.log"), b"normal log\n").expect("small log");
    let sparse = fs::File::create(logs.join("yaqmc-huge.log")).expect("sparse log");
    sparse
        .set_len(BUNDLE_MAX_BYTES + 1)
        .expect("sparse logical length");

    let output = temporary.path().join("out");
    let result = export_bundle(&output, &snapshot(), &logs, BundleOptions::default())
        .expect("bundle with optional oversized log skipped");
    assert!(result
        .warnings
        .iter()
        .any(|warning| { warning.contains("yaqmc-huge.log") && warning.contains("skipped") }));

    let mut archive = zip::ZipArchive::new(fs::File::open(&result.path).expect("bundle file"))
        .expect("valid ZIP");
    let names = archive.file_names().map(str::to_owned).collect::<Vec<_>>();
    for required in [
        "manifest.json",
        "diagnostics.json",
        "diagnostics.txt",
        "redaction-report.txt",
    ] {
        assert!(
            names.iter().any(|name| name == required),
            "missing {required}"
        );
    }
    assert!(!names.iter().any(|name| name == "logs/yaqmc-huge.log"));
    let uncompressed = (0..archive.len())
        .map(|index| archive.by_index(index).expect("ZIP entry").size())
        .sum::<u64>();
    assert!(uncompressed <= BUNDLE_MAX_BYTES);
    assert_eq!(result.sha256.len(), 64);
}

#[test]
fn native_wayland_and_xwayland_capability_derivation_remain_distinct() {
    let wayland = capabilities_for_backend("wayland-native", true);
    assert!(!wayland.click_through);
    assert!(!wayland.global_positioning);
    assert!(!wayland.global_shortcuts);

    let xwayland = capabilities_for_backend("xwayland", true);
    assert!(xwayland.click_through);
    assert!(xwayland.global_shortcuts);
    assert!(!xwayland.fullscreen_detection);
    assert!(xwayland.notes.iter().any(|note| note.contains("XWayland")));

    let windows = capabilities_for_backend("windows", true);
    assert!(windows.fullscreen_detection);

    let linux = LinuxDiagnostics {
        session_type: Some("wayland".to_owned()),
        display_backend: "xwayland".to_owned(),
        desktop_environment: Some("KDE".to_owned()),
        compositor_hint: None,
        webkitgtk_version: Some("2.46.0".to_owned()),
        graphics_mode: "auto".to_owned(),
        environment: BTreeMap::new(),
        gpu_devices: Vec::new(),
    };
    assert_eq!(linux.display_backend, "xwayland");
}
