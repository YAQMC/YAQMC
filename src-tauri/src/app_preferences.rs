use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::lyrics_surface::{LyricsSurfaceManager, SurfaceInteraction, SurfaceKind};
use crate::storage::StorageService;

pub const PREFERENCES_KEY: &str = "ui-preferences-v1";
const MAX_PREFERENCES_BYTES: usize = 128 * 1024;
const MAX_BACKGROUND_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedBackgroundImage {
    pub reference: String,
    pub data_uri: String,
}

pub fn get_preferences(storage: &StorageService) -> Result<Option<String>, String> {
    storage
        .get_setting(PREFERENCES_KEY)
        .map_err(|error| error.to_string())
}

pub fn close_hides_to_tray(storage: &StorageService) -> bool {
    preference_system_value(storage, "closeBehavior")
        .and_then(|value| value.as_str().map(str::to_owned))
        .as_deref()
        != Some("quit")
}

pub fn global_shortcuts_enabled(storage: &StorageService) -> bool {
    preference_system_value(storage, "globalShortcutsEnabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

pub fn unlock_all_lyrics_surfaces(
    app: &AppHandle,
    storage: &StorageService,
    manager: &LyricsSurfaceManager,
) -> Result<usize, String> {
    let mut document = get_preferences(storage)?.unwrap_or_else(|| r#"{"version":2}"#.to_owned());
    let mut unlocked = 0;
    for kind in [SurfaceKind::Desktop, SurfaceKind::Island] {
        let native_locked = manager.interaction(kind) == SurfaceInteraction::PassiveLocked;
        let persisted_locked = surface_interaction(&document, kind.value()).as_deref()
            == Some(SurfaceInteraction::PassiveLocked.value());
        if !native_locked && !persisted_locked {
            continue;
        }
        if native_locked {
            manager.set_interaction(app, kind, SurfaceInteraction::Interactive)?;
        }
        match set_surface_interaction(
            app,
            storage,
            kind.value(),
            SurfaceInteraction::Interactive.value(),
            document,
        ) {
            Ok(next) => {
                document = next;
                unlocked += 1;
            }
            Err(error) => {
                if native_locked {
                    let _ = manager.set_interaction(app, kind, SurfaceInteraction::PassiveLocked);
                }
                return Err(error);
            }
        }
    }
    Ok(unlocked)
}

fn preference_system_value(storage: &StorageService, key: &str) -> Option<serde_json::Value> {
    let value = storage.get_setting(PREFERENCES_KEY).ok()??;
    serde_json::from_str::<serde_json::Value>(&value)
        .ok()?
        .get("system")?
        .get(key)
        .cloned()
}

pub fn set_preferences(
    app: &AppHandle,
    storage: &StorageService,
    value: String,
) -> Result<(), String> {
    validate_preferences(&value)?;
    let stored = storage
        .update_setting(PREFERENCES_KEY, |current| {
            preserve_surface_interactions(current.as_deref(), &value)
        })
        .map_err(|error| error.to_string())?;
    let _ = app.emit("preferences://changed", &stored);
    Ok(())
}

pub fn set_surface_interaction(
    app: &AppHandle,
    storage: &StorageService,
    kind: &str,
    interaction: &str,
    fallback: String,
) -> Result<String, String> {
    validate_preferences(&fallback)?;
    if !matches!(kind, "desktop" | "island") {
        return Err("unknown lyric surface".to_owned());
    }
    if !matches!(interaction, "interactive" | "passive-locked") {
        return Err("unknown lyric surface interaction".to_owned());
    }
    let fallback = patch_surface_interaction(&fallback, kind, interaction)?;
    let stored = storage
        .update_setting(PREFERENCES_KEY, |current| {
            current
                .as_deref()
                .filter(|value| document_version(value) == Some(2))
                .and_then(|value| patch_surface_interaction(value, kind, interaction).ok())
                .unwrap_or_else(|| fallback.clone())
        })
        .map_err(|error| error.to_string())?;
    let _ = app.emit("preferences://changed", &stored);
    Ok(stored)
}

fn preserve_surface_interactions(current: Option<&str>, incoming: &str) -> String {
    let Some(current) = current.filter(|value| document_version(value) == Some(2)) else {
        return incoming.to_owned();
    };
    let mut merged = incoming.to_owned();
    for kind in ["desktop", "island"] {
        let Some(interaction) = surface_interaction(current, kind) else {
            continue;
        };
        if let Ok(next) = patch_surface_interaction(&merged, kind, &interaction) {
            merged = next;
        }
    }
    merged
}

fn document_version(value: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(value)
        .ok()?
        .get("version")?
        .as_u64()
}

fn surface_interaction(value: &str, kind: &str) -> Option<String> {
    let document = serde_json::from_str::<serde_json::Value>(value).ok()?;
    let interaction = document
        .get("surfaces")?
        .get(kind)?
        .get("interaction")?
        .as_str()?;
    matches!(interaction, "interactive" | "passive-locked").then(|| interaction.to_owned())
}

fn patch_surface_interaction(value: &str, kind: &str, interaction: &str) -> Result<String, String> {
    let mut document: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| "preference document is not valid JSON".to_owned())?;
    let object = document
        .as_object_mut()
        .ok_or_else(|| "preference document must be an object".to_owned())?;
    object.insert("version".to_owned(), serde_json::Value::from(2));
    let surfaces = object
        .entry("surfaces")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "preference surfaces must be an object".to_owned())?;
    let surface = surfaces
        .entry(kind)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "lyric surface preferences must be an object".to_owned())?;
    surface.insert(
        "interaction".to_owned(),
        serde_json::Value::String(interaction.to_owned()),
    );
    surface.remove("locked");
    surface.remove("clickThrough");
    serde_json::to_string(&document)
        .map_err(|_| "preference document could not be saved".to_owned())
}

