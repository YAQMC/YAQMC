//! Plugin API v4 (pages, navigation, layout): install, grants, runtime permission checks,
//! lifecycle, and version gating against a temp `ExtensionHost`.

use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;
use yaqmc_core::plugin::bridge::required_permission;
use yaqmc_core::plugin::host::ExtensionHost;
use yaqmc_core::plugin::permissions::PluginPermission;
use yaqmc_core::plugin::PluginStatus;

const PAGES_ID: &str = "dev.yaqmc.example.pages";
const ACTIONS_ID: &str = "dev.yaqmc.example.actions";

fn example(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/plugins")
        .join(name)
}

fn open_host() -> (TempDir, ExtensionHost) {
    let root = TempDir::new().expect("temp plugin root");
    let host = ExtensionHost::open(root.path().join("plugins")).expect("host opens");
    host.set_developer_mode(true).expect("developer mode");
    (root, host)
}

/// Copies the v4 example into a temp dir with the manifest rewritten by `edit`.
fn variant(edit: impl Fn(String) -> String) -> TempDir {
    let source = example("script-pages");
    let target = TempDir::new().expect("variant dir");
    fs::create_dir_all(target.path().join("dist")).expect("dist dir");
    fs::copy(
        source.join("dist/main.js"),
        target.path().join("dist/main.js"),
    )
    .expect("script");
    let manifest = fs::read_to_string(source.join("manifest.json")).expect("manifest");
    fs::write(target.path().join("manifest.json"), edit(manifest)).expect("write manifest");
    target
}

fn page_permissions() -> [PluginPermission; 3] {
    [
        PluginPermission::UiPages,
        PluginPermission::UiNavigation,
        PluginPermission::UiLayout,
    ]
}

#[test]
fn v4_example_installs_and_its_runtime_holds_exactly_the_page_permissions() {
    let pages = example("script-pages");
    assert!(Path::new(&pages.join("dist/main.js")).is_file());
    let (_root, host) = open_host();

    let installed = host
        .install_unpacked(&pages, true, &[])
        .expect("non-sensitive v4 permissions install without a sensitive grant");
    assert_eq!(installed.id, PAGES_ID);
    assert_eq!(installed.status, PluginStatus::Active);
    for permission in ["ui.pages", "ui.navigation", "ui.layout"] {
        assert!(
            installed
                .granted_permissions
                .iter()
                .any(|value| value == permission),
            "{permission} granted"
        );
    }

    let runtime = host.start_runtime(PAGES_ID).expect("runtime starts");
    for permission in page_permissions() {
        assert!(host.check_permission(&runtime.token, permission).is_ok());
    }
    // Not declared, therefore not available even though v4 could request them.
    assert!(host
        .check_permission(&runtime.token, PluginPermission::PlayerControl)
        .is_err());
    assert!(host
        .check_permission(&runtime.token, PluginPermission::UiSidebar)
        .is_err());

    // Every v4 bridge method resolves to one of the granted page permissions.
    for method in ["ui.pages.render", "ui.navigation.register", "ui.layout.set"] {
        let permission = required_permission(method).unwrap().expect(method);
        assert!(host.check_permission(&runtime.token, permission).is_ok());
    }
}

#[test]
fn disabling_revokes_the_runtime_and_reenabling_issues_a_fresh_one() {
    let (_root, host) = open_host();
    host.install_unpacked(&example("script-pages"), true, &[])
        .expect("install");
    let first = host.start_runtime(PAGES_ID).expect("runtime");

    host.set_enabled(PAGES_ID, false).expect("disable");
    assert!(host
        .check_permission(&first.token, PluginPermission::UiPages)
        .is_err());

    host.set_enabled(PAGES_ID, true).expect("re-enable");
    let second = host.start_runtime(PAGES_ID).expect("new runtime");
    assert_ne!(first.token, second.token);
    assert!(host
        .check_permission(&first.token, PluginPermission::UiPages)
        .is_err());
    assert!(host
        .check_permission(&second.token, PluginPermission::UiPages)
        .is_ok());

    host.uninstall(PAGES_ID, true).expect("uninstall");
    assert!(host
        .check_permission(&second.token, PluginPermission::UiPages)
        .is_err());
}

#[test]
fn older_api_plugins_cannot_use_page_methods() {
    let (_root, host) = open_host();
    host.install_unpacked(&example("script-actions"), true, &[])
        .expect("v2 example installs");
    let runtime = host.start_runtime(ACTIONS_ID).expect("v2 runtime");
    for permission in page_permissions() {
        assert!(host.check_permission(&runtime.token, permission).is_err());
    }

    let v2_with_pages =
        variant(|manifest| manifest.replace("\"apiVersion\": 4", "\"apiVersion\": 2"));
    let error = host
        .install_unpacked(v2_with_pages.path(), true, &[])
        .expect_err("v2 manifests cannot declare ui.pages");
    assert!(!error.to_string().is_empty());
    assert!(host.list().iter().all(|record| record.id != PAGES_ID));
}

#[test]
fn unsupported_api_versions_stay_installed_but_never_activate() {
    let (_root, host) = open_host();
    let future = variant(|manifest| {
        manifest
            .replace("\"apiVersion\": 4", "\"apiVersion\": 5")
            .replace("\"ui.layout\"", "\"ui.layout\", \"ui.someFutureSlot\"")
    });
    let record = host
        .install_unpacked(future.path(), false, &[])
        .expect("structurally valid future package installs disabled");
    assert_eq!(record.id, PAGES_ID);
    assert!(!record.enabled);
    assert_eq!(record.status, PluginStatus::Incompatible);
    assert!(host.set_enabled(PAGES_ID, true).is_err());
    assert!(host.start_runtime(PAGES_ID).is_err());
}
