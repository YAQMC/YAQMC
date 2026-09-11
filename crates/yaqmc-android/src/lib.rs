//! Android JNI facade for the in-process YAQMC Core.
//!
//! Kotlin owns the process lifecycle and supplies a callback object. Rust keeps
//! the existing Core protocol and never exposes provider routes to the host.

use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
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
        open_playback_stream, AudioEngine, AudioEngineError, AudioEngineSnapshot,
        AudioLoadMetadata, AudioOutputDevice, AudioResolvedOutput, PlaybackStreamLocation,
        PreparedPlaybackSource, ReadSeek,
    },
    bootstrap,
    credentials::{CredentialError, CredentialStore},
    diagnostics::AppSection,
    platform::{
        AudioDiagnostics, DesktopIntegrationStatus, PlatformCapabilities, PlatformDiagnostics,
        SystemMediaStatus,
    },
    server::{CoreRuntime, EventSink, HostDispatchHooks},
    streaming::{ProgressiveError, ProgressiveMonitor},
    CoreBootstrapInputs, CoreConfig, CorePaths,
};
use yaqmc_protocol::{CoreError, ResponseBody, WindowOrigin};

/// Integer results shared with `NativeAudioDataSource` on the Kotlin side.
///
/// The read surface keeps its `jint` ABI, but every failure mode has its own
/// code so the Kotlin data source can raise a typed `IOException` instead of
/// treating a failure as end-of-stream and silently truncating playback.
const STREAM_OK_EOF: jint = 0;
const STREAM_ERR_IO: jint = -1;
const STREAM_ERR_UNKNOWN_ID: jint = -2;
const STREAM_ERR_CANCELLED: jint = -3;
const STREAM_ERR_INTERNAL: jint = -4;
const STREAM_ERR_BUSY: jint = -5;

/// How long a second data source waits for the cursor before reporting
/// [`STREAM_ERR_BUSY`]. Media3 drives one data source per media period, so a
/// contended stream is a defect worth surfacing rather than a normal queue.
const LEASE_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// A decoded media stream owned by the Rust Core.
///
/// A Media3 `DataSource` is *not* the owner of this stream: Media3 closes and
/// reopens its data source around every seek, so stream lifetime follows the
/// playback generation instead of the data source session.
struct StreamState {
    reader: Mutex<Box<dyn ReadSeek>>,
    content_length: u64,
    monitor: Option<ProgressiveMonitor>,
    retired: AtomicBool,
    /// Cursor owner across JNI calls; `Some(lease_id)` while a lease holds it.
    cursor_owner: Mutex<Option<i64>>,
    cursor_released: Condvar,
}

impl StreamState {
    fn is_retired(&self) -> bool {
        self.retired.load(Ordering::Acquire)
    }

    /// Wakes a read blocked on a progressive range segment.
    ///
    /// Cancellation is only requested when the stream is retired, never when a
    /// data source closes, so reopening after a seek keeps working.
    fn wake_blocked_reads(&self) {
        if let Some(monitor) = &self.monitor {
            monitor.cancel();
        }
    }
}

/// One `NativeAudioDataSource` session over a [`StreamState`].
struct StreamLease {
    stream_id: i64,
    stream: Arc<StreamState>,
}

static STREAMS: OnceLock<Mutex<HashMap<i64, Arc<StreamState>>>> = OnceLock::new();
static STREAM_LEASES: OnceLock<Mutex<HashMap<i64, Arc<StreamLease>>>> = OnceLock::new();
static NEXT_STREAM_ID: AtomicI64 = AtomicI64::new(1);
static NEXT_LEASE_ID: AtomicI64 = AtomicI64::new(1);

fn streams() -> &'static Mutex<HashMap<i64, Arc<StreamState>>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn leases() -> &'static Mutex<HashMap<i64, Arc<StreamLease>>> {
    STREAM_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_stream(
    stream: Box<dyn ReadSeek>,
    content_length: u64,
    monitor: Option<ProgressiveMonitor>,
) -> i64 {
    let id = NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed);
    let state = Arc::new(StreamState {
        reader: Mutex::new(stream),
        content_length,
        monitor,
        retired: AtomicBool::new(false),
        cursor_owner: Mutex::new(None),
        cursor_released: Condvar::new(),
    });
    match streams().lock() {
        Ok(mut map) => {
            map.insert(id, state);
        }
        Err(poisoned) => {
            poisoned.into_inner().insert(id, state);
        }
    }
    id
}