fn validate_preferences(value: &str) -> Result<(), String> {
    if value.len() > MAX_PREFERENCES_BYTES {
        return Err("preference document is too large".to_owned());
    }
    let document: serde_json::Value =
        serde_json::from_str(value).map_err(|_| "preference document is not valid JSON")?;
    let object = document
        .as_object()
        .ok_or_else(|| "preference document must be an object".to_owned())?;
    if !matches!(
        object.get("version").and_then(serde_json::Value::as_u64),
        Some(1 | 2)
    ) {
        return Err("unsupported preference document version".to_owned());
    }
    Ok(())
}

pub async fn pick_background(app: AppHandle) -> Result<Option<ManagedBackgroundImage>, String> {
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("Images", &["png", "jpg", "jpeg", "webp", "bmp", "gif"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let source = selected.into_path().map_err(|error| error.to_string())?;
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|_| "selected image is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_BACKGROUND_BYTES {
        return Err("selected image must be a file no larger than 24 MiB".to_owned());
    }
    let bytes = tokio::fs::read(&source)
        .await
        .map_err(|_| "selected image could not be read".to_owned())?;
    let (extension, mime) =
        detect_image(&bytes).ok_or_else(|| "selected file is not a supported image".to_owned())?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("backgrounds");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "managed background directory could not be created".to_owned())?;
    remove_previous_backgrounds(&directory).await;
    let filename = format!("custom-background.{extension}");
    let target = directory.join(&filename);
    tokio::fs::write(&target, &bytes)
        .await
        .map_err(|_| "selected image could not be copied".to_owned())?;
    Ok(Some(ManagedBackgroundImage {
        reference: format!("backgrounds/{filename}"),
        data_uri: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
    }))
}

pub async fn load_background(
    app: &AppHandle,
    reference: String,
) -> Result<Option<ManagedBackgroundImage>, String> {
    if !is_managed_reference(&reference) {
        return Err("background reference is outside the managed directory".to_owned());
    }
    let target = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(Path::new(&reference));
    let bytes = match tokio::fs::read(&target).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("managed background image could not be read".to_owned()),
    };
    if bytes.len() as u64 > MAX_BACKGROUND_BYTES {
        return Err("managed background image is too large".to_owned());
    }
    let (_, mime) = detect_image(&bytes).ok_or("managed background is not a supported image")?;
    Ok(Some(ManagedBackgroundImage {
        reference,
        data_uri: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
    }))
}

