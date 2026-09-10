//! Android JNI facade for the in-process YAQMC Core.
//!
//! Kotlin owns the process lifecycle and supplies a callback object. Rust keeps
//! the existing Core protocol and never exposes provider routes to the host.

use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use jni::{
    objects::{Global, JByteArray, JObject, JString, JValue},
    sys::{jboolean, jint, jlong, jsize},
    Env, EnvUnowned,
};
use serde_json::{json, Value};
use yaqmc_core::{
    audio::{
        open_playback_stream, AudioEngine, AudioEngineError, AudioEngineSnapshot, AudioLoadMetadata,
        AudioOutputDevice, AudioResolvedOutput, PlaybackStreamLocation, PreparedPlaybackSource,
        ReadSeek,
    },
    bootstrap,
    credentials::{CredentialError, CredentialStore},
    diagnostics::AppSection,
    platform::{
        AudioDiagnostics, DesktopIntegrationStatus, PlatformCapabilities, PlatformDiagnostics,
        SystemMediaStatus,
    },
    server::{CoreRuntime, EventSink, HostDispatchHooks},
    CoreBootstrapInputs, CoreConfig, CorePaths,
};
use yaqmc_protocol::{CoreError, ResponseBody, WindowOrigin};

struct RegisteredStream {
    stream: Box<dyn ReadSeek>,
    content_length: u64,
}

static STREAMS: OnceLock<Mutex<HashMap<i64, RegisteredStream>>> = OnceLock::new();
static NEXT_STREAM_ID: AtomicI64 = AtomicI64::new(1);

fn streams() -> &'static Mutex<HashMap<i64, RegisteredStream>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_stream(stream: Box<dyn ReadSeek>, content_length: u64) -> i64 {
    let id = NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut map) = streams().lock() {
        map.insert(id, RegisteredStream { stream, content_length });
    }
    id
}

fn remove_stream(id: i64) {
    if let Ok(mut map) = streams().lock() {
        map.remove(&id);
    }
}

#[derive(Debug)]
struct AudioState {
    loaded: bool,
    playing: bool,
    paused: bool,
    ended: bool,
    buffering: bool,
    position_ms: u64,
    last_position_update: Instant,
    duration_ms: Option<u64>,
    error: Option<String>,
    source_generation: u64,
}

impl Default for AudioState {
    fn default() -> Self {
        Self {
            loaded: false,
            playing: false,
            paused: false,
            ended: false,
            buffering: false,
            position_ms: 0,
            last_position_update: Instant::now(),
            duration_ms: None,
            error: None,
            source_generation: 0,
        }
    }
}

pub struct AndroidAudioEngine {
    vm: jni::JavaVM,
    callback: Global<JObject<'static>>,
    state: Arc<Mutex<AudioState>>,
    current_stream_id: AtomicI64,
    source_generation: AtomicU64,
}

impl AndroidAudioEngine {
    fn new(vm: jni::JavaVM, callback: Global<JObject<'static>>) -> Self {
        Self {
            vm,
            callback,
            state: Arc::new(Mutex::new(AudioState::default())),
            current_stream_id: AtomicI64::new(0),
            source_generation: AtomicU64::new(0),
        }
    }

    fn state_handle(&self) -> Arc<Mutex<AudioState>> {
        Arc::clone(&self.state)
    }
}

