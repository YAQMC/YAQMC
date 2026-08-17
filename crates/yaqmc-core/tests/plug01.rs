//! PLUG-01: example-plugin install/enable/disable/uninstall battery.
//!
//! Runs against a temp `ExtensionHost` with unpacked fixtures under
//! `examples/plugins/*`. Does not start Electron or enable the hostile probe.

use std::path::{Path, PathBuf};

use tempfile::TempDir;
use yaqmc_core::plugin::host::ExtensionHost;
use yaqmc_core::plugin::package::inspect_package;
use yaqmc_core::plugin::permissions::PluginPermission;
use yaqmc_core::plugin::{PluginManifest, PluginStatus, PLUGIN_STORAGE_QUOTA};

const SAKURA_ID: &str = "dev.yaqmc.example.sakura";
const NETWORK_ID: &str = "dev.yaqmc.example.network";
const ACTIONS_ID: &str = "dev.yaqmc.example.actions";
const SCENES_ID: &str = "dev.yaqmc.example.scenes";
const HOSTILE_ID: &str = "dev.yaqmc.test.hostile";
const NETWORK_ORIGIN: &str = "network:https://example.com";

fn examples_plugins() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins")
}

fn example(name: &str) -> PathBuf {
    examples_plugins().join(name)
}

fn assert_example_dir(path: &Path) {
    assert!(
        path.join("manifest.json").is_file(),
        "missing example plugin at {}",
        path.display()
    );
}

fn open_host() -> (TempDir, ExtensionHost) {
    let root = TempDir::new().expect("temp plugin root");
    let host = ExtensionHost::open(root.path().join("plugins")).expect("host opens");
    (root, host)
}

fn assert_not_hostile(host: &ExtensionHost) {
    assert!(
        host.list().iter().all(|record| record.id != HOSTILE_ID),
        "hostile probe must not be installed as a user plugin"
    );
}

#[test]
fn example_plugin_lifecycle_battery() {
    let sakura = example("style-sakura");
    assert_example_dir(&sakura);

    let (_root, host) = open_host();

    let denied = host
        .install_unpacked(&sakura, true, &[])
        .expect_err("unpacked install needs Developer Mode");
    assert!(denied.to_string().contains("Developer Mode"), "{denied}");

    host.set_developer_mode(true)
        .expect("developer mode enables");
    let installed = host
        .install_unpacked(&sakura, true, &[])
        .expect("sakura installs");
    assert_eq!(installed.id, SAKURA_ID);
    assert!(installed.enabled);
    assert_eq!(installed.status, PluginStatus::Active);
    assert!(installed
        .granted_permissions
        .iter()
        .any(|value| value == "style.register"));
    assert!(host
        .read_installed_text(SAKURA_ID, "styles/main.css")
        .expect("sakura css")
        .contains("player-bar"));
    assert_eq!(host.active_resources().styles.len(), 1);
    assert_eq!(host.list().len(), 1);
    assert_not_hostile(&host);

    let disabled = host.set_enabled(SAKURA_ID, false).expect("disable");
    assert!(!disabled.enabled);
    assert_eq!(disabled.status, PluginStatus::Disabled);
    assert!(host.active_resources().styles.is_empty());

    let enabled = host.set_enabled(SAKURA_ID, true).expect("enable");
    assert!(enabled.enabled);
    assert_eq!(enabled.status, PluginStatus::Active);
    assert_eq!(host.active_resources().styles.len(), 1);

    host.uninstall(SAKURA_ID, true).expect("uninstall");
    assert!(host.list().is_empty());
    assert!(host.active_resources().styles.is_empty());
    assert_not_hostile(&host);
}