/// Resolves a stream id without holding the registry lock across any I/O.
fn stream_state(id: i64) -> Option<Arc<StreamState>> {
    match streams().lock() {
        Ok(map) => map.get(&id).map(Arc::clone),
        Err(poisoned) => poisoned.into_inner().get(&id).map(Arc::clone),
    }
}

/// Ends a stream's life.
///
/// This is the only path that retires a stream. It runs when the playback
/// generation is replaced (`load`) or when playback stops, so a Media3 data
/// source close never destroys the underlying stream.
fn retire_stream(id: i64) {
    let state = match streams().lock() {
        Ok(mut map) => map.remove(&id),
        Err(poisoned) => poisoned.into_inner().remove(&id),
    };
    let Some(state) = state else {
        return;
    };
    state.retired.store(true, Ordering::Release);
    if let Ok(mut owner) = state.cursor_owner.lock() {
        *owner = None;
    }
    state.cursor_released.notify_all();
    // Wake a read blocked inside a progressive range wait.
    state.wake_blocked_reads();
    match leases().lock() {
        Ok(mut map) => map.retain(|_, lease| lease.stream_id != id),
        Err(poisoned) => poisoned
            .into_inner()
            .retain(|_, lease| lease.stream_id != id),
    }
    if let Some(lease) = take_active_lease(id) {
        release_lease(lease);
    }
}

fn lease_for(lease_id: i64) -> Option<Arc<StreamLease>> {
    match leases().lock() {
        Ok(map) => map.get(&lease_id).map(Arc::clone),
        Err(poisoned) => poisoned.into_inner().get(&lease_id).map(Arc::clone),
    }
}

/// Takes a cursor lease over `stream_id`.
fn acquire_lease_with_timeout(stream_id: i64, wait: Duration) -> i64 {
    let Some(state) = stream_state(stream_id) else {
        return STREAM_ERR_UNKNOWN_ID as i64;
    };
    if state.is_retired() {
        return STREAM_ERR_CANCELLED as i64;
    }
    let lease_id = NEXT_LEASE_ID.fetch_add(1, Ordering::Relaxed);
    let mut owner = match state.cursor_owner.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let deadline = Instant::now() + wait;
    while owner.is_some() {
        if state.is_retired() {
            return STREAM_ERR_CANCELLED as i64;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return STREAM_ERR_BUSY as i64;
        }
        let (next, _) = state
            .cursor_released
            .wait_timeout(owner, remaining)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        owner = next;
    }
    if state.is_retired() {
        return STREAM_ERR_CANCELLED as i64;
    }
    *owner = Some(lease_id);
    drop(owner);
    let lease = Arc::new(StreamLease {
        stream_id,
        stream: Arc::clone(&state),
    });
    match leases().lock() {
        Ok(mut map) => {
            map.insert(lease_id, lease);
        }
        Err(poisoned) => {
            poisoned.into_inner().insert(lease_id, lease);
        }
    }
    lease_id
}

fn acquire_lease(stream_id: i64) -> i64 {
    acquire_lease_with_timeout(stream_id, LEASE_WAIT_TIMEOUT)
}

/// Releases a data source session. The underlying stream stays alive.
fn release_lease(lease_id: i64) {
    let lease = match leases().lock() {
        Ok(mut map) => map.remove(&lease_id),
        Err(poisoned) => poisoned.into_inner().remove(&lease_id),
    };
    let Some(lease) = lease else {
        return;
    };
    if let Ok(mut owner) = lease.stream.cursor_owner.lock() {
        if *owner == Some(lease_id) {
            *owner = None;
        }
    }
    lease.stream.cursor_released.notify_all();
}

