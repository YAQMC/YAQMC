use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::{
    lyrics_surface::{LyricsSurfaceManager, SurfaceInteraction, SurfaceKind},
    storage::StorageService,
};

use yaqmc_core::app_preferences as core;

pub use core::ManagedBackgroundImage;

struct TauriPreferencesRepository<'a> {
    storage: &'a StorageService,
}

impl core::PreferencesRepository for TauriPreferencesRepository<'_> {
    fn load_preferences(&self) -> Result<Option<String>, String> {
        self.storage
            .get_setting(core::PREFERENCES_KEY)
            .map_err(|error| error.to_string())
    }

    fn update_preferences<F>(&self, update: F) -> Result<String, String>
    where
        F: FnOnce(Option<String>) -> String,
    {
        self.storage
            .update_setting(core::PREFERENCES_KEY, update)
            .map_err(|error| error.to_string())
    }
}

struct TauriPreferenceChangeSink<'a> {
    app: &'a AppHandle,
}

impl core::PreferencesChangeSink for TauriPreferenceChangeSink<'_> {
    fn preferences_changed(&self, value: &str) {
        let _ = self.app.emit("preferences://changed", value);
    }
}

pub fn get_preferences(storage: &StorageService) -> Result<Option<String>, String> {
    core::get_preferences(&TauriPreferencesRepository { storage })
}

pub fn close_hides_to_tray(storage: &StorageService) -> bool {
    core::close_hides_to_tray(&TauriPreferencesRepository { storage })
}

pub fn global_shortcuts_enabled(storage: &StorageService) -> bool {
    core::global_shortcuts_enabled(&TauriPreferencesRepository { storage })
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
        let persisted_locked = core::surface_interaction(&document, kind.value()).as_deref()
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

pub fn unlock_lyrics_surface(
    app: &AppHandle,
    storage: &StorageService,
    manager: &LyricsSurfaceManager,
    kind: SurfaceKind,
) -> Result<(), String> {
    let document = get_preferences(storage)?.unwrap_or_else(|| r#"{"version":2}"#.to_owned());
    let previous = manager.interaction(kind);
    if previous != SurfaceInteraction::Interactive {
        manager.set_interaction(app, kind, SurfaceInteraction::Interactive)?;
    }
    match set_surface_interaction(
        app,
        storage,
        kind.value(),
        SurfaceInteraction::Interactive.value(),
        document,
    ) {
        Ok(_) => Ok(()),
        Err(error) => {
            if previous != SurfaceInteraction::Interactive {
                let _ = manager.set_interaction(app, kind, previous);
            }
            Err(error)
        }
    }
}

pub fn set_preferences(
    app: &AppHandle,
    storage: &StorageService,
    value: String,
) -> Result<(), String> {
    core::set_preferences(
        &TauriPreferencesRepository { storage },
        &TauriPreferenceChangeSink { app },
        value,
    )
}

pub fn set_surface_interaction(
    app: &AppHandle,
    storage: &StorageService,
    kind: &str,
    interaction: &str,
    fallback: String,
) -> Result<String, String> {
    core::set_surface_interaction(
        &TauriPreferencesRepository { storage },
        &TauriPreferenceChangeSink { app },
        kind,
        interaction,
        fallback,
    )
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
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    core::persist_background(&source, &data_root)
        .await
        .map(Some)
}

pub async fn load_background(
    app: &AppHandle,
    reference: String,
) -> Result<Option<ManagedBackgroundImage>, String> {
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    core::load_background(&data_root, &reference).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_adapter_keeps_safe_defaults_when_preferences_are_missing() {
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
