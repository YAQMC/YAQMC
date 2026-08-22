//! PLUG-04: Scene API v2 demo plugin automated coverage.
//!
//! Parses unpacked `examples/plugins/scene-pack` (Aurora / Vinyl glow), asserts
//! the scene JSON fields the lyrics runtime expects, and register/list/unregister
//! against a temp `ExtensionHost` root. Does not start Electron, enable hostile
//! fixtures, or claim the lyrics GUI scene picker.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use tempfile::TempDir;
use yaqmc_core::plugin::host::ExtensionHost;
use yaqmc_core::plugin::package::inspect_package;
use yaqmc_core::plugin::{PluginManifest, PluginStatus};

const SCENES_ID: &str = "dev.yaqmc.example.scenes";
const HOSTILE_ID: &str = "dev.yaqmc.test.hostile";
const SCENE_WIDGETS: [&str; 5] = ["background", "artwork", "metadata", "lyrics", "transport"];

fn examples_plugins() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins")
}

fn scene_pack() -> PathBuf {
    examples_plugins().join("scene-pack")
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

fn read_scene_json(name: &str) -> serde_json::Value {
    let path = scene_pack().join("scenes").join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| {
        panic!("read {}: {error}", path.display());
    });
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        panic!("parse {}: {error}", path.display());
    })
}

fn assert_scene_runtime_fields(
    definition: &serde_json::Value,
    expected_id: &str,
    expected_layout: &str,
) {
    assert_eq!(definition["schemaVersion"], 2, "Scene API v2 schemaVersion");
    assert_eq!(definition["id"], expected_id);
    let name = definition["name"].as_str().unwrap_or_default();
    assert!(!name.is_empty(), "scene name");
    assert_eq!(definition["layout"], expected_layout);
    assert!(
        definition["typography"]["fontScale"].as_f64().is_some(),
        "typography.fontScale"
    );
    assert!(
        definition["typography"]["lineHeight"].as_f64().is_some(),
        "typography.lineHeight"
    );
    assert!(
        definition["artwork"]["style"].as_str().is_some(),
        "artwork.style"
    );
    assert!(
        definition["background"]["fit"].as_str().is_some(),
        "background.fit"
    );
    assert!(
        definition["background"]["fallbackColor"]
            .as_str()
            .is_some_and(|color| color.starts_with('#') && color.len() == 7),
        "background.fallbackColor"
    );

    let scene = &definition["scene"];
    assert!(scene.is_object(), "scene widget graph");
    for widget in SCENE_WIDGETS {
        let node = &scene[widget];
        assert_eq!(node["id"], widget, "{widget} id");
        assert_eq!(node["kind"], widget, "{widget} kind");
        assert!(node["zIndex"].is_number(), "{widget} zIndex");
        assert!(node["visible"].is_boolean(), "{widget} visible");
        assert!(node["locked"].is_boolean(), "{widget} locked");
    }

    let background = &scene["background"];
    assert!(background["source"].is_string(), "background.source");
    assert!(background["fit"].is_string(), "background.fit");
    assert!(background["opacity"].is_number(), "background.opacity");
    assert!(background["influence"].is_number(), "background.influence");
    assert!(background["blur"].is_number(), "background.blur");

    for widget in ["artwork", "metadata", "lyrics", "transport"] {
        let node = &scene[widget];
        for key in ["x", "y", "width", "height"] {
            assert!(node[key].is_number(), "{widget}.{key}");
        }
        assert!(node["anchor"].is_string(), "{widget}.anchor");
    }
    assert!(scene["artwork"]["renderer"].is_string(), "artwork.renderer");
    assert!(
        scene["lyrics"]["followAnchor"].is_number(),
        "lyrics.followAnchor"
    );
    assert!(scene["transport"]["align"].is_string(), "transport.align");
}

