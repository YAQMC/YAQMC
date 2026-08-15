use crate::{
    command_guard::require_main_window,
    player::PlayerService,
    plugin::{
        host::{ActivePluginResources, ExtensionHost, PluginRecord},
        permissions::{parse_permission, PluginPermission},
        PluginDiagnostic,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type CommandResult<T> = Result<T, String>;

fn deny_if_not_main(window: &WebviewWindow) -> CommandResult<()> {
    require_main_window(window).map_err(|error| error.message)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallRequest {
    pub path: String,
    #[serde(default)]
    pub enable: bool,
    #[serde(default)]
    pub grant: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnableRequest {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub grant: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallRequest {
    pub id: String,
    #[serde(default)]
    pub remove_data: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBridgeRequest {
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInspectResult {
    pub sha256: String,
    pub compressed_bytes: u64,
    pub expanded_bytes: u64,
    pub file_count: usize,
    pub manifest: crate::plugin::PluginManifest,
    pub permissions: Vec<String>,
    pub style_scan: crate::plugin::scanner::ScanReport,
    pub script_scan: crate::plugin::scanner::ScanReport,
    pub files: Vec<String>,
}

fn parse_grants(values: &[String]) -> CommandResult<Vec<String>> {
    values
        .iter()
        .map(|value| {
            parse_permission(value)
                .map(|_| value.clone())
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn emit_plugin_changed(app: &AppHandle) {
    let _ = app.emit("plugin://changed", ());
}

#[tauri::command]
pub fn plugin_list(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
) -> CommandResult<Vec<PluginRecord>> {
    deny_if_not_main(&window)?;
    Ok(host.list())
}

#[tauri::command]
pub async fn plugin_pick_package(
    app: AppHandle,
    window: WebviewWindow,
) -> CommandResult<Option<String>> {
    deny_if_not_main(&window)?;
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("YAQMC Plugin", &["yaqmc-plugin", "css", "js", "ts"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn plugin_inspect_path(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    path: String,
) -> CommandResult<PluginInspectResult> {
    deny_if_not_main(&window)?;
    let inspection = host
        .inspect_path(&PathBuf::from(path))
        .map_err(|error| error.to_string())?;
    Ok(PluginInspectResult {
        sha256: inspection.sha256,
        compressed_bytes: inspection.compressed_bytes,
        expanded_bytes: inspection.expanded_bytes,
        file_count: inspection.file_count,
        permissions: inspection.manifest.requested_permission_keys(),
        manifest: inspection.manifest,
        style_scan: inspection.style_scan,
        script_scan: inspection.script_scan,
        files: inspection.files.into_iter().map(|file| file.path).collect(),
    })
}

#[tauri::command]
pub fn plugin_install(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginInstallRequest,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    let grants = parse_grants(&request.grant)?;
    let path = PathBuf::from(&request.path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let record = match extension.as_str() {
        "css" => host
            .install_loose_css(&path)
            .map_err(|error| error.to_string())?,
        "js" => host
            .install_loose_script(&path)
            .map_err(|error| error.to_string())?,
        "ts" => {
            return Err(
                "TypeScript plugins must be built to dist/main.js with the Plugin SDK".into(),
            )
        }
        _ if path.is_dir() => {
            return Err("unpacked plugin folders can only be installed from Developer Mode".into())
        }
        _ => host
            .install(&path, request.enable, &grants)
            .map_err(|error| error.to_string())?,
    };
    emit_plugin_changed(&app);
    Ok(record)
}

#[tauri::command]
pub fn plugin_set_enabled(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginEnableRequest,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    let grants = parse_grants(&request.grant)?;
    let record = host
        .set_enabled_with_grants(&request.id, request.enabled, &grants)
        .map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(record)
}

#[tauri::command]
pub fn plugin_uninstall(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginUninstallRequest,
) -> CommandResult<()> {
    deny_if_not_main(&window)?;
    host.uninstall(&request.id, request.remove_data)
        .map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn plugin_set_safe_mode(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    enabled: bool,
) -> CommandResult<bool> {
    deny_if_not_main(&window)?;
    host.set_safe_mode(enabled)
        .map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(host.safe_mode())
}

#[tauri::command]
pub fn plugin_set_developer_mode(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    enabled: bool,
) -> CommandResult<bool> {
    deny_if_not_main(&window)?;
    host.set_developer_mode(enabled)
        .map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(host.developer_mode())
}

#[tauri::command]
pub async fn plugin_pick_directory(
    app: AppHandle,
    window: WebviewWindow,
) -> CommandResult<Option<String>> {
    deny_if_not_main(&window)?;
    let dialog_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn plugin_install_unpacked(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginInstallRequest,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    let grants = parse_grants(&request.grant)?;
    let record = host
        .install_unpacked(&PathBuf::from(&request.path), request.enable, &grants)
        .map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(record)
}

#[tauri::command]
pub fn plugin_reload(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    id: String,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    let record = host.reload(&id).map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(record)
}

#[tauri::command]
pub fn plugin_read_asset(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    plugin_id: String,
    path: String,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    let (mime, bytes) = host
        .read_asset(&plugin_id, &path)
        .map_err(|error| error.to_string())?;
    use base64::Engine;
    Ok(json!({
        "mime": mime,
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingsWrite {
    pub id: String,
    pub values: serde_json::Map<String, Value>,
}

#[tauri::command]
pub fn plugin_settings_get(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    id: String,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    host.settings_get(&id, false)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn plugin_settings_set(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginSettingsWrite,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    let value = host
        .settings_set(&request.id, request.values)
        .map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(value)
}

#[tauri::command]
pub fn plugin_active_resources(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
) -> CommandResult<ActivePluginResources> {
    deny_if_not_main(&window)?;
    Ok(host.active_resources())
}

#[tauri::command]
pub fn plugin_diagnostics(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
) -> CommandResult<Vec<PluginDiagnostic>> {
    deny_if_not_main(&window)?;
    Ok(host.diagnostics())
}

#[tauri::command]
pub fn plugin_runtime_start(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    plugin_id: String,
) -> CommandResult<String> {
    deny_if_not_main(&window)?;
    let runtime = host
        .start_runtime(&plugin_id)
        .map_err(|error| error.to_string())?;
    Ok(runtime.token)
}

#[tauri::command]
pub fn plugin_runtime_stop(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    token: String,
) -> CommandResult<()> {
    deny_if_not_main(&window)?;
    host.stop_runtime(&token);
    Ok(())
}

#[tauri::command]
pub fn plugin_mark_failed(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    id: String,
    reason: String,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    let record = host
        .mark_failed(&id, &reason)
        .map_err(|error| error.to_string())?;
    emit_plugin_changed(&app);
    Ok(record)
}

#[tauri::command]
pub async fn plugin_bridge(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    player: State<'_, Arc<PlayerService>>,
    request: PluginBridgeRequest,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    dispatch_bridge(&host, &player, &request).await
}

pub(crate) fn required_permission(method: &str) -> Result<Option<PluginPermission>, String> {
    match method {
        "track.get" | "track.read" => Ok(Some(PluginPermission::TrackRead)),
        "lyrics.get" | "lyrics.read" => Ok(Some(PluginPermission::LyricsRead)),
        "player.get" | "player.read" => Ok(Some(PluginPermission::PlayerRead)),
        "player.play" | "player.pause" | "player.toggle" | "player.next" | "player.previous"
        | "player.seek" => Ok(Some(PluginPermission::PlayerControl)),
        "theme.get" => Ok(Some(PluginPermission::ThemeRead)),
        "storage.get" | "storage.set" | "settings.get" | "settings.set" => {
            Ok(Some(PluginPermission::PluginStorage))
        }
        "ui.contextMenu.track.register" => Ok(Some(PluginPermission::UiContextMenu)),
        "ui.playerBar.register" => Ok(Some(PluginPermission::UiPlayerBar)),
        "ui.sidebar.register" => Ok(Some(PluginPermission::UiSidebar)),
        "ui.notify" => Ok(Some(PluginPermission::UiNotify)),
        "network.request" => Ok(Some(PluginPermission::Network)),
        "scenes.onMount"
        | "scenes.onUnmount"
        | "scenes.setVariable"
        | "scenes.setState"
        | "scenes.setWidgetProperty"
        | "scenes.animate" => Ok(Some(PluginPermission::SceneRegister)),
        "log.info" | "log.warn" | "log.error" => Ok(None),
        "fs.read"
        | "fs.write"
        | "shell.open"
        | "account.credentials"
        | "invoke"
        | "network.fetch" => Err("this capability is not available to plugins".into()),
        _ => Err("unknown plugin API method".into()),
    }
}

async fn dispatch_bridge(
    host: &ExtensionHost,
    player: &PlayerService,
    request: &PluginBridgeRequest,
) -> CommandResult<Value> {
    if request.method.len() > 64 {
        return Err("invalid plugin API method".into());
    }
    let permission = required_permission(&request.method)?;
    let runtime = if let Some(permission) = permission {
        host.check_permission(&request.token, permission)
            .map_err(|error| error.to_string())?
    } else {
        host.runtime(&request.token)
            .ok_or_else(|| "unknown plugin runtime".to_owned())?
    };
    let rate_key = if request.method == "player.seek" {
        "player.seek"
    } else if request.method.starts_with("player.") {
        "player"
    } else if request.method.starts_with("storage.") || request.method.starts_with("settings.") {
        "storage"
    } else if request.method.starts_with("log.") {
        "log"
    } else if request.method.starts_with("network.") {
        "network"
    } else if request.method.starts_with("ui.notify") {
        "notify"
    } else {
        "api"
    };
    let limit = match rate_key {
        "player.seek" => 4,
        "player" => 8,
        "storage" => 20,
        "log" => 10,
        "network" => 4,
        "notify" => 4,
        _ => 30,
    };
    host.rate_limit(&runtime.plugin_id, rate_key, limit)
        .map_err(|error| error.to_string())?;
    match request.method.as_str() {
        "track.get" | "track.read" => {
            let snapshot = player.snapshot().await;
            let current = snapshot
                .current_index
                .and_then(|index| snapshot.queue.get(index));
            Ok(json!({
                "id": current.map(|song| song.id.clone()),
                "title": current.map(|song| song.title.clone()),
                "artists": current.map(|song| song.artists.iter().map(|artist| artist.name.clone()).collect::<Vec<_>>()),
                "album": current.map(|song| song.album.title.clone()),
                "durationMs": current.map(|song| song.duration_ms),
                "quality": current.map(|song| song.quality),
                "artwork": current.map(|song| json!({
                    "alt": song.artwork.alt,
                    "dominantColor": song.artwork.dominant_color,
                })),
                "queueEntryId": snapshot.current_queue_entry_id,
                "sessionId": snapshot.session_id,
            }))
        }
        "lyrics.get" | "lyrics.read" => {
            let snapshot = player.snapshot().await;
            let document = player.lyrics().await;
            let position = snapshot.position_ms;
            let lines = document
                .as_ref()
                .map(|value| {
                    value
                        .lines
                        .iter()
                        .map(|line| {
                            json!({
                                "id": line.id,
                                "text": line.text,
                                "translation": line.translation,
                                "romanization": line.romanization,
                                "startMs": line.start_ms,
                                "endMs": line.end_ms,
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let current_index = document.as_ref().and_then(|value| {
                value
                    .lines
                    .iter()
                    .enumerate()
                    .rev()
                    .find_map(|(index, line)| {
                        line.start_ms
                            .filter(|start| *start <= position)
                            .map(|_| index)
                    })
            });
            Ok(json!({
                "songId": document.as_ref().map(|value| value.song_id.clone()),
                "syncMode": document.as_ref().map(|value| value.sync_mode),
                "lines": document.as_ref().map(|value| value.lines.iter().map(|line| line.text.clone()).collect::<Vec<_>>()).unwrap_or_default(),
                "timedLines": lines,
                "currentLine": current_index,
                "positionMs": position,
            }))
        }
        "player.get" | "player.read" => {
            let snapshot = player.snapshot().await;
            Ok(json!({
                "state": snapshot.playback_state,
                "isPlaying": snapshot.is_playing,
                "positionMs": snapshot.position_ms,
                "durationMs": snapshot.playback_duration_ms,
                "volume": snapshot.volume,
                "muted": snapshot.is_muted,
                "sessionId": snapshot.session_id,
                "snapshotRevision": snapshot.snapshot_revision,
                "repeat": snapshot.repeat,
                "playbackOrder": snapshot.playback_order,
                "primaryPlaybackMode": snapshot.primary_playback_mode,
                "queueEntryId": snapshot.current_queue_entry_id,
            }))
        }
        "theme.get" => Ok(json!({ "source": "yaqmc" })),
        "player.play" => {
            player.play().await.map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "player.pause" => {
            player.pause().await.map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "player.toggle" => {
            player.toggle().await.map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "player.next" => {
            player.next().await.map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "player.previous" => {
            player.previous().await.map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "player.seek" => {
            let position = request
                .payload
                .get("positionMs")
                .and_then(Value::as_u64)
                .ok_or_else(|| "positionMs must be a number".to_owned())?;
            if position > 24 * 60 * 60 * 1000 {
                return Err("seek position is out of range".into());
            }
            player
                .seek(position)
                .await
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true, "positionMs": position }))
        }
        "storage.get" => {
            let key = request
                .payload
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "storage key is required".to_owned())?;
            Ok(json!({ "value": host.storage_get(&runtime.plugin_id, key) }))
        }
        "storage.set" => {
            let key = request
                .payload
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "storage key is required".to_owned())?;
            let value = request
                .payload
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(|| "storage value must be a string".to_owned())?;
            host.storage_set(&runtime.plugin_id, key, value)
                .map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "log.info" | "log.warn" | "log.error" => {
            let message = request
                .payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("plugin log")
                .chars()
                .take(240)
                .collect::<String>();
            tracing::info!(
                target: "plugin.runtime",
                plugin_id = runtime.plugin_id.as_str(),
                method = request.method.as_str(),
                "{message}"
            );
            Ok(json!({ "ok": true }))
        }
        "settings.get" => host
            .settings_get(&runtime.plugin_id, true)
            .map_err(|error| error.to_string()),
        "settings.set" => {
            let patch = request
                .payload
                .get("values")
                .and_then(Value::as_object)
                .cloned()
                .ok_or_else(|| "settings values must be an object".to_owned())?;
            host.settings_set(&runtime.plugin_id, patch)
                .map_err(|error| error.to_string())
        }
        "ui.contextMenu.track.register"
        | "ui.playerBar.register"
        | "ui.sidebar.register"
        | "scenes.onMount"
        | "scenes.onUnmount"
        | "scenes.setVariable"
        | "scenes.setState"
        | "scenes.setWidgetProperty"
        | "scenes.animate" => Ok(json!({ "ok": true, "pluginId": runtime.plugin_id })),
        "ui.notify" => {
            let message = request
                .payload
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| "notification message is required".to_owned())?;
            if message.len() > 180 {
                return Err("notification message is too long".into());
            }
            let level = request
                .payload
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info");
            if !matches!(level, "info" | "success" | "warning" | "error") {
                return Err("notification level is invalid".into());
            }
            Ok(json!({
                "ok": true,
                "pluginId": runtime.plugin_id,
                "level": level,
                "message": message,
            }))
        }
        "network.request" => {
            crate::plugin::network::proxy_request(&runtime.network_origins, &request.payload).await
        }
        _ => Err("unknown plugin API method".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_bridge_methods_are_denied() {
        for method in [
            "invoke",
            "fs.read",
            "shell.open",
            "account.credentials",
            "network.fetch",
        ] {
            let error = required_permission(method).expect_err(method);
            assert!(error.contains("not available"), "{method}");
        }
        assert_eq!(
            required_permission("player.seek").unwrap(),
            Some(PluginPermission::PlayerControl)
        );
        assert!(required_permission("player_seek").is_err());
    }

    #[test]
    fn plugin_id_from_payload_is_not_an_authorization_input() {
        let source = include_str!("commands.rs");
        assert!(source.contains("check_permission(&request.token"));
        assert!(!source.contains("payload[\"pluginId\"]"));
        assert!(!source.contains("payload.get(\"pluginId\")"));
    }

    #[test]
    fn plugin_file_picker_uses_the_backend_dialog_like_background_images() {
        let source = include_str!("commands.rs");
        assert!(source.contains("plugin_pick_package"));
        assert!(source.contains("blocking_pick_file"));
        assert!(source.contains("yaqmc-plugin"));
        assert!(source.contains("DialogExt"));
    }
}
