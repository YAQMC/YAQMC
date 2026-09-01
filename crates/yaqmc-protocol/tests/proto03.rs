use std::collections::HashSet;
use std::time::Duration;

use yaqmc_protocol::{
    authorize, method, methods, AclDenied, ErrorCode, MethodOwner, TimeoutClass, WindowOrigin,
    DEFAULT_METHOD_PAYLOAD_BYTES, FRAME_HARD_CAP_BYTES, PROTOCOL_ONLY_METHODS,
};

#[test]
fn registry_is_the_180_method_single_source_of_truth() {
    let registry = methods();
    assert_eq!(registry.len(), 164 + PROTOCOL_ONLY_METHODS.len());
    let names: HashSet<&str> = registry.iter().map(|spec| spec.name).collect();
    assert_eq!(names.len(), registry.len());
    assert!(method("player_snapshot").is_some());
    assert!(method("lyrics_surface_unlock").is_some());
    for name in ["qqmusic_song", "qqmusic_artist", "qqmusic_artist_catalog"] {
        let spec = method(name).expect(name);
        assert_eq!(spec.owner, MethodOwner::Core);
        assert_eq!(
            spec.allowed_origins,
            [WindowOrigin::Host, WindowOrigin::Main]
        );
    }
    assert!(method("not_a_method").is_none());
    for name in PROTOCOL_ONLY_METHODS {
        assert!(method(name).is_some(), "{name}");
        assert_eq!(method(name).expect(name).owner, MethodOwner::Core);
    }
}

#[test]
fn oauth_launch_details_are_host_only() {
    for name in [
        "auth_oauth_prepare",
        "auth_oauth_complete",
        "auth_oauth_cancel",
        "provider_auth_oauth_prepare",
        "provider_auth_oauth_complete",
        "provider_auth_oauth_cancel",
    ] {
        let spec = method(name).expect(name);
        assert_eq!(spec.owner, MethodOwner::Core);
        assert_eq!(spec.allowed_origins, [WindowOrigin::Host].as_slice());
        authorize(WindowOrigin::Host, name).expect("trusted Electron host");
        assert!(
            authorize(WindowOrigin::Main, name).is_err(),
            "{name} renderer"
        );
    }

    let start = method("provider_auth_oauth_start").expect("host OAuth start");
    assert_eq!(start.owner, MethodOwner::Host);
    assert!(start.allows(WindowOrigin::Main));
}

#[test]
fn method_caps_never_exceed_the_hard_cap_and_default_to_one_mib() {
    for spec in methods() {
        assert!(spec.request_cap > 0 && spec.request_cap <= FRAME_HARD_CAP_BYTES);
        assert!(spec.response_cap > 0 && spec.response_cap <= FRAME_HARD_CAP_BYTES);
        if spec.name != "plugin_read_asset" {
            assert_eq!(spec.request_cap, DEFAULT_METHOD_PAYLOAD_BYTES);
            assert_eq!(spec.response_cap, DEFAULT_METHOD_PAYLOAD_BYTES);
        }
    }

    let asset = method("plugin_read_asset").expect("plugin_read_asset");
    assert_eq!(asset.request_cap, DEFAULT_METHOD_PAYLOAD_BYTES);
    assert!(asset.response_cap > DEFAULT_METHOD_PAYLOAD_BYTES);
    assert!(asset.response_cap <= FRAME_HARD_CAP_BYTES);
    assert!(asset.accepts_response_bytes(4 * 1024 * 1024));
    assert!(!asset.accepts_response_bytes(FRAME_HARD_CAP_BYTES + 1));
}

#[test]
fn timeout_classes_match_the_client_budget_table() {
    assert_eq!(TimeoutClass::Control.duration(), Duration::from_secs(10));
    assert_eq!(TimeoutClass::Standard.duration(), Duration::from_secs(30));
    assert_eq!(TimeoutClass::Long.duration(), Duration::from_secs(120));

    assert_eq!(
        method("core_ping").expect("core_ping").timeout_class,
        TimeoutClass::Control
    );
    assert_eq!(
        method("qqmusic_search")
            .expect("qqmusic_search")
            .timeout_class,
        TimeoutClass::Standard
    );
    assert_eq!(
        method("plugin_install")
            .expect("plugin_install")
            .timeout_class,
        TimeoutClass::Long
    );
}

