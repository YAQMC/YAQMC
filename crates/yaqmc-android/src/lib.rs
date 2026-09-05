//! Android JNI facade for the in-process YAQMC Core.
//!
//! Kotlin owns the process lifecycle and supplies a callback object. Rust keeps
//! the existing Core protocol and never exposes provider routes to the host.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use jni::{
    objects::{Global, JObject, JString, JValue},
    sys::jlong,
    Env, EnvUnowned,
};
use serde_json::{json, Value};
use yaqmc_core::{
    audio::{AudioEngine, RodioAudioEngine, UnavailableAudioEngine},
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
                implementation: "rodio/cpal".to_owned(),
                route: "android-native".to_owned(),
                available: true,
                selected_output: None,
                selected_output_kind: None,
                resolved_output: None,
                resolved_driver: Some("AAudio/OpenSL ES".to_owned()),
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
    let callback_sink = Arc::new(AndroidCallbackSink {
        vm: vm.clone(),
        callback: callback_sink_ref,
        sequence: AtomicU64::new(0),
    });
    let credentials: Arc<dyn CredentialStore> = Arc::new(AndroidCredentialStore {
        vm,
        callback: callback_store_ref,
    });
    let runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?,
    );
    let audio: Arc<dyn AudioEngine> = match RodioAudioEngine::open_default() {
        Ok(audio) => Arc::new(audio),
        Err(error) => {
            tracing::warn!(target: "android.audio", error = %error, "audio output unavailable");
            Arc::new(UnavailableAudioEngine)
        }
    };
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
}
