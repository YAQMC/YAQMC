#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;

use crate::storage::StorageService;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const GEOMETRY_PREFIX: &str = "lyrics-surface-geometry:";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceKind {
    Desktop,
    Island,
}

impl SurfaceKind {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "desktop" => Ok(Self::Desktop),
            "island" => Ok(Self::Island),
            _ => Err("unknown lyric surface".to_owned()),
        }
    }

    pub(crate) fn value(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Island => "island",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Desktop => "lyrics-desktop",
            Self::Island => "lyrics-island",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceInteraction {
    Interactive,
    PassiveLocked,
}

impl SurfaceInteraction {
    pub(crate) fn value(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::PassiveLocked => "passive-locked",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SurfaceInteractionState {
    Hidden,
    VisibleInteractive,
    VisiblePassiveLocked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NativeInteractionPolicy {
    focusable: bool,
    ignore_cursor_events: bool,
    resizable: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceRuntimeConfig {
    pub enabled: bool,
    pub always_on_top: bool,
    pub interaction: SurfaceInteraction,
    pub hide_in_fullscreen: bool,
    pub horizontal_position: f64,
    pub vertical_offset: f64,
    pub width: SurfaceWidth,
}

impl SurfaceRuntimeConfig {
    fn disabled(kind: SurfaceKind) -> Self {
        Self {
            enabled: false,
            always_on_top: true,
            interaction: SurfaceInteraction::Interactive,
            hide_in_fullscreen: true,
            horizontal_position: 0.0,
            vertical_offset: 24.0,
            width: if kind == SurfaceKind::Desktop {
                SurfaceWidth::Wide
            } else {
                SurfaceWidth::Regular
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceWidth {
    Compact,
    Regular,
    Wide,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SurfaceRuntimeMap {
    pub desktop: SurfaceRuntimeConfig,
    pub island: SurfaceRuntimeConfig,
}

impl Default for SurfaceRuntimeMap {
    fn default() -> Self {
        Self {
            desktop: SurfaceRuntimeConfig::disabled(SurfaceKind::Desktop),
            island: SurfaceRuntimeConfig::disabled(SurfaceKind::Island),
        }
    }
}

impl SurfaceRuntimeMap {
    fn get(&self, kind: SurfaceKind) -> &SurfaceRuntimeConfig {
        match kind {
            SurfaceKind::Desktop => &self.desktop,
            SurfaceKind::Island => &self.island,
        }
    }

    fn get_mut(&mut self, kind: SurfaceKind) -> &mut SurfaceRuntimeConfig {
        match kind {
            SurfaceKind::Desktop => &mut self.desktop,
            SurfaceKind::Island => &mut self.island,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SurfaceLifecycle {
    Absent,
    Close,
    Create,
    Update,
}

fn surface_lifecycle(window_exists: bool, enabled: bool) -> SurfaceLifecycle {
    match (window_exists, enabled) {
        (false, false) => SurfaceLifecycle::Absent,
        (true, false) => SurfaceLifecycle::Close,
        (false, true) => SurfaceLifecycle::Create,
        (true, true) => SurfaceLifecycle::Update,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCapabilities {
    pub desktop: bool,
    pub island: bool,
    pub platform: String,
    pub backend: String,
    pub reliable_always_on_top: bool,
    pub reliable_click_through: bool,
    pub reliable_global_positioning: bool,
    pub limitations: Vec<String>,
}

pub struct LyricsSurfaceManager {
    configs: RwLock<SurfaceRuntimeMap>,
    watcher_running: AtomicBool,
    fullscreen_active: AtomicBool,
}

impl LyricsSurfaceManager {
    pub fn new() -> Self {
        Self {
            configs: RwLock::new(SurfaceRuntimeMap::default()),
            watcher_running: AtomicBool::new(false),
            fullscreen_active: AtomicBool::new(false),
        }
    }

    pub fn capabilities(app: &AppHandle) -> SurfaceCapabilities {
        #[cfg(target_os = "linux")]
        let backend = crate::platform::display_backend(app);
        #[cfg(not(target_os = "linux"))]
        let backend = {
            let _ = app;
            std::env::consts::OS.to_owned()
        };
        let native_wayland = backend == "wayland-native";
        SurfaceCapabilities {
            desktop: true,
            island: true,
            platform: std::env::consts::OS.to_owned(),
            backend,
            reliable_always_on_top: !native_wayland,
            reliable_click_through: !native_wayland,
            reliable_global_positioning: !native_wayland,
            limitations: if native_wayland {
                vec!["Native Wayland does not guarantee absolute placement, click-through, or always-on-top overlay semantics.".to_owned()]
            } else {
                Vec::new()
            },
        }
    }

    pub async fn reconcile(
        self: &Arc<Self>,
        app: &AppHandle,
        storage: &Arc<StorageService>,
        next: SurfaceRuntimeMap,
    ) -> Result<SurfaceCapabilities, String> {
        let previous = self
            .configs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        *self
            .configs
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = next.clone();

        for kind in [SurfaceKind::Desktop, SurfaceKind::Island] {
            reconcile_window(
                app,
                storage,
                kind,
                previous.get(kind),
                next.get(kind),
                self.fullscreen_active.load(Ordering::Acquire),
            )?;
        }
        self.start_fullscreen_watcher(app.clone());
        Ok(Self::capabilities(app))
    }

    fn start_fullscreen_watcher(self: &Arc<Self>, app: AppHandle) {
        if self.watcher_running.swap(true, Ordering::AcqRel) {
            return;
        }
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(800));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(fullscreen) = platform_foreground_is_fullscreen() else {
                    continue;
                };
                let previous = manager.fullscreen_active.swap(fullscreen, Ordering::AcqRel);
                if previous == fullscreen {
                    continue;
                }
                let configs = manager
                    .configs
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                for kind in [SurfaceKind::Desktop, SurfaceKind::Island] {
                    let config = configs.get(kind);
                    if !config.enabled || !config.hide_in_fullscreen {
                        continue;
                    }
                    if let Some(window) = app.get_webview_window(kind.label()) {
                        let _ = if fullscreen {
                            window.hide().map_err(|error| error.to_string())
                        } else {
                            apply_window_interaction(&window, kind, interaction_state(config))
                                .and_then(|()| window.show().map_err(|error| error.to_string()))
                        };
                    }
                }
            }
        });
    }

    pub fn close_all(&self, app: &AppHandle, storage: &Arc<StorageService>) {
        for kind in [SurfaceKind::Desktop, SurfaceKind::Island] {
            if let Some(window) = app.get_webview_window(kind.label()) {
                save_geometry(&window, storage, kind);
                let _ = window.close();
            }
        }
    }

    pub fn set_interaction(
        &self,
        app: &AppHandle,
        kind: SurfaceKind,
        interaction: SurfaceInteraction,
    ) -> Result<(), String> {
        let mut configs = self
            .configs
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let config = configs.get_mut(kind);
        config.interaction = interaction;
        if let Some(window) = app.get_webview_window(kind.label()) {
            apply_window_interaction(&window, kind, interaction_state(config))?;
        }
        Ok(())
    }

    pub fn interaction(&self, kind: SurfaceKind) -> SurfaceInteraction {
        self.configs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(kind)
            .interaction
    }

    pub fn reset_geometry(
        &self,
        app: &AppHandle,
        storage: &StorageService,
        kind: SurfaceKind,
    ) -> Result<(), String> {
        storage
            .remove_setting(&geometry_key(kind))
            .map_err(|error| error.to_string())?;
        let configs = self
            .configs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(window) = app.get_webview_window(kind.label()) {
            apply_default_geometry(&window, kind, configs.get(kind))?;
        }
        Ok(())
    }
}

fn interaction_state(config: &SurfaceRuntimeConfig) -> SurfaceInteractionState {
    if !config.enabled {
        SurfaceInteractionState::Hidden
    } else {
        match config.interaction {
            SurfaceInteraction::Interactive => SurfaceInteractionState::VisibleInteractive,
            SurfaceInteraction::PassiveLocked => SurfaceInteractionState::VisiblePassiveLocked,
        }
    }
}

fn native_interaction_policy(
    kind: SurfaceKind,
    state: SurfaceInteractionState,
) -> NativeInteractionPolicy {
    match state {
        SurfaceInteractionState::VisibleInteractive => NativeInteractionPolicy {
            focusable: true,
            ignore_cursor_events: false,
            resizable: kind == SurfaceKind::Desktop,
        },
        SurfaceInteractionState::Hidden | SurfaceInteractionState::VisiblePassiveLocked => {
            NativeInteractionPolicy {
                focusable: false,
                ignore_cursor_events: true,
                resizable: false,
            }
        }
    }
}

fn apply_window_interaction(
    window: &WebviewWindow,
    kind: SurfaceKind,
    state: SurfaceInteractionState,
) -> Result<(), String> {
    let policy = native_interaction_policy(kind, state);
    // Make passive surfaces non-activating before exposing click-through. Unlocking reverses
    // cursor handling first but deliberately never calls set_focus.
    if policy.ignore_cursor_events {
        window
            .set_resizable(policy.resizable)
            .map_err(|error| error.to_string())?;
        window
            .set_focusable(policy.focusable)
            .map_err(|error| error.to_string())?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
    } else {
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        window
            .set_focusable(policy.focusable)
            .map_err(|error| error.to_string())?;
        window
            .set_resizable(policy.resizable)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn reconcile_window(
    app: &AppHandle,
    storage: &Arc<StorageService>,
    kind: SurfaceKind,
    previous: &SurfaceRuntimeConfig,
    next: &SurfaceRuntimeConfig,
    fullscreen_active: bool,
) -> Result<(), String> {
    let existing = app.get_webview_window(kind.label());
    match surface_lifecycle(existing.is_some(), next.enabled) {
        SurfaceLifecycle::Absent => return Ok(()),
        SurfaceLifecycle::Close => {
            if let Some(window) = existing {
                save_geometry(&window, storage, kind);
                window.close().map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        SurfaceLifecycle::Create | SurfaceLifecycle::Update => {}
    }

    let created = existing.is_none();
    let window = if let Some(window) = existing {
        window
    } else {
        build_window(app, storage, kind, next)?
    };
    window
        .set_always_on_top(next.always_on_top)
        .map_err(|error| error.to_string())?;
    apply_window_interaction(&window, kind, interaction_state(next))?;

    let position_changed = previous.horizontal_position != next.horizontal_position
        || previous.vertical_offset != next.vertical_offset;
    let width_changed = previous.width != next.width;
    if !created && (position_changed || width_changed) && kind != SurfaceKind::Desktop {
        apply_default_geometry(&window, kind, next)?;
    }
    if fullscreen_active && next.hide_in_fullscreen {
        window.hide().map_err(|error| error.to_string())?;
    } else if created || !window.is_visible().unwrap_or(false) {
        window.show().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn build_window(
    app: &AppHandle,
    storage: &Arc<StorageService>,
    kind: SurfaceKind,
    config: &SurfaceRuntimeConfig,
) -> Result<WebviewWindow, String> {
    let (width, height) = logical_dimensions(kind, config.width);
    let interaction = native_interaction_policy(kind, interaction_state(config));
    let url = WebviewUrl::App(format!("index.html?surface={}", kind.value()).into());
    let window = WebviewWindowBuilder::new(app, kind.label(), url)
        .title("YAQMC Lyrics")
        .inner_size(width, height)
        .min_inner_size(
            if kind == SurfaceKind::Desktop {
                460.0
            } else {
                width
            },
            height,
        )
        .resizable(interaction.resizable)
        .decorations(false)
        .transparent(true)
        .always_on_top(config.always_on_top)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .focusable(interaction.focusable)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;

    if let Some(geometry) =
        load_geometry(storage, kind).filter(|geometry| geometry_is_visible(&window, geometry))
    {
        let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
        let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
    } else {
        apply_default_geometry(&window, kind, config)?;
    }
    attach_geometry_persistence(&window, Arc::clone(storage), kind, app.clone());
    apply_window_interaction(&window, kind, interaction_state(config))?;
    Ok(window)
}

fn geometry_is_visible(window: &WebviewWindow, geometry: &SurfaceGeometry) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.into_iter().any(|monitor| {
        let area = monitor.work_area();
        geometry_overlaps_work_area(
            geometry,
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        )
    })
}

fn geometry_overlaps_work_area(
    geometry: &SurfaceGeometry,
    area_x: i32,
    area_y: i32,
    area_width: u32,
    area_height: u32,
) -> bool {
    let right = geometry.x.saturating_add(geometry.width as i32);
    let bottom = geometry.y.saturating_add(geometry.height as i32);
    let area_right = area_x.saturating_add(area_width as i32);
    let area_bottom = area_y.saturating_add(area_height as i32);
    let overlap_width = right.min(area_right).saturating_sub(geometry.x.max(area_x));
    let overlap_height = bottom
        .min(area_bottom)
        .saturating_sub(geometry.y.max(area_y));
    overlap_width >= 80 && overlap_height >= 40
}

fn logical_dimensions(kind: SurfaceKind, width: SurfaceWidth) -> (f64, f64) {
    let width = match (kind, width) {
        (SurfaceKind::Desktop, SurfaceWidth::Compact) => 620.0,
        (SurfaceKind::Desktop, SurfaceWidth::Regular) => 780.0,
        (SurfaceKind::Desktop, SurfaceWidth::Wide) => 940.0,
        (SurfaceKind::Island, SurfaceWidth::Compact) => 420.0,
        (SurfaceKind::Island, SurfaceWidth::Regular) => 520.0,
        (SurfaceKind::Island, SurfaceWidth::Wide) => 640.0,
    };
    let height = match kind {
        SurfaceKind::Desktop => 190.0,
        SurfaceKind::Island => 156.0,
    };
    (width, height)
}

fn apply_default_geometry(
    window: &WebviewWindow,
    kind: SurfaceKind,
    config: &SurfaceRuntimeConfig,
) -> Result<(), String> {
    let monitor = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no display is available".to_owned())?;
    let scale = monitor.scale_factor();
    let (logical_width, logical_height) = logical_dimensions(kind, config.width);
    let width = (logical_width * scale).round().max(1.0) as u32;
    let height = (logical_height * scale).round().max(1.0) as u32;
    let work = monitor.work_area();
    let available_x = work.size.width.saturating_sub(width) as f64;
    let normalized_x = ((config.horizontal_position + 100.0) / 200.0).clamp(0.0, 1.0);
    let x = work.position.x + (available_x * normalized_x).round() as i32;
    let offset = (config.vertical_offset * scale).round() as i32;
    let y = match kind {
        SurfaceKind::Island => work.position.y.saturating_add(offset),
        SurfaceKind::Desktop => work
            .position
            .y
            .saturating_add(work.size.height.saturating_sub(height) as i32)
            .saturating_sub((72.0 * scale).round() as i32),
    };
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn geometry_key(kind: SurfaceKind) -> String {
    format!("{GEOMETRY_PREFIX}{}", kind.value())
}

fn load_geometry(storage: &StorageService, kind: SurfaceKind) -> Option<SurfaceGeometry> {
    storage
        .get_setting(&geometry_key(kind))
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str(&value).ok())
}

fn save_geometry(window: &WebviewWindow, storage: &StorageService, kind: SurfaceKind) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let geometry = SurfaceGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    if let Ok(value) = serde_json::to_string(&geometry) {
        let _ = storage.set_setting(&geometry_key(kind), &value);
    }
}

fn attach_geometry_persistence(
    window: &WebviewWindow,
    storage: Arc<StorageService>,
    kind: SurfaceKind,
    app: AppHandle,
) {
    let generation = Arc::new(AtomicU64::new(0));
    let tracked_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let current = generation.fetch_add(1, Ordering::AcqRel) + 1;
            let generation = Arc::clone(&generation);
            let storage = Arc::clone(&storage);
            let window = tracked_window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(350)).await;
                if generation.load(Ordering::Acquire) == current {
                    save_geometry(&window, &storage, kind);
                }
            });
        }
        WindowEvent::CloseRequested { .. } => {
            save_geometry(&tracked_window, &storage, kind);
            let _ = app.emit("lyrics://surface-closed", kind.value());
        }
        _ => {}
    });
}

#[cfg(target_os = "windows")]
fn platform_foreground_is_fullscreen() -> Option<bool> {
    windows::foreground_is_fullscreen()
}

#[cfg(target_os = "linux")]
fn platform_foreground_is_fullscreen() -> Option<bool> {
    linux::foreground_is_fullscreen()
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn platform_foreground_is_fullscreen() -> Option<bool> {
    None
}

pub fn surface_statuses(app: &AppHandle) -> HashMap<&'static str, bool> {
    [SurfaceKind::Desktop, SurfaceKind::Island]
        .into_iter()
        .map(|kind| (kind.value(), app.get_webview_window(kind.label()).is_some()))
        .collect()
}

pub fn close_surface(
    app: &AppHandle,
    storage: &StorageService,
    kind: SurfaceKind,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(kind.label()) {
        save_geometry(&window, storage, kind);
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_kind_parsing_rejects_unknown_window_labels() {
        assert_eq!(SurfaceKind::parse("desktop"), Ok(SurfaceKind::Desktop));
        assert_eq!(SurfaceKind::parse("island"), Ok(SurfaceKind::Island));
        assert!(SurfaceKind::parse("taskbar").is_err());
        assert!(SurfaceKind::parse("main").is_err());
    }

    #[test]
    fn legacy_taskbar_configuration_is_ignored_and_not_serialized() {
        let mut value = serde_json::to_value(SurfaceRuntimeMap::default()).expect("map serializes");
        value["taskbar"] = serde_json::json!({ "enabled": true });
        let migrated: SurfaceRuntimeMap = serde_json::from_value(value).expect("legacy map loads");
        let serialized = serde_json::to_value(migrated).expect("migrated map serializes");
        assert!(serialized.get("taskbar").is_none());
    }

    #[test]
    fn lifecycle_covers_enable_update_disable_and_absent_states() {
        assert_eq!(surface_lifecycle(false, false), SurfaceLifecycle::Absent);
        assert_eq!(surface_lifecycle(false, true), SurfaceLifecycle::Create);
        assert_eq!(surface_lifecycle(true, true), SurfaceLifecycle::Update);
        assert_eq!(surface_lifecycle(true, false), SurfaceLifecycle::Close);
    }

    #[test]
    fn runtime_configuration_preserves_passive_interaction() {
        let config: SurfaceRuntimeConfig = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "alwaysOnTop": false,
            "interaction": "passive-locked",
            "hideInFullscreen": true,
            "horizontalPosition": -25.0,
            "verticalOffset": 40.0,
            "width": "compact"
        }))
        .expect("valid configuration");
        assert!(config.enabled);
        assert_eq!(config.interaction, SurfaceInteraction::PassiveLocked);
        assert_eq!(config.width, SurfaceWidth::Compact);
    }

    #[test]
    fn interaction_state_maps_lock_to_complete_native_passivity() {
        let mut config = SurfaceRuntimeConfig::disabled(SurfaceKind::Desktop);
        assert_eq!(interaction_state(&config), SurfaceInteractionState::Hidden);
        config.interaction = SurfaceInteraction::PassiveLocked;
        assert_eq!(interaction_state(&config), SurfaceInteractionState::Hidden);
        config.interaction = SurfaceInteraction::Interactive;
        config.enabled = true;
        assert_eq!(
            interaction_state(&config),
            SurfaceInteractionState::VisibleInteractive
        );
        assert_eq!(
            native_interaction_policy(SurfaceKind::Desktop, interaction_state(&config)),
            NativeInteractionPolicy {
                focusable: true,
                ignore_cursor_events: false,
                resizable: true,
            }
        );
        config.interaction = SurfaceInteraction::PassiveLocked;
        assert_eq!(
            native_interaction_policy(SurfaceKind::Desktop, interaction_state(&config)),
            NativeInteractionPolicy {
                focusable: false,
                ignore_cursor_events: true,
                resizable: false,
            }
        );
    }

    #[test]
    fn saved_geometry_accepts_negative_monitor_coordinates_but_rejects_offscreen_windows() {
        let secondary_monitor = SurfaceGeometry {
            x: -1_800,
            y: 120,
            width: 900,
            height: 180,
        };
        assert!(geometry_overlaps_work_area(
            &secondary_monitor,
            -1_920,
            0,
            1_920,
            1_040
        ));
        let disconnected = SurfaceGeometry {
            x: 4_000,
            y: 4_000,
            width: 500,
            height: 120,
        };
        assert!(!geometry_overlaps_work_area(
            &disconnected,
            0,
            0,
            1_920,
            1_040
        ));
        assert_eq!(
            geometry_key(SurfaceKind::Island),
            "lyrics-surface-geometry:island"
        );
    }

    #[test]
    fn width_presets_keep_each_surface_compact() {
        assert_eq!(
            logical_dimensions(SurfaceKind::Desktop, SurfaceWidth::Wide),
            (940.0, 190.0)
        );
        assert_eq!(
            logical_dimensions(SurfaceKind::Island, SurfaceWidth::Compact),
            (420.0, 156.0)
        );
    }
}