impl AudioEngine for AndroidAudioEngine {
    fn load(&self, source: &PreparedPlaybackSource) -> Result<AudioLoadMetadata, AudioEngineError> {
        let location = open_playback_stream(source)?;
        let (stream_id, local_path) = match location {
            PlaybackStreamLocation::Local(path) => {
                let prev_id = self.current_stream_id.swap(0, Ordering::Relaxed);
                if prev_id != 0 {
                    remove_stream(prev_id);
                }
                (0, Some(path.to_string_lossy().to_string()))
            }
            PlaybackStreamLocation::Stream { reader, content_length, .. } => {
                let prev_id = self.current_stream_id.swap(0, Ordering::Relaxed);
                if prev_id != 0 {
                    remove_stream(prev_id);
                }
                let sid = register_stream(reader, content_length);
                self.current_stream_id.store(sid, Ordering::Relaxed);
                (sid, None)
            }
        };
        let generation = self.source_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let format_str = source.format.as_str().to_owned();

        let ok = self
            .vm
            .attach_current_thread(|env| -> Result<bool, jni::errors::Error> {
                let path_obj = match &local_path {
                    Some(p) => JObject::from(env.new_string(p)?),
                    None => JObject::null(),
                };
                let format_jstr = env.new_string(format_str)?;
                let res = env
                    .call_method(
                        &self.callback,
                        jni::jni_str!("audioLoad"),
                        jni::jni_sig!((jlong, JString, JString) -> bool),
                        &[
                            JValue::Long(stream_id),
                            JValue::Object(&path_obj),
                            JValue::Object(&format_jstr),
                        ],
                    )?
                    .z()?;
                Ok(res)
            })
            .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;

        if !ok {
            return Err(AudioEngineError::DecoderUnsupported);
        }

        let mut st = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *st = AudioState {
            loaded: true,
            playing: false,
            paused: true,
            ended: false,
            buffering: false,
            position_ms: 0,
            last_position_update: Instant::now(),
            duration_ms: source.timeline_end_ms,
            error: None,
            source_generation: generation,
        };

        Ok(AudioLoadMetadata {
            duration_ms: None,
            format: source.format,
        })
    }

    fn play(&self) -> Result<(), AudioEngineError> {
        self.vm
            .attach_current_thread(|env| {
                env.call_method(
                    &self.callback,
                    jni::jni_str!("audioPlay"),
                    jni::jni_sig!(() -> ()),
                    &[],
                )?;
                Ok::<_, jni::errors::Error>(())
            })
            .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;

        let mut st = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        st.playing = true;
        st.paused = false;
        st.ended = false;
        st.last_position_update = Instant::now();
        Ok(())
    }

    fn pause(&self) -> Result<(), AudioEngineError> {
        self.vm
            .attach_current_thread(|env| {
                env.call_method(
                    &self.callback,
                    jni::jni_str!("audioPause"),
                    jni::jni_sig!(() -> ()),
                    &[],
                )?;
                Ok::<_, jni::errors::Error>(())
            })
            .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;

        let mut st = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if st.playing {
            let elapsed = st.last_position_update.elapsed().as_millis() as u64;
            st.position_ms = (st.position_ms + elapsed).min(st.duration_ms.unwrap_or(u64::MAX));
        }
        st.playing = false;
        st.paused = true;
        Ok(())
    }

    fn stop(&self) -> Result<(), AudioEngineError> {
        let prev_id = self.current_stream_id.swap(0, Ordering::Relaxed);
        if prev_id != 0 {
            remove_stream(prev_id);
        }
        self.vm
            .attach_current_thread(|env| {
                env.call_method(
                    &self.callback,
                    jni::jni_str!("audioStop"),
                    jni::jni_sig!(() -> ()),
                    &[],
                )?;
                Ok::<_, jni::errors::Error>(())
            })
            .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;

        let mut st = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *st = AudioState::default();
        Ok(())
    }

    fn seek(&self, position: Duration) -> Result<(), AudioEngineError> {
        let pos_ms = position.as_millis() as u64;
        self.vm
            .attach_current_thread(|env| {
                env.call_method(
                    &self.callback,
                    jni::jni_str!("audioSeek"),
                    jni::jni_sig!((jlong) -> ()),
                    &[JValue::Long(pos_ms as jlong)],
                )?;
                Ok::<_, jni::errors::Error>(())
            })
            .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;

        let mut st = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        st.position_ms = pos_ms;
        st.last_position_update = Instant::now();
        Ok(())
    }

    fn set_volume(&self, volume: f32) -> Result<(), AudioEngineError> {
        self.vm
            .attach_current_thread(|env| {
                env.call_method(
                    &self.callback,
                    jni::jni_str!("audioSetVolume"),
                    jni::jni_sig!((jfloat) -> ()),
                    &[JValue::Float(volume)],
                )?;
                Ok::<_, jni::errors::Error>(())
            })
            .map_err(|_| AudioEngineError::OutputDeviceOpenFailed)?;
        Ok(())
    }

    fn set_output_device(&self, _device_id: &str) -> Result<(), AudioEngineError> {
        Ok(())
    }

