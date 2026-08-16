use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::path::{Component, Path};
use tokio::io::AsyncReadExt;

pub const PREFERENCES_KEY: &str = "ui-preferences-v1";
const MAX_PREFERENCES_BYTES: usize = 128 * 1024;
pub const MAX_BACKGROUND_BYTES: u64 = 24 * 1024 * 1024;

/// Narrow storage port. Its update callback must run inside the concrete store's
/// read-transform-write critical section.
pub trait PreferencesRepository {
    fn load_preferences(&self) -> Result<Option<String>, String>;

    fn update_preferences<F>(&self, update: F) -> Result<String, String>
    where
        F: FnOnce(Option<String>) -> String;
}

/// Host-owned best-effort notification boundary. A failed notification must not
/// turn a successfully persisted preference write into an error.
pub trait PreferencesChangeSink {
    fn preferences_changed(&self, value: &str);
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedBackgroundImage {
    pub reference: String,
    pub data_uri: String,
}

pub fn get_preferences<R: PreferencesRepository>(repository: &R) -> Result<Option<String>, String> {
    repository.load_preferences()
}

pub fn close_hides_to_tray<R: PreferencesRepository>(repository: &R) -> bool {
    preference_system_value(repository, "closeBehavior")
        .and_then(|value| value.as_str().map(str::to_owned))
        .as_deref()
        != Some("quit")
}

pub fn global_shortcuts_enabled<R: PreferencesRepository>(repository: &R) -> bool {
    preference_system_value(repository, "globalShortcutsEnabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn preference_system_value<R: PreferencesRepository>(
    repository: &R,
    key: &str,
) -> Option<serde_json::Value> {
    let value = repository.load_preferences().ok()??;
    serde_json::from_str::<serde_json::Value>(&value)
        .ok()?
        .get("system")?
        .get(key)
        .cloned()
}

pub fn set_preferences<R: PreferencesRepository, S: PreferencesChangeSink>(
    repository: &R,
    sink: &S,
    value: String,
) -> Result<(), String> {
    validate_preferences(&value)?;
    let stored = repository
        .update_preferences(|current| preserve_surface_interactions(current.as_deref(), &value))?;
    sink.preferences_changed(&stored);
    Ok(())
}

pub fn set_surface_interaction<R: PreferencesRepository, S: PreferencesChangeSink>(
    repository: &R,
    sink: &S,
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
    let stored = repository.update_preferences(|current| {
        current
            .as_deref()
            .filter(|value| document_version(value) == Some(2))
            .and_then(|value| patch_surface_interaction(value, kind, interaction).ok())
            .unwrap_or_else(|| fallback.clone())
    })?;
    sink.preferences_changed(&stored);
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

pub fn surface_interaction(value: &str, kind: &str) -> Option<String> {
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

pub async fn persist_background(
    source: &Path,
    data_root: &Path,
) -> Result<ManagedBackgroundImage, String> {
    let metadata = tokio::fs::metadata(source)
        .await
        .map_err(|_| "selected image is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > MAX_BACKGROUND_BYTES {
        return Err("selected image must be a file no larger than 24 MiB".to_owned());
    }
    let source_file = tokio::fs::File::open(source)
        .await
        .map_err(|_| "selected image could not be read".to_owned())?;
    let mut source_file = source_file.take(MAX_BACKGROUND_BYTES.saturating_add(1));
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    source_file
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "selected image could not be read".to_owned())?;
    if bytes.len() as u64 > MAX_BACKGROUND_BYTES {
        return Err("selected image must be a file no larger than 24 MiB".to_owned());
    }
    let (extension, mime) =
        detect_image(&bytes).ok_or_else(|| "selected file is not a supported image".to_owned())?;
    let directory = data_root.join("backgrounds");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "managed background directory could not be created".to_owned())?;
    remove_previous_backgrounds(&directory).await;
    let filename = format!("custom-background.{extension}");
    let target = directory.join(&filename);
    tokio::fs::write(&target, &bytes)
        .await
        .map_err(|_| "selected image could not be copied".to_owned())?;
    Ok(ManagedBackgroundImage {
        reference: format!("backgrounds/{filename}"),
        data_uri: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
    })
}

pub async fn load_background(
    data_root: &Path,
    reference: &str,
) -> Result<Option<ManagedBackgroundImage>, String> {
    if !is_managed_reference(reference) {
        return Err("background reference is outside the managed directory".to_owned());
    }
    let target = data_root.join(Path::new(reference));
    let target_file = match tokio::fs::File::open(&target).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("managed background image could not be read".to_owned()),
    };
    let mut target_file = target_file.take(MAX_BACKGROUND_BYTES.saturating_add(1));
    let mut bytes = Vec::new();
    target_file
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "managed background image could not be read".to_owned())?;
    if bytes.len() as u64 > MAX_BACKGROUND_BYTES {
        return Err("managed background image is too large".to_owned());
    }
    let (_, mime) = detect_image(&bytes).ok_or("managed background is not a supported image")?;
    Ok(Some(ManagedBackgroundImage {
        reference: reference.to_owned(),
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

async fn remove_previous_backgrounds(directory: &Path) {
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
    fn preferences_require_supported_object_versions_and_the_utf8_byte_cap() {
        assert!(validate_preferences(r#"{"version":1,"locale":"zh-CN"}"#).is_ok());
        assert!(validate_preferences(r#"{"version":2}"#).is_ok());
        assert!(validate_preferences(r#"{"version":3}"#).is_err());
        assert!(validate_preferences("[]").is_err());
        assert!(validate_preferences(&"x".repeat(MAX_PREFERENCES_BYTES + 1)).is_err());
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
        let value = r#"{"version":2,"surfaces":{"desktop":{"interaction":"passive-locked","locked":true,"clickThrough":true},"island":{"interaction":"passive-locked"}}}"#;
        let patched = patch_surface_interaction(value, "desktop", "interactive")
            .expect("interaction should be patched");
        let document: serde_json::Value =
            serde_json::from_str(&patched).expect("valid preferences");
        assert_eq!(
            document["surfaces"]["desktop"]["interaction"],
            "interactive"
        );
        assert!(document["surfaces"]["desktop"].get("locked").is_none());
        assert!(document["surfaces"]["desktop"]
            .get("clickThrough")
            .is_none());
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
}
