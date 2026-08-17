use crate::{
    command_guard::require_main_window,
    player::PlayerService,
    plugin::{
        host::{ActivePluginResources, ExtensionHost, PluginRecord},
        PluginDiagnostic,
    },
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use yaqmc_core::plugin::{
    PluginBridgeRequest, PluginEnableRequest, PluginInspectResult, PluginInstallRequest,
    PluginSettingsWrite, PluginUninstallRequest,
};
use yaqmc_core::server::ops as core_ops;

type CommandResult<T> = Result<T, String>;

fn deny_if_not_main(window: &WebviewWindow) -> CommandResult<()> {
    require_main_window(window).map_err(|error| error.message)
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
    Ok(core_ops::plugin_list(&host))
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
    core_ops::plugin_inspect_path(&host, path)
}

#[tauri::command]
pub fn plugin_install(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginInstallRequest,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    core_ops::plugin_install(&host, request, || emit_plugin_changed(&app))
}

#[tauri::command]
pub fn plugin_set_enabled(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginEnableRequest,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    core_ops::plugin_set_enabled(&host, request, || emit_plugin_changed(&app))
}

#[tauri::command]
pub fn plugin_uninstall(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginUninstallRequest,
) -> CommandResult<()> {
    deny_if_not_main(&window)?;
    core_ops::plugin_uninstall(&host, request, || emit_plugin_changed(&app))
}

#[tauri::command]
pub fn plugin_set_safe_mode(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    enabled: bool,
) -> CommandResult<bool> {
    deny_if_not_main(&window)?;
    core_ops::plugin_set_safe_mode(&host, enabled, || emit_plugin_changed(&app))
}

#[tauri::command]
pub fn plugin_set_developer_mode(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    enabled: bool,
) -> CommandResult<bool> {
    deny_if_not_main(&window)?;
    core_ops::plugin_set_developer_mode(&host, enabled, || emit_plugin_changed(&app))
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
    core_ops::plugin_install_unpacked(&host, request, || emit_plugin_changed(&app))
}

#[tauri::command]
pub fn plugin_reload(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    id: String,
) -> CommandResult<PluginRecord> {
    deny_if_not_main(&window)?;
    core_ops::plugin_reload(&host, &id, || emit_plugin_changed(&app))
}

#[tauri::command]
pub fn plugin_read_asset(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    plugin_id: String,
    path: String,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    core_ops::plugin_read_asset(&host, &plugin_id, &path)
}

#[tauri::command]
pub fn plugin_settings_get(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    id: String,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    core_ops::plugin_settings_get(&host, &id)
}

#[tauri::command]
pub fn plugin_settings_set(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    request: PluginSettingsWrite,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    core_ops::plugin_settings_set(&host, request, || emit_plugin_changed(&app))
}

#[tauri::command]
pub fn plugin_active_resources(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
) -> CommandResult<ActivePluginResources> {
    deny_if_not_main(&window)?;
    Ok(core_ops::plugin_active_resources(&host))
}

#[tauri::command]
pub fn plugin_diagnostics(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
) -> CommandResult<Vec<PluginDiagnostic>> {
    deny_if_not_main(&window)?;
    Ok(core_ops::plugin_diagnostics(&host))
}

#[tauri::command]
pub fn plugin_runtime_start(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    plugin_id: String,
) -> CommandResult<String> {
    deny_if_not_main(&window)?;
    core_ops::plugin_runtime_start(&host, &plugin_id)
}

#[tauri::command]
pub fn plugin_runtime_stop(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    token: String,
) -> CommandResult<()> {
    deny_if_not_main(&window)?;
    core_ops::plugin_runtime_stop(&host, &token);
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
    core_ops::plugin_mark_failed(&host, &id, &reason, || emit_plugin_changed(&app))
}

#[tauri::command]
pub async fn plugin_bridge(
    window: WebviewWindow,
    host: State<'_, Arc<ExtensionHost>>,
    player: State<'_, Arc<PlayerService>>,
    request: PluginBridgeRequest,
) -> CommandResult<Value> {
    deny_if_not_main(&window)?;
    core_ops::plugin_bridge(&host, &player, request).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn plugin_file_picker_uses_the_backend_dialog_like_background_images() {
        let source = include_str!("commands.rs");
        assert!(source.contains("plugin_pick_package"));
        assert!(source.contains("blocking_pick_file"));
        assert!(source.contains("yaqmc-plugin"));
        assert!(source.contains("DialogExt"));
    }
}