fn is_managed_reference(reference: &str) -> bool {
    let path = Path::new(reference);
    let components = path.components().collect::<Vec<_>>();
    if components.len() != 2
        || components[0] != Component::Normal("backgrounds".as_ref())
        || !matches!(components[1], Component::Normal(_))
    {
        return false;
    }
    let Some(filename) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    filename.starts_with("custom-background.")
        && matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("png" | "jpg" | "webp" | "bmp" | "gif")
        )
}

fn detect_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("png", "image/png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("jpg", "image/jpeg"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else if bytes.starts_with(b"BM") {
        Some(("bmp", "image/bmp"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else {
        None
    }
}

async fn remove_previous_backgrounds(directory: &PathBuf) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let filename = entry.file_name();
        if filename
            .to_str()
            .is_some_and(|name| name.starts_with("custom-background."))
        {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_require_a_small_versioned_object() {
        assert!(validate_preferences(r#"{"version":1,"locale":"zh-CN"}"#).is_ok());
        assert!(validate_preferences(r#"{"version":2}"#).is_ok());
        assert!(validate_preferences(r#"{"version":3}"#).is_err());
        assert!(validate_preferences("[]").is_err());
    }

    #[test]
    fn generic_preference_writes_cannot_relock_or_unlock_surfaces() {
        let current = r#"{"version":2,"surfaces":{"desktop":{"interaction":"passive-locked","enabled":true},"island":{"interaction":"interactive","enabled":true}}}"#;
        let incoming = r#"{"version":2,"surfaces":{"desktop":{"interaction":"interactive","enabled":false},"island":{"interaction":"passive-locked","enabled":false}}}"#;
        let merged = preserve_surface_interactions(Some(current), incoming);
        let document: serde_json::Value = serde_json::from_str(&merged).expect("valid preferences");
        assert_eq!(
            document["surfaces"]["desktop"]["interaction"],
            "passive-locked"
        );
        assert_eq!(document["surfaces"]["island"]["interaction"], "interactive");
        assert_eq!(document["surfaces"]["desktop"]["enabled"], false);
    }

    #[test]
    fn dedicated_interaction_patch_changes_only_the_requested_surface() {
        let value = r#"{"version":2,"surfaces":{"desktop":{"interaction":"passive-locked","locked":true},"island":{"interaction":"passive-locked"}}}"#;
        let patched = patch_surface_interaction(value, "desktop", "interactive")
            .expect("interaction should be patched");
        let document: serde_json::Value =
            serde_json::from_str(&patched).expect("valid preferences");
        assert_eq!(
            document["surfaces"]["desktop"]["interaction"],
            "interactive"
        );
        assert!(document["surfaces"]["desktop"].get("locked").is_none());
        assert_eq!(
            document["surfaces"]["island"]["interaction"],
            "passive-locked"
        );
    }

    #[test]
    fn managed_references_cannot_escape_the_background_directory() {
        assert!(is_managed_reference("backgrounds/custom-background.png"));
        assert!(!is_managed_reference("../custom-background.png"));
        assert!(!is_managed_reference("backgrounds/other.png"));
        assert!(!is_managed_reference(
            "backgrounds/nested/custom-background.png"
        ));
    }

    #[test]
    fn image_type_is_verified_by_content_not_extension() {
        assert_eq!(
            detect_image(b"\x89PNG\r\n\x1a\nrest"),
            Some(("png", "image/png"))
        );
        assert_eq!(detect_image(b"not an image"), None);
    }

    #[test]
    fn missing_system_preferences_keep_safe_desktop_defaults() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = StorageService::open(
            directory.path().join("data"),
            directory.path().join("cache"),
        )
        .expect("storage");
        assert!(close_hides_to_tray(&storage));
        assert!(!global_shortcuts_enabled(&storage));
    }
}
