use std::path::PathBuf;
use std::sync::Arc;

use yaqmc_core::credentials::{CredentialStore, FileCredentialStore, PlatformCredentialStore};
use yaqmc_core::server::{serve_protocol, NoopHost};
use yaqmc_core::{bootstrap, CoreBootstrapInputs, CoreConfig, CorePaths};
use yaqmc_protocol::StdioTransport;

#[cfg(not(feature = "test-provider"))]
use yaqmc_core::audio::{RodioAudioEngine, UnavailableAudioEngine};

fn env_path(key: &str, fallback: &str) -> PathBuf {
    std::env::var_os(key).map(PathBuf::from).unwrap_or_else(|| {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(fallback)
    })
}

fn env_path_or_temp(key: &str, suffix: &str) -> PathBuf {
    std::env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(suffix))
}

fn credential_store() -> std::sync::Arc<dyn CredentialStore> {
    match std::env::var_os("YAQMC_CREDENTIAL_DIR") {
        Some(dir) if !dir.is_empty() => {
            std::sync::Arc::new(FileCredentialStore::open(dir).expect("YAQMC_CREDENTIAL_DIR"))
        }
        _ => std::sync::Arc::new(PlatformCredentialStore::new()),
    }
}

#[tokio::main]
async fn main() {
    let data_dir = env_path("YAQMC_DATA_DIR", "data");
    let cache_dir = env_path("YAQMC_CACHE_DIR", "cache");
    let log_dir = env_path("YAQMC_LOG_DIR", "logs");
    let config_dir = env_path("YAQMC_CONFIG_DIR", "config");
    let _ = std::fs::create_dir_all(&config_dir);
    let _core_pid = yaqmc_core::pidfile::CorePidFile::write(&data_dir).expect("core pid file");
    let audio = {
        #[cfg(feature = "test-provider")]
        {
            Arc::new(yaqmc_core::audio::TestAudioEngine::default())
                as Arc<dyn yaqmc_core::audio::AudioEngine>
        }
        #[cfg(not(feature = "test-provider"))]
        match RodioAudioEngine::open_default() {
            Ok(engine) => Arc::new(engine) as Arc<dyn yaqmc_core::audio::AudioEngine>,
            Err(error) => {
                tracing::warn!(
                    target: "player.audio",
                    error = %error,
                    "falling back to unavailable audio"
                );
                Arc::new(UnavailableAudioEngine)
            }
        }
    };
    let runtime = tokio::runtime::Handle::current();
    let core = bootstrap(
        CoreConfig {
            paths: CorePaths {
                data_dir,
                cache_dir,
                log_dir,
                local_api_config_path: config_dir.join("local-api.json"),
            },
            release_channel: std::env::var("YAQMC_CHANNEL")
                .unwrap_or_else(|_| "desktop".to_owned()),
            build_commit: option_env!("YAQMC_BUILD_COMMIT")
                .unwrap_or("unknown")
                .to_owned(),
        },
        CoreBootstrapInputs {
            credentials: credential_store(),
            audio,
            runtime,
            windows_hwnd: None,
            windows_start_error: None,
            plugin_fallback_dir: env_path_or_temp("YAQMC_PLUGIN_FALLBACK_DIR", "YAQMC/plugins"),
            log_fallback_dir: env_path_or_temp("YAQMC_LOG_FALLBACK_DIR", "YAQMC/logs"),
        },
    )
    .expect("core bootstrap");
    let host = NoopHost {
        download_dir: env_path_or_temp("YAQMC_DOWNLOAD_DIR", "YAQMC/downloads"),
    };
    if let Err(error) = serve_protocol(core, host, StdioTransport::new()).await {
        tracing::error!(target: "core.protocol", error = %error, "protocol server failed");
        std::process::exit(1);
    }
}