#[test]
fn example_plugin_permission_deny_vs_grant() {
    let network = example("script-network");
    assert_example_dir(&network);
    assert!(network.join("dist/main.js").is_file());

    let (_root, host) = open_host();
    host.set_developer_mode(true)
        .expect("developer mode enables");

    let denied_install = host
        .install_unpacked(&network, true, &[])
        .expect_err("sensitive network origin needs an explicit grant");
    assert!(
        denied_install.to_string().contains("explicitly accepted"),
        "{denied_install}"
    );
    assert!(host.list().is_empty());

    let parked = host
        .install_unpacked(&network, false, &[])
        .expect("install disabled without grant");
    assert_eq!(parked.id, NETWORK_ID);
    assert!(!parked.enabled);
    assert!(!parked
        .granted_permissions
        .iter()
        .any(|value| value == NETWORK_ORIGIN));

    let denied_enable = host
        .set_enabled_with_grants(NETWORK_ID, true, &[])
        .expect_err("enable without grant is denied");
    assert!(
        denied_enable.to_string().contains("explicitly accepted"),
        "{denied_enable}"
    );
    assert!(!host.list()[0].enabled);

    let granted = host
        .set_enabled_with_grants(NETWORK_ID, true, &[NETWORK_ORIGIN.to_owned()])
        .expect("grant path enables");
    assert!(granted.enabled);
    assert!(granted
        .granted_permissions
        .iter()
        .any(|value| value == NETWORK_ORIGIN));
    assert!(granted
        .network_origins
        .iter()
        .any(|value| value == "https://example.com"));

    let runtime = host.start_runtime(NETWORK_ID).expect("runtime starts");
    assert!(host
        .check_permission(&runtime.token, PluginPermission::Network)
        .is_ok());
    assert!(host
        .check_permission(&runtime.token, PluginPermission::PlayerControl)
        .is_err());

    host.set_enabled(NETWORK_ID, false).expect("disable");
    host.uninstall(NETWORK_ID, true).expect("uninstall");
    assert_not_hostile(&host);
}

#[test]
fn example_plugin_storage_quota_and_scene_pack_manifest() {
    let scene_pack = example("scene-pack");
    assert_example_dir(&scene_pack);
    let manifest_bytes =
        std::fs::read(scene_pack.join("manifest.json")).expect("scene-pack manifest");
    let manifest = PluginManifest::parse(&manifest_bytes).expect("scene-pack manifest parses");
    assert_eq!(manifest.id, SCENES_ID);
    assert_eq!(
        manifest.entrypoints.scenes,
        vec![
            "scenes/aurora.scene.json".to_owned(),
            "scenes/vinyl-glow.scene.json".to_owned(),
        ]
    );
    let inspection = inspect_package(&scene_pack).expect("scene-pack inspects");
    assert_eq!(inspection.manifest.id, SCENES_ID);
    assert_eq!(inspection.manifest.entrypoints.scenes.len(), 2);

    let actions = example("script-actions");
    assert_example_dir(&actions);
    let (_root, host) = open_host();
    host.set_developer_mode(true)
        .expect("developer mode enables");
    host.install_unpacked(&actions, true, &[])
        .expect("actions installs");

    host.storage_set(ACTIONS_ID, "lastTitle", "Sakura")
        .expect("actions store");
    host.storage_set(SAKURA_ID, "lastTitle", "Night")
        .expect("isolated store");
    assert_eq!(
        host.storage_get(ACTIONS_ID, "lastTitle").as_deref(),
        Some("Sakura")
    );
    assert_eq!(
        host.storage_get(SAKURA_ID, "lastTitle").as_deref(),
        Some("Night")
    );

    let chunk = "x".repeat(4_000);
    let mut stored = 0_usize;
    let mut quota_hit = false;
    for index in 0..32 {
        let key = format!("q{index:02}");
        match host.storage_set(ACTIONS_ID, &key, &chunk) {
            Ok(()) => stored += 1,
            Err(error) => {
                assert!(
                    error.to_string().contains("quota"),
                    "expected quota error, got {error}"
                );
                quota_hit = true;
                break;
            }
        }
    }
    assert!(quota_hit, "64 KiB plugin storage quota should fire");
    assert!(stored > 0);
    assert!(stored * 4_000 < PLUGIN_STORAGE_QUOTA + 8_000);

    host.uninstall(ACTIONS_ID, false).expect("keep data");
    assert_eq!(
        host.storage_get(ACTIONS_ID, "lastTitle").as_deref(),
        Some("Sakura")
    );
    host.install_unpacked(&actions, false, &[])
        .expect("reinstall");
    host.uninstall(ACTIONS_ID, true).expect("remove data");
    assert!(host.storage_get(ACTIONS_ID, "lastTitle").is_none());
    assert_eq!(
        host.storage_get(SAKURA_ID, "lastTitle").as_deref(),
        Some("Night")
    );
    assert_not_hostile(&host);
}
