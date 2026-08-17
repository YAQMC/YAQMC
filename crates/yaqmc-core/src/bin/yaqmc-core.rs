use std::path::PathBuf;
use std::sync::Arc;

use yaqmc_core::credentials::PlatformCredentialStore;
use yaqmc_core::server::{NoopHost, serve_protocol};
use yaqmc_core::{CoreBootstrapInputs, CoreConfig, CorePaths, bootstrap};
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

#[tokio::main]
async fn main() {
    let data_dir = env_path("YAQMC_DATA_DIR", "data");
    let cache_dir = env_path("YAQMC_CACHE_DIR", "cache");
    let log_dir = env_path("YAQMC_LOG_DIR", "logs");
    let config_dir = env_path("YAQMC_CONFIG_DIR", "config");
    let _ = std::fs::create_dir_all(&config_dir);
    let _core_pid =
        yaqmc_core::pidfile::CorePidFile::write(&data_dir).expect("core pid file");
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
            credentials: Arc::new(PlatformCredentialStore::new()),
            audio,
            runtime,
            windows_hwnd: None,
            windows_start_error: None,
            plugin_fallback_dir: std::env::temp_dir().join("YAQMC/plugins"),
            log_fallback_dir: std::env::temp_dir().join("YAQMC/logs"),
        },
    )
    .expect("core bootstrap");
    let host = NoopHost {
        download_dir: std::env::temp_dir().join("YAQMC/downloads"),
    };
    if let Err(error) = serve_protocol(core, &host, StdioTransport::new()).await {
        tracing::error!(target: "core.protocol", error = %error, "protocol server failed");
        std::process::exit(1);
    }
}