/// Seeks the leased cursor and returns the remaining byte count, or a negative
/// [`STREAM_ERR_*`] code.
fn seek_lease(lease_id: i64, position: i64) -> i64 {
    let Some(lease) = lease_for(lease_id) else {
        return STREAM_ERR_UNKNOWN_ID as i64;
    };
    let stream = &lease.stream;
    if stream.is_retired() {
        return STREAM_ERR_CANCELLED as i64;
    }
    let pos = position.max(0) as u64;
    if pos > stream.content_length {
        return STREAM_ERR_IO as i64;
    }
    let mut reader = match stream.reader.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if reader.seek(SeekFrom::Start(pos)).is_err() {
        return STREAM_ERR_IO as i64;
    }
    stream.content_length.saturating_sub(pos) as i64
}

/// Reads into `buffer`, returning the byte count or a negative [`STREAM_ERR_*`]
/// code. `STREAM_OK_EOF` is reserved for a genuine end of stream.
fn read_lease(lease_id: i64, buffer: &mut [u8]) -> jint {
    let Some(lease) = lease_for(lease_id) else {
        return STREAM_ERR_UNKNOWN_ID;
    };
    let stream = &lease.stream;
    if stream.is_retired() {
        return STREAM_ERR_CANCELLED;
    }
    if buffer.is_empty() {
        return STREAM_OK_EOF;
    }
    let mut reader = match stream.reader.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match reader.read(buffer) {
        Ok(0) => STREAM_OK_EOF,
        Ok(bytes) => bytes as jint,
        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => STREAM_ERR_CANCELLED,
        Err(_) => STREAM_ERR_IO,
    }
}

/// The lease currently backing each Media3 data source, keyed by stream id.
///
/// Media3 identifies the stream on every JNI call, not the data source session,
/// so the session that owns the cursor is tracked here instead of on the wire.
static ACTIVE_LEASES: OnceLock<Mutex<HashMap<i64, i64>>> = OnceLock::new();

fn active_leases() -> &'static Mutex<HashMap<i64, i64>> {
    ACTIVE_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn take_active_lease(stream_id: i64) -> Option<i64> {
    match active_leases().lock() {
        Ok(mut map) => map.remove(&stream_id),
        Err(poisoned) => poisoned.into_inner().remove(&stream_id),
    }
}

fn put_active_lease(stream_id: i64, lease_id: i64) {
    match active_leases().lock() {
        Ok(mut map) => {
            map.insert(stream_id, lease_id);
        }
        Err(poisoned) => {
            poisoned.into_inner().insert(stream_id, lease_id);
        }
    }
}

/// Opens a Media3 data source session over `stream_id`.
///
/// Media3 closes and reopens its data source around every seek, so a new open
/// takes the cursor over from the previous session instead of failing or
/// destroying the stream.
fn open_stream(stream_id: i64, position: i64) -> i64 {
    if let Some(previous) = take_active_lease(stream_id) {
        release_lease(previous);
    }
    let lease = acquire_lease(stream_id);
    if lease <= 0 {
        return lease;
    }
    let remaining = seek_lease(lease, position);
    if remaining < 0 {
        release_lease(lease);
        return remaining;
    }
    put_active_lease(stream_id, lease);
    remaining
}

/// Reads from the session currently open over `stream_id`.
fn read_stream(stream_id: i64, buffer: &mut [u8]) -> jint {
    let lease = match active_leases().lock() {
        Ok(map) => map.get(&stream_id).copied(),
        Err(poisoned) => poisoned.into_inner().get(&stream_id).copied(),
    };
    let Some(lease) = lease else {
        return STREAM_ERR_UNKNOWN_ID;
    };
    read_lease(lease, buffer)
}