    fn snapshot(&self) -> AudioEngineSnapshot {
        let st = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current_position = if st.playing && !st.paused && !st.ended {
            let elapsed = st.last_position_update.elapsed().as_millis() as u64;
            (st.position_ms + elapsed).min(st.duration_ms.unwrap_or(u64::MAX))
        } else {
            st.position_ms
        };
        AudioEngineSnapshot {
            loaded: st.loaded,
            playing: st.playing,
            paused: st.paused,
            ended: st.ended,
            position_ms: current_position,
            duration_ms: st.duration_ms,
            output_error: st.error.clone(),
            source_error: None,
            source_url_expired: false,
            buffering: st.buffering,
            progressive_downloaded_bytes: None,
            progressive_total_bytes: None,
            source_generation: st.source_generation,
        }
    }

    fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
        Ok(vec![AudioOutputDevice {
            id: "system:default".to_owned(),
            label: "Android System Output".to_owned(),
            is_default: true,
            is_selected: true,
            selection_kind: "system-default".to_owned(),
            resolved_output: Some(AudioResolvedOutput {
                name: "Media3 / AudioTrack".to_owned(),
                driver: "Android AudioTrack / Offload".to_owned(),
                host: "android".to_owned(),
                sample_rate: 48_000,
                channels: 2,
                sample_format: "native".to_owned(),
            }),
        }])
    }
}

#[cfg(target_os = "android")]
static ANDROID_CONTEXT: OnceLock<Global<JObject<'static>>> = OnceLock::new();
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static CORES: OnceLock<Mutex<HashMap<u64, Arc<AndroidCore>>>> = OnceLock::new();

fn cores() -> &'static Mutex<HashMap<u64, Arc<AndroidCore>>> {
    CORES.get_or_init(|| Mutex::new(HashMap::new()))
}

struct AndroidCredentialStore {
    vm: jni::JavaVM,
    callback: Global<JObject<'static>>,
}

impl AndroidCredentialStore {
    fn load_from_host(&self, account: &str) -> Result<Option<String>, CredentialError> {
        let account = account.to_owned();
        self.vm
            .attach_current_thread(|env| -> Result<_, jni::errors::Error> {
                let account = env.new_string(account)?;
                let value = env
                    .call_method(
                        &self.callback,
                        jni::jni_str!("credentialLoad"),
                        jni::jni_sig!((JString) -> JString),
                        &[JValue::Object(&account)],
                    )?
                    .l()?;
                if value.is_null() {
                    return Ok(None);
                }
                Ok(Some(env.cast_local::<JString>(value)?.to_string()))
            })
            .map_err(|_| CredentialError::OperationFailed)
    }

    fn update_host(&self, account: &str, secret: Option<&str>) -> Result<(), CredentialError> {
        let account = account.to_owned();
        let secret = secret.map(str::to_owned);
        self.vm
            .attach_current_thread(|env| -> Result<_, jni::errors::Error> {
                let account = env.new_string(account)?;
                let ok = if let Some(secret) = secret {
                    let secret = env.new_string(secret)?;
                    env.call_method(
                        &self.callback,
                        jni::jni_str!("credentialSave"),
                        jni::jni_sig!((JString, JString) -> bool),
                        &[JValue::Object(&account), JValue::Object(&secret)],
                    )?
                    .z()?
                } else {
                    env.call_method(
                        &self.callback,
                        jni::jni_str!("credentialDelete"),
                        jni::jni_sig!((JString) -> bool),
                        &[JValue::Object(&account)],
                    )?
                    .z()?
                };
                if ok {
                    Ok(())
                } else {
                    Err(jni::errors::Error::NullPtr(
                        "credential callback returned false",
                    ))
                }
            })
            .map_err(|_| CredentialError::OperationFailed)
    }
}

impl CredentialStore for AndroidCredentialStore {
    fn load(&self, account: &str) -> Result<Option<String>, CredentialError> {
        self.load_from_host(account)
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), CredentialError> {
        self.update_host(account, Some(secret))
    }

    fn delete(&self, account: &str) -> Result<(), CredentialError> {
        self.update_host(account, None)
    }
}

struct AndroidCallbackSink {
    vm: jni::JavaVM,
    callback: Global<JObject<'static>>,
    sequence: AtomicU64,
}

