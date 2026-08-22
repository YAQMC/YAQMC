use serde_json::{json, Value};

use crate::player::PlayerService;
use crate::plugin::api::PluginBridgeRequest;
use crate::plugin::host::ExtensionHost;
use crate::plugin::permissions::PluginPermission;

pub fn required_permission(method: &str) -> Result<Option<PluginPermission>, String> {
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

pub async fn dispatch_bridge(
    host: &ExtensionHost,
    player: &PlayerService,
    request: &PluginBridgeRequest,
) -> Result<Value, String> {
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
            super::network::proxy_request(&runtime.network_origins, &request.payload).await
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
        let source = include_str!("bridge.rs");
        assert!(source.contains("check_permission(&request.token"));
        assert!(!source.contains("payload[\"pluginId\"]"));
        assert!(!source.contains("payload.get(\"pluginId\")"));
    }
}