/// Closes a data source session without ending the underlying stream.
fn close_stream(stream_id: i64) {
    if let Some(lease) = take_active_lease(stream_id) {
        release_lease(lease);
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
    error_kind: Option<String>,
    source_generation: u64,
    active_stream_id: i64,
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
            error_kind: None,
            source_generation: 0,
            active_stream_id: 0,
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

    /// Latest progressive transfer failure for the stream backing this engine.
    fn current_stream_monitor_error(&self) -> Option<ProgressiveError> {
        let stream_id = self.current_stream_id.load(Ordering::Relaxed);
        if stream_id == 0 {
            return None;
        }
        let streams = match streams().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        streams
            .get(&stream_id)
            .and_then(|state| state.monitor.as_ref())
            .and_then(ProgressiveMonitor::error_kind)
    }
}

impl AudioEngine for AndroidAudioEngine {
    fn load(&self, source: &PreparedPlaybackSource) -> Result<AudioLoadMetadata, AudioEngineError> {
        let location = open_playback_stream(source)?;
        let (stream_id, local_path) = match location {
            PlaybackStreamLocation::Local(path) => {
                let prev_id = self.current_stream_id.swap(0, Ordering::Relaxed);
                if prev_id != 0 {
                    retire_stream(prev_id);
                }
                (0, Some(path.to_string_lossy().to_string()))
            }
            PlaybackStreamLocation::Stream {
                reader,
                content_length,
                monitor,
            } => {
                let prev_id = self.current_stream_id.swap(0, Ordering::Relaxed);
                if prev_id != 0 {
                    retire_stream(prev_id);
                }
                let sid = register_stream(reader, content_length, monitor);
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
            error_kind: None,
            source_generation: generation,
            // Reports carry the stream id they belong to, so a callback queued by
            // the previous track is rejected instead of overwriting this source.
            active_stream_id: stream_id,
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
            retire_stream(prev_id);
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
        // Media3 reports failures asynchronously, after `load` has already
        // returned success. Classifying them here lets Core's recoverable-error
        // and link-expiry paths react on the next tick instead of seeing every
        // failure as an output-device problem.
        //
        // The progressive monitor is the authoritative expiry signal: it is the
        // only component that sees the upstream HTTP status.
        let monitor_error = self.current_stream_monitor_error();
        let (source_error, source_url_expired, output_error) =
            if matches!(monitor_error, Some(ProgressiveError::UrlExpired)) {
                (
                    st.error
                        .clone()
                        .or_else(|| Some(ProgressiveError::UrlExpired.to_string())),
                    true,
                    None,
                )
            } else {
                match st.error_kind.as_deref() {
                    Some("source-expired") => (st.error.clone(), true, None),
                    Some("source") | Some("network") | Some("decoder") => {
                        (st.error.clone(), false, None)
                    }
                    _ => (None, false, st.error.clone()),
                }
            };
        let decoder_error = if matches!(st.error_kind.as_deref(), Some("decoder")) {
            st.error.clone()
        } else {
            None
        };
        AudioEngineSnapshot {
            loaded: st.loaded,
            playing: st.playing,
            paused: st.paused,
            ended: st.ended,
            position_ms: current_position,
            duration_ms: st.duration_ms,
            output_error,
            source_error,
            decoder_error,
            source_url_expired,
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
    stream_id: jlong,
    position_ms: jlong,
    duration_ms: jlong,
    is_playing: jboolean,
    is_buffering: jboolean,
    is_ended: jboolean,
    error_kind: JString<'_>,
    error: JString<'_>,
) {
    let _ = env.with_env(|env| {
        let error_str = if error.is_null() {
            None
        } else {
            Some(jstring(env, error))
        };
        let error_kind_str = if error_kind.is_null() {
            None
        } else {
            Some(jstring(env, error_kind))
        };
        let has_error = error_str.is_some() || error_kind_str.is_some();

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
                // Drop reports from a data source that has already been replaced.
                if stream_id != 0 && stream_id != st.active_stream_id {
                    return Ok(());
                }
                st.position_ms = position_ms.max(0) as u64;
                st.last_position_update = Instant::now();
                if duration_ms < 0 {
                    st.duration_ms = None;
                } else if duration_ms > 0 {
                    st.duration_ms = Some(duration_ms as u64);
                }
                st.playing = is_playing;
                st.buffering = is_buffering;
                st.ended = is_ended;
                if is_ended {
                    st.playing = false;
                }
                st.error = error_str;
                st.error_kind = error_kind_str;
            }
            if is_ended || has_error {
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
    open_stream(stream_id, position)
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
        return STREAM_OK_EOF;
    }
    let mut temp_buf = vec![0u8; length.min(64 * 1024)];
    let read = read_stream(stream_id, &mut temp_buf);
    if read <= 0 {
        return read;
    }
    let bytes = read as usize;
    let res = env.with_env(|env| -> Result<(), jni::errors::Error> {
        let slice: &[i8] =
            unsafe { std::slice::from_raw_parts(temp_buf[..bytes].as_ptr().cast::<i8>(), bytes) };
        buffer.set_region(env, offset as jsize, slice)?;
        Ok(())
    });
    match res.into_outcome() {
        jni::Outcome::Ok(_) => read,
        // The bytes never reached Kotlin, so this must not look like EOF.
        _ => STREAM_ERR_INTERNAL,
    }
}

#[no_mangle]
pub extern "system" fn Java_org_yaqmc_android_core_CoreManager_nativeStreamClose(
    _env: EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    stream_id: jlong,
) {
    close_stream(stream_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, thread};

    fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        predicate()
    }

    /// A reader that parks until the test releases it, standing in for a
    /// progressive range request that has not completed yet.
    struct ParkingReader {
        started: Arc<AtomicBool>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Read for ParkingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            self.started.store(true, Ordering::Release);
            let (lock, condvar) = &*self.release;
            let mut released = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let deadline = Instant::now() + Duration::from_secs(10);
            while !*released {
                if Instant::now() >= deadline {
                    break;
                }
                released = condvar
                    .wait_timeout(released, Duration::from_millis(50))
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
            Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "parked reader released",
            ))
        }
    }

    impl Seek for ParkingReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            Ok(match position {
                SeekFrom::Start(value) => value,
                _ => 0,
            })
        }
    }

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
    fn stream_survives_data_source_close_and_reopen() {
        use std::io::Cursor;
        let data: Vec<u8> = (0u8..32).collect();
        let id = register_stream(Box::new(Cursor::new(data)), 32, None);
        assert!(id > 0);

        assert_eq!(open_stream(id, 0), 32);
        let mut buf = [0u8; 4];
        assert_eq!(read_stream(id, &mut buf), 4);
        assert_eq!(buf, [0, 1, 2, 3]);

        // Media3 closes and reopens its data source around every seek. The
        // stream has to outlive that close, which is the F-02 regression.
        close_stream(id);
        assert_eq!(open_stream(id, 8), 24);
        let mut buf = [0u8; 2];
        assert_eq!(read_stream(id, &mut buf), 2);
        assert_eq!(buf, [8, 9]);
        close_stream(id);

        // Only generation eviction or an explicit stop ends the stream.
        retire_stream(id);
        assert_eq!(open_stream(id, 0), STREAM_ERR_UNKNOWN_ID as i64);
    }

    #[test]
    fn read_distinguishes_eof_from_failures() {
        use std::io::Cursor;
        let id = register_stream(Box::new(Cursor::new(vec![1u8, 2, 3])), 3, None);
        assert_eq!(open_stream(id, 0), 3);

        let mut buf = [0u8; 8];
        assert_eq!(read_stream(id, &mut buf), 3);
        // A genuine end of stream is 0, never a negative error code.
        assert_eq!(read_stream(id, &mut buf), STREAM_OK_EOF);

        // Seeking past the end is an I/O failure, not EOF.
        assert_eq!(open_stream(id, 99), STREAM_ERR_IO as i64);
        // An unknown stream never looks like data or like a silent EOF.
        assert_eq!(read_stream(id + 1_000, &mut buf), STREAM_ERR_UNKNOWN_ID);

        retire_stream(id);
        let after_retire = read_stream(id, &mut buf);
        assert!(
            after_retire == STREAM_ERR_UNKNOWN_ID || after_retire == STREAM_ERR_CANCELLED,
            "retired stream read returned {after_retire}"
        );
        let open_after_retire = open_stream(id, 0);
        assert!(
            open_after_retire == STREAM_ERR_UNKNOWN_ID as i64
                || open_after_retire == STREAM_ERR_CANCELLED as i64,
            "retired stream open returned {open_after_retire}"
        );
    }

    #[test]
    fn a_new_data_source_session_takes_over_the_cursor() {
        use std::io::Cursor;
        let data: Vec<u8> = (0u8..16).collect();
        let id = register_stream(Box::new(Cursor::new(data)), 16, None);
        assert_eq!(open_stream(id, 0), 16);
        // Media3 can reopen at a new position before the previous session is
        // closed; that must neither fail nor retire the stream.
        assert_eq!(open_stream(id, 4), 12);
        let mut buf = [0u8; 2];
        assert_eq!(read_stream(id, &mut buf), 2);
        assert_eq!(buf, [4, 5]);
        close_stream(id);
        assert_eq!(open_stream(id, 12), 4);
        retire_stream(id);
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
            error_kind: None,
            source_generation: 1,
            active_stream_id: 7,
        };
        let elapsed = state.last_position_update.elapsed().as_millis() as u64;
        let current_pos = (state.position_ms + elapsed).min(state.duration_ms.unwrap_or(u64::MAX));
        assert!(current_pos >= 1_150);
    }

    #[test]
    fn retiring_a_stream_does_not_wait_for_an_in_flight_read() {
        let started = Arc::new(AtomicBool::new(false));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let reader = ParkingReader {
            started: Arc::clone(&started),
            release: Arc::clone(&release),
        };
        let id = register_stream(Box::new(reader), 8, None);
        assert_eq!(open_stream(id, 0), 8);

        let reader_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 4];
            read_stream(id, &mut buffer)
        });
        assert!(wait_until(Duration::from_secs(5), || started.load(Ordering::Acquire)));

        // Retirement must not block on the reader: it only flips `retired`,
        // notifies waiters and wakes the progressive monitor.
        let retire_started = Instant::now();
        retire_stream(id);
        assert!(
            retire_started.elapsed() < Duration::from_secs(1),
            "retire_stream blocked for {:?}",
            retire_started.elapsed()
        );

        let (lock, condvar) = &*release;
        *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        condvar.notify_all();
        let result = reader_thread.join().expect("parked reader thread");
        assert!(
            result == STREAM_ERR_IO || result == STREAM_ERR_CANCELLED,
            "a released parked reader returned {result}"
        );
        // The stream is gone, so a late open can never reattach to it.
        assert_eq!(open_stream(id, 0), STREAM_ERR_UNKNOWN_ID as i64);
    }

    #[test]
    fn an_evicted_generation_cannot_read_the_replacement_stream() {
        let evicted = register_stream(Box::new(Cursor::new(vec![1_u8; 8])), 8, None);
        assert_eq!(open_stream(evicted, 0), 8);
        let mut buffer = [0_u8; 2];
        assert_eq!(read_stream(evicted, &mut buffer), 2);
        close_stream(evicted);
        retire_stream(evicted);

        let replacement = register_stream(Box::new(Cursor::new(vec![2_u8; 8])), 8, None);
        assert_eq!(open_stream(replacement, 0), 8);

        // A late callback from the evicted generation must not observe or
        // disturb the replacement stream.
        assert_eq!(read_stream(evicted, &mut buffer), STREAM_ERR_UNKNOWN_ID);
        assert_eq!(open_stream(evicted, 0), STREAM_ERR_UNKNOWN_ID as i64);
        close_stream(evicted);

        let mut replacement_bytes = [0_u8; 4];
        assert_eq!(read_stream(replacement, &mut replacement_bytes), 4);
        assert_eq!(replacement_bytes, [2, 2, 2, 2]);
        retire_stream(replacement);
    }

    #[test]
    fn concurrent_readers_on_distinct_streams_do_not_deadlock() {
        let data = || (0_u8..64).collect::<Vec<u8>>();
        let first = register_stream(Box::new(Cursor::new(data())), 64, None);
        let second = register_stream(Box::new(Cursor::new(data())), 64, None);
        assert_eq!(open_stream(first, 0), 64);
        assert_eq!(open_stream(second, 0), 64);

        let started = Instant::now();
        let handles: Vec<_> = [first, second]
            .into_iter()
            .map(|id| {
                thread::spawn(move || {
                    let mut read = 0_u64;
                    let mut buffer = [0_u8; 8];
                    loop {
                        match read_stream(id, &mut buffer) {
                            0 => break,
                            bytes if bytes > 0 => read += bytes as u64,
                            other => panic!("read_stream returned {other}"),
                        }
                    }
                    read
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().expect("reader thread"), 64);
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "concurrent readers took {:?}",
            started.elapsed()
        );
        retire_stream(first);
        retire_stream(second);
    }
}