impl AndroidCallbackSink {
    fn emit_event(&self, channel: &str, payload: &Value) {
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let channel = channel.to_owned();
        let payload = payload.to_string();
        if let Err(error) = self.vm.attach_current_thread(|env| {
            let channel = env.new_string(channel)?;
            let payload = env.new_string(payload)?;
            env.call_method(
                &self.callback,
                jni::jni_str!("onCoreEvent"),
                jni::jni_sig!((i64, JString, JString) -> ()),
                &[
                    JValue::Long(seq as jlong),
                    JValue::Object(&channel),
                    JValue::Object(&payload),
                ],
            )?;
            Ok::<_, jni::errors::Error>(())
        }) {
            tracing::warn!(target: "android.jni", %error, "failed to deliver Core event");
        }
    }

    fn emit_response(&self, id: u64, body: ResponseBody) {
        let body = serde_json::to_string(&body).unwrap_or_else(|_| {
            json!({
                "ok": false,
                "error": {
                    "code": "core.internal",
                    "message": "response serialization failed",
                    "retryable": false
                }
            })
            .to_string()
        });
        if let Err(error) = self.vm.attach_current_thread(|env| {
            let body = env.new_string(body)?;
            env.call_method(
                &self.callback,
                jni::jni_str!("onCoreResponse"),
                jni::jni_sig!((i64, JString) -> ()),
                &[JValue::Long(id as jlong), JValue::Object(&body)],
            )?;
            Ok::<_, jni::errors::Error>(())
        }) {
            tracing::warn!(target: "android.jni", %error, "failed to deliver Core response");
        }
    }
}

impl EventSink for AndroidCallbackSink {
    fn emit(&self, _source_seq: u64, channel: &str, payload: &Value) {
        self.emit_event(channel, payload);
    }
}

struct AndroidHost {
    data_dir: PathBuf,
    version: String,
    commit: Option<String>,
    channel: String,
    build_type: String,
}

impl HostDispatchHooks for AndroidHost {
    fn platform_diagnostics(&self) -> PlatformDiagnostics {
        PlatformDiagnostics {
            generated_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            app_name: "YAQMC",
            app_version: self.version.clone(),
            os: "android",
            architecture: std::env::consts::ARCH,
            linux: None,
            capabilities: PlatformCapabilities {
                reliable_always_on_top: false,
                click_through: false,
                transparent_window: false,
                global_positioning: false,
                absolute_window_placement: false,
                fullscreen_detection: false,
                global_shortcuts: false,
                notes: vec![
                    "Android uses a Media3 session projection and has no desktop window integration."
                        .to_owned(),
                ],
            },
            audio: AudioDiagnostics {
                implementation: "media3/exoplayer".to_owned(),
                route: "android-native".to_owned(),
                available: true,
                selected_output: None,
                selected_output_kind: None,
                resolved_output: None,
                resolved_driver: Some("Android AudioTrack / Offload".to_owned()),
                resolved_host: Some("android".to_owned()),
                resolved_sample_rate: None,
                resolved_channels: None,
                resolved_sample_format: None,
            },
            system_media: SystemMediaStatus {
                available: true,
                backend: "android-media3",
                specification: "MediaSession",
                error: None,
            },
            desktop_integration: DesktopIntegrationStatus {
                tray_available: false,
                tray_error: None,
                global_shortcuts_supported: false,
                global_shortcuts_enabled: false,
                global_shortcuts: Vec::new(),
                shortcut_error: None,
            },
        }
    }

    fn download_dir(&self) -> PathBuf {
        self.data_dir.join("downloads")
    }

    fn app_section(&self) -> AppSection {
        AppSection {
            name: "YAQMC",
            version: self.version.clone(),
            commit: self.commit.clone(),
            channel: self.channel.clone(),
            build_type: self.build_type.clone(),
        }
    }

    fn renderer_label(&self, _platform: &PlatformDiagnostics) -> String {
        format!("android/{}", self.version)
    }
}

struct AndroidCore {
    runtime: Arc<tokio::runtime::Runtime>,
    core: Arc<CoreRuntime<AndroidHost>>,
    callback: Arc<AndroidCallbackSink>,
    audio_state: Arc<Mutex<AudioState>>,
}

