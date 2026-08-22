//! Host-neutral construction of the P1 Core service graph.

use std::sync::{Arc, Mutex};

use crate::audio::{AudioEngine, AUDIO_OUTPUT_DEVICE_SETTING};
use crate::credentials::CredentialStore;
use crate::local_api::LocalApiService;
use crate::logging::{self, persisted_log_level, LoggingHandle, LOG_LEVEL_SETTING_KEY};
#[cfg(not(feature = "test-provider"))]
use crate::media::CachedMediaPreparer;
use crate::media::{MediaPreparer, PlaybackSourceResolver};
use crate::player::{PlayerService, PlayerSnapshot};
use crate::plugin::ExtensionHost;
use crate::storage::StorageService;
use crate::system_media::{SystemMediaIntegration, SystemMediaStartConfig};
use crate::{CoreBootstrapError, CoreConfig, HostCommandPublisher};
use yaqmc_provider_api::{MusicProvider, ProviderRegistry};
use yaqmc_provider_qqmusic::create_intree_provider;

pub struct CoreBootstrapInputs {
    pub credentials: Arc<dyn CredentialStore>,
    pub audio: Arc<dyn AudioEngine>,
    pub runtime: tokio::runtime::Handle,
    pub windows_hwnd: Option<isize>,
    pub windows_start_error: Option<String>,
    pub plugin_fallback_dir: std::path::PathBuf,
    pub log_fallback_dir: std::path::PathBuf,
}

pub(crate) struct CoreServices {
    pub storage: Arc<StorageService>,
    pub plugins: Arc<ExtensionHost>,
    pub logging: Arc<LoggingHandle>,
    pub credentials: Arc<dyn CredentialStore>,
    pub providers: Arc<ProviderRegistry>,
    pub qq_music: Arc<dyn MusicProvider>,
    pub audio: Arc<dyn AudioEngine>,
    pub player: Arc<PlayerService>,
    pub local_api: Arc<LocalApiService>,
    pub system_media: Mutex<Option<Arc<SystemMediaIntegration>>>,
    pub runtime: tokio::runtime::Handle,
    pub windows_hwnd: Option<isize>,
    pub windows_start_error: Option<String>,
}

impl CoreServices {
    pub(crate) fn construct(
        config: &CoreConfig,
        inputs: CoreBootstrapInputs,
    ) -> Result<Self, CoreBootstrapError> {
        let storage = Arc::new(
            StorageService::open(
                config.paths.data_dir.clone(),
                config.paths.cache_dir.clone(),
            )
            .map_err(CoreBootstrapError::from_error)?,
        );
        let plugins = match ExtensionHost::open(config.paths.data_dir.join("plugins")) {
            Ok(host) => Arc::new(host),
            Err(error) => {
                tracing::error!(target: "plugin.host", error = %error, "plugin host could not open");
                Arc::new(
                    ExtensionHost::open(inputs.plugin_fallback_dir)
                        .map_err(CoreBootstrapError::from_error)?,
                )
            }
        };
        let level = std::env::var("YAQMC_LOG_LEVEL")
            .ok()
            .and_then(|value| logging::LogLevel::parse(&value))
            .unwrap_or_else(|| {
                persisted_log_level(
                    storage
                        .get_setting(LOG_LEVEL_SETTING_KEY)
                        .ok()
                        .flatten()
                        .as_deref(),
                )
            });
        let logging = Arc::new(
            logging::init(config.paths.log_dir.clone(), level).unwrap_or_else(|_| {
                logging::init(inputs.log_fallback_dir, level).expect("secondary log directory")
            }),
        );
        let credentials = inputs.credentials;
        let qq_music = create_intree_provider(
            Arc::clone(&storage),
            Arc::clone(&credentials),
            config.paths.cache_dir.join("fixture-media"),
        )
        .map_err(CoreBootstrapError::from_error)?;
        let providers = Arc::new(
            ProviderRegistry::new("qqmusic", [Arc::clone(&qq_music)])
                .map_err(CoreBootstrapError::from_error)?,
        );
        let audio = inputs.audio;
        if let Ok(Some(device_id)) = storage.get_setting(AUDIO_OUTPUT_DEVICE_SETTING) {
            if let Err(error) = audio.set_output_device(&device_id) {
                tracing::warn!(target: "audio", error = %error, "saved output device is unavailable; using the system default");
            }
        }
        #[cfg(feature = "test-provider")]
        let resolver: Arc<dyn PlaybackSourceResolver> =
            Arc::new(crate::media::TestPlaybackSourceResolver);
        #[cfg(not(feature = "test-provider"))]
        let resolver: Arc<dyn PlaybackSourceResolver> = providers.clone();
        #[cfg(feature = "test-provider")]
        let preparer: Arc<dyn MediaPreparer> = Arc::new(crate::media::PassthroughMediaPreparer);
        #[cfg(not(feature = "test-provider"))]
        let preparer: Arc<dyn MediaPreparer> = Arc::new(CachedMediaPreparer::new(
            qq_music.media_http_client(),
            Arc::clone(&storage),
        ));
        let player = Arc::new(PlayerService::with_runtime(
            audio.clone(),
            resolver,
            preparer,
        ));
        if let Ok(Some(snapshot)) = storage.load_queue::<PlayerSnapshot>() {
            let qq_music = Arc::clone(&qq_music);
            let player = Arc::clone(&player);
            let runtime = inputs.runtime.clone();
            std::thread::spawn(move || {
                runtime.block_on(qq_music.remember_songs(&snapshot.queue));
                runtime.block_on(player.restore(snapshot));
            })
            .join()
            .expect("queue restore");
        }
        let local_api = LocalApiService::new(
            config.paths.local_api_config_path.clone(),
            Arc::clone(&player),
            Arc::clone(&credentials),
        )
        .map_err(CoreBootstrapError::from_error)?;

        Ok(Self {
            storage,
            plugins,
            logging,
            credentials,
            providers,
            qq_music,
            audio,
            player,
            local_api,
            system_media: Mutex::new(None),
            runtime: inputs.runtime,
            windows_hwnd: inputs.windows_hwnd,
            windows_start_error: inputs.windows_start_error,
        })
    }

    pub(crate) fn start_system_media(
        &self,
        host_commands: HostCommandPublisher,
    ) -> Arc<SystemMediaIntegration> {
        let mut slot = self
            .system_media
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = slot.as_ref() {
            return Arc::clone(existing);
        }
        let integration = SystemMediaIntegration::start(
            SystemMediaStartConfig {
                windows_hwnd: self.windows_hwnd,
                windows_start_error: self.windows_start_error.clone(),
                runtime: self.runtime.clone(),
                host_commands,
            },
            Arc::clone(&self.player),
        );
        *slot = Some(Arc::clone(&integration));
        integration
    }
}