#[test]
fn scene_pack_manifest_and_scene_json_parse() {
    let root = scene_pack();
    assert_example_dir(&root);

    let manifest_bytes = std::fs::read(root.join("manifest.json")).expect("scene-pack manifest");
    let manifest = PluginManifest::parse(&manifest_bytes).expect("scene-pack manifest parses");
    assert_eq!(manifest.id, SCENES_ID);
    assert_ne!(manifest.id, HOSTILE_ID);
    assert_eq!(manifest.name, "Lyrics scenes");
    assert_eq!(manifest.version, "1.0.0");
    assert_eq!(
        manifest.entrypoints.scenes,
        vec![
            "scenes/aurora.scene.json".to_owned(),
            "scenes/vinyl-glow.scene.json".to_owned(),
        ]
    );
    assert!(manifest.entrypoints.styles.is_empty());
    assert!(manifest.entrypoints.script.is_none());
    assert!(manifest
        .permissions
        .iter()
        .any(|value| value == "scene.register"));
    assert!(manifest
        .requested_permission_keys()
        .iter()
        .any(|value| value == "scene.register"));

    let inspection = inspect_package(&root).expect("scene-pack inspects unpacked");
    assert_eq!(inspection.manifest.id, SCENES_ID);
    assert_eq!(inspection.manifest.entrypoints.scenes.len(), 2);
    let files: BTreeSet<_> = inspection
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert!(files.contains("manifest.json"));
    assert!(files.contains("scenes/aurora.scene.json"));
    assert!(files.contains("scenes/vinyl-glow.scene.json"));
    assert!(files.contains("scenes/aurora.css"));
    assert!(files.contains("scenes/vinyl-glow.css"));

    let aurora = read_scene_json("aurora.scene.json");
    assert_scene_runtime_fields(&aurora, "aurora", "full");
    assert_eq!(aurora["artwork"]["style"], "square");
    assert_eq!(aurora["scene"]["artwork"]["renderer"], "rounded");
    let extras = aurora["scene"]["extras"].as_array().expect("aurora extras");
    assert_eq!(extras.len(), 1);
    assert_eq!(extras[0]["id"], "now-playing-label");
    assert_eq!(extras[0]["kind"], "text");
    assert_eq!(extras[0]["bind"], "track.title");

    let vinyl = read_scene_json("vinyl-glow.scene.json");
    assert_scene_runtime_fields(&vinyl, "vinyl-glow", "vinyl");
    assert_eq!(vinyl["artwork"]["style"], "vinyl");
    assert_eq!(vinyl["scene"]["artwork"]["renderer"], "vinyl");
}

#[test]
fn scene_pack_register_list_unregister_on_temp_host() {
    let root = scene_pack();
    assert_example_dir(&root);

    let (_temp, host) = open_host();
    let denied = host
        .install_unpacked(&root, true, &["scene.register".into()])
        .expect_err("unpacked install needs Developer Mode");
    assert!(denied.to_string().contains("Developer Mode"), "{denied}");
    assert!(host.list().is_empty());

    host.set_developer_mode(true)
        .expect("developer mode enables");
    let installed = host
        .install_unpacked(&root, true, &["scene.register".into()])
        .expect("scene-pack installs unpacked");
    assert_eq!(installed.id, SCENES_ID);
    assert!(installed.enabled);
    assert_eq!(installed.status, PluginStatus::Active);
    assert_eq!(installed.entrypoints.scenes, 2);
    assert!(installed
        .granted_permissions
        .iter()
        .any(|value| value == "scene.register"));
    assert_not_hostile(&host);

    let listed = host.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, SCENES_ID);
    assert_eq!(listed[0].status, PluginStatus::Active);

    let resources = host.active_resources();
    assert!(!resources.safe_mode);
    assert_eq!(resources.scenes.len(), 2);
    let ids: Vec<_> = resources
        .scenes
        .iter()
        .map(|scene| scene.scene_id.as_str())
        .collect();
    assert_eq!(ids, vec!["aurora", "vinyl-glow"]);
    for scene in &resources.scenes {
        assert_eq!(scene.plugin_id, SCENES_ID);
        assert_eq!(scene.plugin_name, "Lyrics scenes");
        assert!(
            scene
                .css
                .as_deref()
                .is_some_and(|css| css.contains("[data-scene-widget")),
            "scene {} css",
            scene.scene_id
        );
        let expected_layout = if scene.scene_id == "aurora" {
            "full"
        } else {
            "vinyl"
        };
        assert_scene_runtime_fields(&scene.definition, &scene.scene_id, expected_layout);
    }

    let disabled = host
        .set_enabled(SCENES_ID, false)
        .expect("unregister/disable");
    assert!(!disabled.enabled);
    assert_eq!(disabled.status, PluginStatus::Disabled);
    assert!(host.active_resources().scenes.is_empty());
    assert_eq!(host.list().len(), 1);

    let enabled = host.set_enabled(SCENES_ID, true).expect("re-register");
    assert!(enabled.enabled);
    assert_eq!(host.active_resources().scenes.len(), 2);

    host.uninstall(SCENES_ID, true).expect("uninstall");
    assert!(host.list().is_empty());
    assert!(host.active_resources().scenes.is_empty());
    assert_not_hostile(&host);
}