fn jstring(_env: &mut Env<'_>, value: JString<'_>) -> String {
    value.to_string()
}

fn throw(env: &mut Env<'_>, message: impl AsRef<str>) {
    let _ = env.throw_new(
        jni::jni_str!("java/lang/IllegalStateException"),
        jni::strings::JNIString::from(message.as_ref()),
    );
}

fn failure(code: &str, message: impl Into<String>) -> ResponseBody {
    ResponseBody::failure(CoreError {
        code: code.to_owned(),
        message: message.into(),
        details: None,
        retryable: false,
    })
}

fn initialize(
    env: &mut Env<'_>,
    context: JObject<'_>,
    files_dir: JString<'_>,
    cache_dir: JString<'_>,
    build_json: JString<'_>,
    callback: JObject<'_>,
) -> Result<jlong, String> {
    let vm = env.get_java_vm().map_err(|error| error.to_string())?;
    #[cfg(target_os = "android")]
    {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            rustls::crypto::aws_lc_rs::default_provider()
                .install_default()
                .map_err(|_| "Android TLS crypto provider initialization failed".to_owned())?;
        }
        if ANDROID_CONTEXT.get().is_none() {
            let global_context = env
                .new_global_ref(&context)
                .map_err(|error| error.to_string())?;
            unsafe {
                ndk_context::initialize_android_context(
                    vm.get_raw().cast(),
                    global_context.as_raw().cast(),
                );
            }
            ANDROID_CONTEXT
                .set(global_context)
                .map_err(|_| "Android context initialized concurrently".to_owned())?;
        }
        rustls_platform_verifier::android::init_with_env(env, context)
            .map_err(|error| format!("Android TLS verifier initialization failed: {error}"))?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = context;

    let files_dir = jstring(env, files_dir);
    let cache_dir = jstring(env, cache_dir);
    let build_json = jstring(env, build_json);
    let build: Value = serde_json::from_str(&build_json).map_err(|error| error.to_string())?;
    let callback_sink_ref = env
        .new_global_ref(&callback)
        .map_err(|error| error.to_string())?;
    let callback_store_ref = env
        .new_global_ref(&callback)
        .map_err(|error| error.to_string())?;
    let callback_audio_ref = env
        .new_global_ref(&callback)
        .map_err(|error| error.to_string())?;
    let callback_sink = Arc::new(AndroidCallbackSink {
        vm: vm.clone(),
        callback: callback_sink_ref,
        sequence: AtomicU64::new(0),
    });
    let credentials: Arc<dyn CredentialStore> = Arc::new(AndroidCredentialStore {
        vm: vm.clone(),
        callback: callback_store_ref,
    });
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?,
    );
    let audio_engine = Arc::new(AndroidAudioEngine::new(vm.clone(), callback_audio_ref));
    let audio_state = audio_engine.state_handle();
    let audio: Arc<dyn AudioEngine> = audio_engine;
    let data_dir = PathBuf::from(files_dir);
    let cache_dir = PathBuf::from(cache_dir);
    let version = build
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_owned();
    let channel = build
        .get("releaseChannel")
        .and_then(Value::as_str)
        .unwrap_or("android")
        .to_owned();
    let commit = build
        .get("buildCommit")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && *value != "unknown")
        .map(str::to_owned);
    let build_type = build
        .get("buildType")
        .and_then(Value::as_str)
        .unwrap_or("release")
        .to_owned();
    let config = CoreConfig {
        paths: CorePaths {
            local_api_config_path: data_dir.join("local-api.json"),
            log_dir: data_dir.join("logs"),
            data_dir: data_dir.clone(),
            cache_dir,
        },
        release_channel: channel.clone(),
        build_commit: commit.clone().unwrap_or_else(|| "unknown".to_owned()),
    };
    let core = bootstrap(
        config,
        CoreBootstrapInputs {
            credentials,
            audio,
            runtime: runtime.handle().clone(),
            windows_hwnd: None,
            windows_start_error: None,
            plugin_fallback_dir: data_dir.join("plugins"),
            log_fallback_dir: data_dir.join("logs"),
        },
    )
    .map_err(|error| error.to_string())?;
    let sink: Arc<dyn EventSink> = callback_sink.clone();
    let host = AndroidHost {
        data_dir,
        version,
        commit,
        channel,
        build_type,
    };
    let core = runtime.block_on(CoreRuntime::start(core, host, sink));
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    cores()
        .lock()
        .map_err(|_| "Android Core registry is poisoned".to_owned())?
        .insert(
            handle,
            Arc::new(AndroidCore {
                runtime,
                core: Arc::new(core),
                callback: callback_sink,
                audio_state,
            }),
        );
    Ok(handle as jlong)
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeInitialize(
    mut env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    context: JObject<'_>,
    files_dir: JString<'_>,
    cache_dir: JString<'_>,
    build_json: JString<'_>,
    callback: JObject<'_>,
) -> jlong {
    match env
        .with_env(|env| -> Result<jlong, jni::errors::Error> {
            match initialize(env, context, files_dir, cache_dir, build_json, callback) {
                Ok(handle) => Ok(handle),
                Err(error) => {
                    throw(env, error);
                    Ok(0)
                }
            }
        })
        .into_outcome()
    {
        jni::Outcome::Ok(handle) => handle,
        _ => 0,
    }
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeInvoke(
    mut env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    handle: jlong,
    id: jlong,
    origin: JString<'_>,
    method: JString<'_>,
    params_json: JString<'_>,
) {
    let _ = env.with_env(|env| {
        let origin = jstring(env, origin);
        let method = jstring(env, method);
        let params_json = jstring(env, params_json);
        let core = cores()
            .lock()
            .ok()
            .and_then(|registry| registry.get(&(handle as u64)).cloned());
        let Some(core) = core else {
            throw(env, "Core handle is not active");
            return Ok::<(), jni::errors::Error>(());
        };
        let origin = match origin.as_str() {
            "main" => WindowOrigin::Main,
            "host" => WindowOrigin::Host,
            _ => {
                core.callback.emit_response(
                    id as u64,
                    failure("protocol.denied", "unsupported Android window origin"),
                );
                return Ok(());
            }
        };
        let params = match (!params_json.is_empty()).then(|| serde_json::from_str(&params_json)) {
            Some(Ok(params)) => Some(params),
            Some(Err(error)) => {
                core.callback.emit_response(
                    id as u64,
                    failure("protocol.invalid_params", error.to_string()),
                );
                return Ok(());
            }
            None => None,
        };
        let runtime = Arc::clone(&core.runtime);
        let core_runtime = Arc::clone(&core.core);
        let callback = Arc::clone(&core.callback);
        runtime.spawn(async move {
            let body = core_runtime.invoke(origin, &method, params).await;
            callback.emit_response(id as u64, body);
        });
        Ok(())
    });
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeSetLifecycle(
    mut env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    handle: jlong,
    state: JString<'_>,
) {
    let _ = env.with_env(|env| {
        let state = jstring(env, state);
        let core = cores()
            .lock()
            .ok()
            .and_then(|registry| registry.get(&(handle as u64)).cloned());
        let Some(core) = core else {
            return Ok::<(), jni::errors::Error>(());
        };
        let is_background = state == "background";
        core.core.core().player().set_background_mode(is_background);
        Ok(())
    });
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeShutdown(
    mut env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    handle: jlong,
) {
    let _ = env.with_env(|env| {
        let core = cores()
            .lock()
            .ok()
            .and_then(|mut registry| registry.remove(&(handle as u64)));
        if let Some(core) = core {
            core.runtime.block_on(core.core.shutdown(true));
        } else if handle != 0 {
            throw(env, "Core handle is not active");
        }
        Ok::<(), jni::errors::Error>(())
    });
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeReportAudioState(
    mut env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    handle: jlong,
    position_ms: jlong,
    duration_ms: jlong,
    is_playing: jboolean,
    is_buffering: jboolean,
    is_ended: jboolean,
    error: JString<'_>,
) {
    let _ = env.with_env(|env| {
        let error_str = if error.is_null() {
            None
        } else {
            Some(jstring(env, error))
        };

        let cores = match cores().lock() {
            Ok(guard) => guard,
            Err(_) => return Ok(()),
        };
        if let Some(core) = cores.get(&(handle as u64)) {
            {
                let mut st = match core.audio_state.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                st.position_ms = position_ms.max(0) as u64;
                st.last_position_update = Instant::now();
                if duration_ms > 0 {
                    st.duration_ms = Some(duration_ms as u64);
                }
                st.playing = is_playing;
                st.buffering = is_buffering;
                st.ended = is_ended;
                if is_ended {
                    st.playing = false;
                }
                st.error = error_str;
            }
            if is_ended {
                core.core.core().player().wake_clock();
            }
        }
        Ok::<(), jni::errors::Error>(())
    });
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeStreamOpen(
    _env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    stream_id: jlong,
    position: jlong,
) -> jlong {
    let mut map = match streams().lock() {
        Ok(guard) => guard,
        Err(_) => return -1,
    };
    let Some(entry) = map.get_mut(&stream_id) else {
        return -1;
    };
    let pos = position.max(0) as u64;
    if entry.stream.seek(SeekFrom::Start(pos)).is_err() {
        return -1;
    }
    (entry.content_length.saturating_sub(pos)) as jlong
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeStreamRead(
    mut env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    stream_id: jlong,
    buffer: JByteArray<'_>,
    offset: jint,
    length: jint,
) -> jint {
    let offset = offset.max(0) as usize;
    let length = length.max(0) as usize;
    if length == 0 {
        return 0;
    }
    let mut temp_buf = vec![0u8; length.min(64 * 1024)];
    let read_res = {
        let mut map = match streams().lock() {
            Ok(guard) => guard,
            Err(_) => return -1,
        };
        let Some(entry) = map.get_mut(&stream_id) else {
            return -1;
        };
        entry.stream.read(&mut temp_buf)
    };
    match read_res {
        Ok(0) => -1,
        Ok(n) => {
            let res = env.with_env(|env| -> Result<(), jni::errors::Error> {
                let slice: &[i8] = unsafe {
                    std::slice::from_raw_parts(temp_buf[..n].as_ptr().cast::<i8>(), n)
                };
                buffer.set_region(env, offset as jsize, slice)?;
                Ok(())
            });
            match res.into_outcome() {
                jni::Outcome::Ok(_) => n as jint,
                _ => -1,
            }
        }
        Err(_) => -1,
    }
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeStreamClose(
    _env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    stream_id: jlong,
) {
    remove_stream(stream_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_handles_are_non_pointer_monotonic_values() {
        let first = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        let second = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        assert_eq!(second, first + 1);
        assert_ne!(first, 0);
    }

    #[test]
    fn failure_response_uses_protocol_envelope() {
        assert_eq!(
            serde_json::to_value(failure("test.failure", "failed")).unwrap(),
            json!({
                "ok": false,
                "error": {
                    "code": "test.failure",
                    "message": "failed",
                    "retryable": false
                }
            })
        );
    }

    #[test]
    fn registered_stream_lifecycle_and_lookup() {
        use std::io::Cursor;
        let data = vec![1u8, 2, 3, 4, 5];
        let stream = Box::new(Cursor::new(data));
        let id = register_stream(stream, 5);
        assert!(id > 0);

        {
            let mut map = streams().lock().unwrap();
            let entry = map.get_mut(&id).expect("stream is registered");
            assert_eq!(entry.content_length, 5);
            let mut buf = [0u8; 3];
            let read = entry.stream.read(&mut buf).unwrap();
            assert_eq!(read, 3);
            assert_eq!(&buf, &[1, 2, 3]);
        }

        remove_stream(id);
        let map = streams().lock().unwrap();
        assert!(map.get(&id).is_none());
    }

    #[test]
    fn audio_state_position_interpolates_while_playing() {
        let state = AudioState {
            loaded: true,
            playing: true,
            paused: false,
            ended: false,
            buffering: false,
            position_ms: 1_000,
            last_position_update: Instant::now() - Duration::from_millis(150),
            duration_ms: Some(10_000),
            error: None,
            source_generation: 1,
        };
        let elapsed = state.last_position_update.elapsed().as_millis() as u64;
        let current_pos = (state.position_ms + elapsed).min(state.duration_ms.unwrap_or(u64::MAX));
        assert!(current_pos >= 1_150);
    }
}