#[test]
fn core_rechecks_acl_and_rejects_origin_spoofing() {
    authorize(WindowOrigin::Main, "qqmusic_sign_out").expect("main account");
    authorize(WindowOrigin::Host, "qqmusic_sign_out").expect("host is trusted");
    authorize(WindowOrigin::LyricsDesktop, "player_toggle").expect("surface player control");
    authorize(WindowOrigin::LyricsIsland, "lyrics_surface_projection").expect("surface projection");
    authorize(WindowOrigin::LyricsDesktopUnlock, "lyrics_surface_unlock").expect("unlock control");

    let denied = authorize(WindowOrigin::LyricsDesktop, "qqmusic_sign_out")
        .expect_err("lyric surface must not spoof account ACL");
    assert_eq!(denied.code(), ErrorCode::Denied);
    assert_eq!(denied.code().as_str(), "host.denied");
    assert!(!denied.retryable());

    assert!(matches!(
        authorize(WindowOrigin::LyricsIslandUnlock, "player_snapshot"),
        Err(AclDenied { .. })
    ));
    assert!(authorize(WindowOrigin::Main, "lyrics_surface_unlock").is_err());
    assert!(authorize(WindowOrigin::LyricsDesktopUnlock, "plugin_list").is_err());
    authorize(WindowOrigin::Main, "diagnostics_export_bundle_to").expect("export continuation");
    assert!(authorize(WindowOrigin::Host, "diagnostics_export_bundle_to").is_err());
    authorize(WindowOrigin::Main, "statistics_export_to").expect("statistics export continuation");
    assert!(authorize(WindowOrigin::Host, "statistics_export_to").is_err());
    assert!(authorize(WindowOrigin::Host, "preferences_set_background_from").is_err());
    assert!(authorize(WindowOrigin::Host, "plugin_install_from").is_err());
    authorize(WindowOrigin::Host, "platform_attach").expect("host-internal attach stays host+main");
    authorize(WindowOrigin::Host, "qqmusic_sign_out").expect("trusted host account path unchanged");
    assert_eq!(
        authorize(WindowOrigin::Main, "nope")
            .expect_err("unknown")
            .code(),
        ErrorCode::Denied
    );
}

#[test]
fn account_and_plugin_methods_are_main_window_only() {
    let account = method("qqmusic_account_snapshot").expect("account");
    assert_eq!(account.owner, MethodOwner::Core);
    assert!(account.main_window_only);
    assert_eq!(
        account.allowed_origins,
        [WindowOrigin::Host, WindowOrigin::Main].as_slice()
    );

    let plugin = method("plugin_install").expect("plugin");
    assert_eq!(plugin.owner, MethodOwner::Core);
    assert!(plugin.main_window_only);

    let surface = method("player_toggle").expect("toggle");
    assert!(!surface.main_window_only);
    assert!(surface
        .allowed_origins
        .contains(&WindowOrigin::LyricsDesktop));

    let host_owned = method("system_shortcuts_set_enabled").expect("shortcuts");
    assert_eq!(host_owned.owner, MethodOwner::Host);
}

#[test]
fn dialog_split_io_methods_are_core_owned_main_only_with_default_caps() {
    for name in [
        "diagnostics_export_bundle_to",
        "statistics_export_to",
        "preferences_set_background_from",
        "plugin_install_from",
    ] {
        assert!(PROTOCOL_ONLY_METHODS.contains(&name), "{name}");
        let spec = method(name).expect(name);
        assert_eq!(spec.owner, MethodOwner::Core);
        assert!(spec.main_window_only);
        assert_eq!(spec.allowed_origins, [WindowOrigin::Main].as_slice());
        assert!(authorize(WindowOrigin::Main, name).is_ok(), "{name} main");
        assert!(
            authorize(WindowOrigin::Host, name).is_err(),
            "{name} is not host-internal"
        );
        assert!(
            authorize(WindowOrigin::LyricsDesktop, name).is_err(),
            "{name} lyrics"
        );
        assert!(
            authorize(WindowOrigin::LyricsDesktopUnlock, name).is_err(),
            "{name} unlock"
        );
        assert_eq!(spec.request_cap, DEFAULT_METHOD_PAYLOAD_BYTES);
        assert_eq!(spec.response_cap, DEFAULT_METHOD_PAYLOAD_BYTES);
        assert!(spec.request_cap <= FRAME_HARD_CAP_BYTES);
        assert!(spec.response_cap <= FRAME_HARD_CAP_BYTES);
    }

    assert_eq!(
        method("diagnostics_export_bundle_to")
            .expect("export to")
            .timeout_class,
        TimeoutClass::Long
    );
    assert_eq!(
        method("statistics_export_to")
            .expect("statistics export to")
            .timeout_class,
        TimeoutClass::Long
    );
    assert_eq!(
        method("plugin_install_from")
            .expect("install from")
            .timeout_class,
        TimeoutClass::Long
    );
    assert_eq!(
        method("preferences_set_background_from")
            .expect("background from")
            .timeout_class,
        TimeoutClass::Standard
    );

    for retired in [
        "diagnostics_export_bundle",
        "appearance_pick_background",
        "plugin_pick_package",
    ] {
        assert!(
            method(retired).is_none(),
            "{retired} must stay retired after P13"
        );
    }
}

#[test]
fn window_origin_wire_names_match_the_attach_roles() {
    for (origin, name) in [
        (WindowOrigin::Host, "host"),
        (WindowOrigin::Main, "main"),
        (WindowOrigin::LyricsDesktop, "lyrics-desktop"),
        (WindowOrigin::LyricsIsland, "lyrics-island"),
        (WindowOrigin::LyricsDesktopUnlock, "lyrics-desktop-unlock"),
        (WindowOrigin::LyricsIslandUnlock, "lyrics-island-unlock"),
    ] {
        assert_eq!(
            serde_json::to_string(&origin).expect("origin json"),
            format!("\"{name}\"")
        );
        assert_eq!(
            serde_json::from_str::<WindowOrigin>(&format!("\"{name}\"")).expect("parse origin"),
            origin
        );
    }
}
