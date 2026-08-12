use crate::player::PlayerService;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const SHORTCUTS: [&str; 3] = [
    "control+alt+Space",
    "control+alt+ArrowLeft",
    "control+alt+ArrowRight",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutAction {
    Toggle,
    Previous,
    Next,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIntegrationStatus {
    pub tray_available: bool,
    pub tray_error: Option<String>,
    pub global_shortcuts_supported: bool,
    pub global_shortcuts_enabled: bool,
    pub global_shortcuts: Vec<&'static str>,
    pub shortcut_error: Option<String>,
}

pub struct DesktopIntegration {
    status: Mutex<DesktopIntegrationStatus>,
}

impl DesktopIntegration {
    pub fn start(app: &AppHandle, player: Arc<PlayerService>) -> Arc<Self> {
        let supported = global_shortcuts_supported(app);
        let integration = Arc::new(Self {
            status: Mutex::new(DesktopIntegrationStatus {
                tray_available: false,
                tray_error: None,
                global_shortcuts_supported: supported,
                global_shortcuts_enabled: false,
                global_shortcuts: SHORTCUTS.to_vec(),
                shortcut_error: None,
            }),
        });
        match create_tray(app, player) {
            Ok(()) => {
                integration.with_status(|status| status.tray_available = true);
                tracing::info!(target: "tray", "system tray ready");
            }
            Err(error) => {
                tracing::warn!(target: "tray", error = %error, "system tray unavailable");
                integration.with_status(|status| status.tray_error = Some(error));
            }
        }
        integration
    }

    pub fn status(&self) -> DesktopIntegrationStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn set_shortcuts_enabled(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        let supported = self.status().global_shortcuts_supported;
        if !supported {
            let error = "configurable global shortcuts are unavailable on the active native Wayland backend; use MPRIS media keys".to_owned();
            self.with_status(|status| {
                status.global_shortcuts_enabled = false;
                status.shortcut_error = enabled.then(|| error.clone());
            });
            return if enabled { Err(error) } else { Ok(()) };
        }

        let manager = app.global_shortcut();
        for shortcut in SHORTCUTS {
            if manager.is_registered(shortcut) {
                manager
                    .unregister(shortcut)
                    .map_err(|error| error.to_string())?;
            }
        }
        if !enabled {
            self.with_status(|status| {
                status.global_shortcuts_enabled = false;
                status.shortcut_error = None;
            });
            tracing::info!(target: "shortcut", enabled = false, "global shortcuts updated");
            return Ok(());
        }

        let mut registered = Vec::new();
        for shortcut in SHORTCUTS {
            if let Err(error) = manager.register(shortcut) {
                for registered_shortcut in registered {
                    let _ = manager.unregister(registered_shortcut);
                }
                let message = format!("shortcut conflict for {shortcut}: {error}");
                self.with_status(|status| {
                    status.global_shortcuts_enabled = false;
                    status.shortcut_error = Some(message.clone());
                });
                tracing::warn!(target: "shortcut", shortcut, error = %error, "global shortcut registration failed");
                return Err(message);
            }
            registered.push(shortcut);
        }
        self.with_status(|status| {
            status.global_shortcuts_enabled = true;
            status.shortcut_error = None;
        });
        tracing::info!(target: "shortcut", enabled = true, "global shortcuts updated");
        Ok(())
    }

    fn with_status(&self, update: impl FnOnce(&mut DesktopIntegrationStatus)) {
        update(
            &mut self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
    }
}

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let player = app.try_state::<Arc<PlayerService>>().map(|state| Arc::clone(state.inner()));
            let Some(player) = player else {
                return;
            };
            let Some(action) = shortcut_action(shortcut.key) else {
                return;
            };
            tauri::async_runtime::spawn(async move {
                let result = match action {
                    ShortcutAction::Toggle => player.toggle().await,
                    ShortcutAction::Previous => player.previous().await,
                    ShortcutAction::Next => player.next().await,
                };
                if let Err(error) = result {
                    tracing::debug!(target: "shortcut", error = %error, "shortcut command rejected");
                }
            });
        })
        .build()
}

fn shortcut_action(key: tauri_plugin_global_shortcut::Code) -> Option<ShortcutAction> {
    use tauri_plugin_global_shortcut::Code;
    match key {
        Code::Space => Some(ShortcutAction::Toggle),
        Code::ArrowLeft => Some(ShortcutAction::Previous),
        Code::ArrowRight => Some(ShortcutAction::Next),
        _ => None,
    }
}

fn create_tray(app: &AppHandle, player: Arc<PlayerService>) -> Result<(), String> {
    let menu = MenuBuilder::new(app)
        .text("show", "Show YAQMC")
        .separator()
        .text("play-pause", "Play / Pause")
        .text("previous", "Previous")
        .text("next", "Next")
        .separator()
        .text("unlock-lyrics", "Unlock lyric surfaces")
        .separator()
        .text("quit", "Quit")
        .build()
        .map_err(|error| error.to_string())?;
    let menu_player = Arc::clone(&player);
    let mut builder = TrayIconBuilder::with_id("yaqmc-tray")
        .menu(&menu)
        .tooltip("YAQMC")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            "unlock-lyrics" => unlock_lyric_surfaces(app),
            action => dispatch_tray_action(Arc::clone(&menu_player), action),
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app).map_err(|error| error.to_string())?;
    Ok(())
}

fn unlock_lyric_surfaces(app: &AppHandle) {
    let storage = app
        .try_state::<Arc<crate::storage::StorageService>>()
        .map(|state| Arc::clone(state.inner()));
    let manager = app
        .try_state::<Arc<crate::lyrics_surface::LyricsSurfaceManager>>()
        .map(|state| Arc::clone(state.inner()));
    let (Some(storage), Some(manager)) = (storage, manager) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::app_preferences::unlock_all_lyrics_surfaces(&app, &storage, &manager) {
            Ok(unlocked) => {
                tracing::info!(target: "tray", unlocked, "lyric surfaces unlocked from tray recovery action");
                let _ = app.emit("lyrics://surfaces-unlocked", unlocked);
            }
            Err(error) => {
                tracing::warn!(target: "tray", error = %error, "tray lyric-surface recovery failed");
                show_main_window(&app);
                let _ = app.emit("app://open-settings", ());
            }
        }
    });
}

fn dispatch_tray_action(player: Arc<PlayerService>, action: &str) {
    let action = action.to_owned();
    tauri::async_runtime::spawn(async move {
        let result = match action.as_str() {
            "play-pause" => player.toggle().await,
            "previous" => player.previous().await,
            "next" => player.next().await,
            _ => return,
        };
        if let Err(error) = result {
            tracing::debug!(target: "tray", action, error = %error, "tray command rejected");
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn global_shortcuts_supported(app: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("DISPLAY").is_some()
            && crate::platform::display_backend(app) != "wayland-native"
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::Code;

    #[test]
    fn shortcut_keys_map_to_exact_player_commands() {
        assert_eq!(shortcut_action(Code::Space), Some(ShortcutAction::Toggle));
        assert_eq!(
            shortcut_action(Code::ArrowLeft),
            Some(ShortcutAction::Previous)
        );
        assert_eq!(
            shortcut_action(Code::ArrowRight),
            Some(ShortcutAction::Next)
        );
        assert_eq!(shortcut_action(Code::KeyP), None);
    }

    #[test]
    fn tray_unlock_recovery_is_dispatched_off_the_window_event_thread() {
        let source = include_str!("desktop_integration.rs");
        let block = source
            .split_once("fn unlock_lyric_surfaces(app: &AppHandle) {")
            .and_then(|(_, remainder)| remainder.split_once("\nfn dispatch_tray_action"))
            .map(|(block, _)| block)
            .expect("tray unlock function source block");

        assert!(
            block.contains("tauri::async_runtime::spawn"),
            "tray recovery must not create or close WebViews on the tray event thread"
        );
    }
}
