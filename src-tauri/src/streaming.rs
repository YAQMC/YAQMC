use crate::storage::{CachedFile, StorageError, StorageService};
use reqwest::{
    header::{HeaderMap, ACCEPT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, RANGE},
    Client, StatusCode,
};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use thiserror::Error;

const REQUESTED_SEGMENT_BYTES: u64 = 512 * 1024;
const MIN_SEGMENT_BYTES: u64 = 64 * 1024;
const PREFETCH_SEGMENTS: usize = 3;
const RANGE_WAIT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ProgressiveError {
    #[error("the progressive media request failed")]
    Network,
    #[error("the provider media URL expired")]
    UrlExpired,
    #[error("the server returned an invalid HTTP range response")]
    InvalidRange,
    #[error("the server does not support byte-range playback")]
    RangeUnsupported,
    #[error("the media response exceeded the configured cache limit")]
    ResponseTooLarge,
    #[error("the progressive media cache failed")]
    Cache,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ContentRange {
    start: u64,
    end: u64,
    total: u64,
}

#[derive(Debug)]
pub enum ProgressivePreparation {
    Complete(CachedFile),
    Progressive(ProgressiveSource),
    FullDownloadFallback,
}

pub struct ProgressiveSource {
    inner: Arc<ProgressiveInner>,
}

impl Clone for ProgressiveSource {
    fn clone(&self) -> Self {
        self.inner.source_count.fetch_add(1, Ordering::AcqRel);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl std::fmt::Debug for ProgressiveSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProgressiveSource")
            .field("content_length", &self.inner.content_length)
            .field("segment_size", &self.inner.segment_size)
            .field("cache_key", &self.inner.cache_key)
            .finish_non_exhaustive()
    }
}

impl Drop for ProgressiveSource {
    fn drop(&mut self) {
        if self.inner.source_count.fetch_sub(1, Ordering::AcqRel) == 1
            && self.inner.reader_count.load(Ordering::Acquire) == 0
        {
            self.inner.cancelled.store(true, Ordering::Release);
            self.inner.ready.notify_all();
        }
    }
}

#[derive(Clone)]
pub struct ProgressiveMonitor {
    inner: Arc<ProgressiveInner>,
}

impl ProgressiveMonitor {
    pub fn is_waiting(&self) -> bool {
        self.inner.waiting.load(Ordering::Acquire)
    }

    pub fn error(&self) -> Option<String> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .error
            .as_ref()
            .map(ToString::to_string)
    }

    pub fn error_kind(&self) -> Option<ProgressiveError> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .error
            .clone()
    }

    pub fn downloaded_bytes(&self) -> u64 {
        self.inner.downloaded_bytes.load(Ordering::Acquire)
    }

    pub fn content_length(&self) -> u64 {
        self.inner.content_length
    }
}

struct ProgressiveInner {
    url: String,
    headers: HeaderMap,
    path: PathBuf,
    content_length: u64,
    segment_size: u64,
    cache_key: String,
    extension: String,
    mime_type: Option<String>,
    storage: Arc<StorageService>,
    state: Mutex<SegmentState>,
    ready: Condvar,
    waiting: AtomicBool,
    cancelled: AtomicBool,
    reader_count: AtomicUsize,
    source_count: AtomicUsize,
    downloaded_bytes: AtomicU64,
}

struct SegmentState {
    available: Vec<bool>,
    requested: VecDeque<usize>,
    in_flight: Option<usize>,
    next_prefetch: usize,
    error: Option<ProgressiveError>,
    promoted: bool,
}

pub struct ProgressiveReader {
    inner: Arc<ProgressiveInner>,
    file: File,
    position: u64,
}

impl Drop for ProgressiveReader {
    fn drop(&mut self) {
        if self.inner.reader_count.fetch_sub(1, Ordering::AcqRel) == 1
            && self.inner.source_count.load(Ordering::Acquire) == 0
        {
            self.inner.cancelled.store(true, Ordering::Release);
            self.inner.ready.notify_all();
        }
    }
}

impl ProgressiveSource {
    pub fn content_length(&self) -> u64 {
        self.inner.content_length
    }

    pub fn monitor(&self) -> ProgressiveMonitor {
        ProgressiveMonitor {
            inner: Arc::clone(&self.inner),
        }
    }

    pub fn open_reader(&self) -> Result<ProgressiveReader, ProgressiveError> {
        let file = File::open(&self.inner.path).map_err(|_| ProgressiveError::Cache)?;
        self.inner.reader_count.fetch_add(1, Ordering::AcqRel);
        Ok(ProgressiveReader {
            inner: Arc::clone(&self.inner),
            file,
            position: 0,
        })
    }
}

impl Read for ProgressiveReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.position >= self.inner.content_length {
            return Ok(0);
        }
        let segment = (self.position / self.inner.segment_size) as usize;
        self.ensure_segment(segment)?;
        self.queue_prefetch(segment);

        let segment_end =
            ((segment as u64 + 1) * self.inner.segment_size).min(self.inner.content_length);
        let available = segment_end.saturating_sub(self.position) as usize;
        let wanted = buffer.len().min(available);
        self.file.seek(SeekFrom::Start(self.position))?;
        let read = self.file.read(&mut buffer[..wanted])?;
        self.position = self.position.saturating_add(read as u64);
        Ok(read)
    }
}

impl Seek for ProgressiveReader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::End(offset) => i128::from(self.inner.content_length) + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
        };
        if !(0..=i128::from(self.inner.content_length)).contains(&next) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek is outside the progressive media source",
            ));
        }
        self.position = next as u64;
        Ok(self.position)
    }
}

impl ProgressiveReader {
    fn ensure_segment(&self, segment: usize) -> io::Result<()> {
        let deadline = Instant::now() + RANGE_WAIT_TIMEOUT;
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if segment >= state.available.len() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "range segment is outside the media source",
            ));
        }
        if !state.available[segment]
            && state.in_flight != Some(segment)
            && !state.requested.contains(&segment)
        {
            state.requested.push_front(segment);
            self.inner.ready.notify_all();
        }

        while !state.available[segment] {
            if let Some(error) = &state.error {
                return Err(io::Error::other(error.to_string()));
            }
            if self.inner.cancelled.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "progressive media request was cancelled",
                ));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "progressive media range timed out",
                ));
            }
            self.inner.waiting.store(true, Ordering::Release);
            let (next, _) = self
                .inner
                .ready
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
        self.inner.waiting.store(false, Ordering::Release);
        Ok(())
    }

    fn queue_prefetch(&self, segment: usize) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let end = (segment + PREFETCH_SEGMENTS + 1).min(state.available.len());
        for candidate in segment + 1..end {
            if !state.available[candidate]
                && state.in_flight != Some(candidate)
                && !state.requested.contains(&candidate)
            {
                state.requested.push_back(candidate);
            }
        }
        self.inner.ready.notify_all();
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn prepare_progressive(
    client: &Client,
    storage: Arc<StorageService>,
    cache_key: String,
    url: String,
    headers: HeaderMap,
    extension: String,
    mime_type: Option<String>,
    max_bytes: u64,
) -> Result<ProgressivePreparation, ProgressiveError> {
    if let Some(cached) = storage
        .lookup_cached_file(&cache_key)
        .map_err(map_storage_error)?
    {
        return Ok(ProgressivePreparation::Complete(cached));
    }

    let requested_end = REQUESTED_SEGMENT_BYTES.saturating_sub(1);
    let request_started = Instant::now();
    let response = client
        .get(&url)
        .headers(headers.clone())
        .header(ACCEPT_ENCODING, "identity")
        .header(RANGE, format!("bytes=0-{requested_end}"))
        .send()
        .await
        .map_err(|error| {
            tracing::debug!(target: "stream.range", error = %error, "initial progressive media request failed");
            ProgressiveError::Network
        })?;

    tracing::debug!(
        target: "stream.range",
        status = response.status().as_u16(),
        elapsed_ms = request_started.elapsed().as_millis() as u64,
        requested_start = 0,
        requested_end,
        "initial media range response received"
    );

    if is_expired_status(response.status()) {
        return Err(ProgressiveError::UrlExpired);
    }
    match response.status() {
        StatusCode::OK => return Ok(ProgressivePreparation::FullDownloadFallback),
        StatusCode::RANGE_NOT_SATISFIABLE => {
            validate_unsatisfied_range(response.headers(), max_bytes)?;
            return Ok(ProgressivePreparation::FullDownloadFallback);
        }
        StatusCode::PARTIAL_CONTENT => {}
        _ => return Err(ProgressiveError::Network),
    }

    let content_range = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range)
        .ok_or(ProgressiveError::InvalidRange)?;
    if content_range.start != 0 || content_range.total == 0 {
        return Err(ProgressiveError::InvalidRange);
    }
    if content_range.total > max_bytes {
        return Err(ProgressiveError::ResponseTooLarge);
    }
    let expected = content_range.end.saturating_add(1);
    let first = response
        .bytes()
        .await
        .map_err(|_| ProgressiveError::Network)?;
    tracing::info!(
        target: "stream.buffer",
        initial_bytes = first.len(),
        total_bytes = content_range.total,
        first_bytes_ms = request_started.elapsed().as_millis() as u64,
        prefetch_segments = PREFETCH_SEGMENTS,
        "progressive media buffer initialized"
    );
    if first.len() as u64 != expected {
        return Err(ProgressiveError::InvalidRange);
    }
    if expected < MIN_SEGMENT_BYTES && expected < content_range.total {
        return Err(ProgressiveError::InvalidRange);
    }
    let segment_size = expected;
    let segment_count = content_range.total.div_ceil(segment_size) as usize;
    let path = storage
        .progressive_temp_path(&cache_key, &extension)
        .map_err(map_storage_error)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|_| ProgressiveError::Cache)?;
    file.set_len(content_range.total)
        .map_err(|_| ProgressiveError::Cache)?;
    file.write_all(&first)
        .map_err(|_| ProgressiveError::Cache)?;
    file.flush().map_err(|_| ProgressiveError::Cache)?;

    let mut available = vec![false; segment_count];
    available[0] = true;
    let inner = Arc::new(ProgressiveInner {
        url,
        headers,
        path,
        content_length: content_range.total,
        segment_size,
        cache_key,
        extension,
        mime_type,
        storage,
        state: Mutex::new(SegmentState {
            available,
            requested: VecDeque::new(),
            in_flight: None,
            next_prefetch: 1,
            error: None,
            promoted: false,
        }),
        ready: Condvar::new(),
        waiting: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        reader_count: AtomicUsize::new(0),
        source_count: AtomicUsize::new(1),
        downloaded_bytes: AtomicU64::new(first.len() as u64),
    });
    start_range_worker(Arc::clone(&inner))?;
    Ok(ProgressivePreparation::Progressive(ProgressiveSource {
        inner,
    }))
}

fn start_range_worker(inner: Arc<ProgressiveInner>) -> Result<(), ProgressiveError> {
    thread::Builder::new()
        .name("progressive-range-cache".to_owned())
        .spawn(move || range_worker(inner))
        .map(|_| ())
        .map_err(|_| ProgressiveError::Cache)
}

fn range_worker(inner: Arc<ProgressiveInner>) {
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .user_agent("YAQMC/0.1 progressive-stream")
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            set_error(&inner, ProgressiveError::Network);
            return;
        }
    };

    loop {
        if inner.cancelled.load(Ordering::Acquire) {
            break;
        }
        let segment = {
            let mut state = inner
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.error.is_some() {
                break;
            }
            let requested = loop {
                match state.requested.pop_front() {
                    Some(candidate) if !state.available[candidate] => break Some(candidate),
                    Some(_) => continue,
                    None => break None,
                }
            };
            let candidate = requested.or_else(|| {
                while state.next_prefetch < state.available.len()
                    && state.available[state.next_prefetch]
                {
                    state.next_prefetch += 1;
                }
                (state.next_prefetch < state.available.len()).then_some(state.next_prefetch)
            });
            let Some(candidate) = candidate else {
                if !state.promoted {
                    state.promoted = true;
                    drop(state);
                    if let Err(error) = promote_complete_source(&inner) {
                        tracing::warn!(target: "media", error = %error, "progressive cache promotion failed");
                    }
                }
                break;
            };
            state.in_flight = Some(candidate);
            candidate
        };

        match fetch_segment(&client, &inner, segment) {
            Ok(SegmentFetch::Partial(bytes)) => {
                if write_segment(&inner, segment, &bytes).is_err() {
                    set_error(&inner, ProgressiveError::Cache);
                    break;
                }
                let mut state = inner
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.available[segment] = true;
                state.in_flight = None;
                if state.next_prefetch == segment {
                    state.next_prefetch += 1;
                }
                inner
                    .downloaded_bytes
                    .fetch_add(bytes.len() as u64, Ordering::AcqRel);
                inner.waiting.store(false, Ordering::Release);
                inner.ready.notify_all();
            }
            Ok(SegmentFetch::Complete(bytes)) => {
                if write_complete(&inner, &bytes).is_err() {
                    set_error(&inner, ProgressiveError::Cache);
                    break;
                }
                let mut state = inner
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.available.fill(true);
                state.in_flight = None;
                inner
                    .downloaded_bytes
                    .store(inner.content_length, Ordering::Release);
                inner.waiting.store(false, Ordering::Release);
                inner.ready.notify_all();
            }
            Err(error) => {
                set_error(&inner, error);
                break;
            }
        }
    }
    inner.ready.notify_all();
}

enum SegmentFetch {
    Partial(Vec<u8>),
    Complete(Vec<u8>),
}

fn fetch_segment(
    client: &reqwest::blocking::Client,
    inner: &ProgressiveInner,
    segment: usize,
) -> Result<SegmentFetch, ProgressiveError> {
    let start = segment as u64 * inner.segment_size;
    let end = start
        .saturating_add(inner.segment_size.saturating_sub(1))
        .min(inner.content_length.saturating_sub(1));
    let response = client
        .get(&inner.url)
        .headers(inner.headers.clone())
        .header(ACCEPT_ENCODING, "identity")
        .header(RANGE, format!("bytes={start}-{end}"))
        .send()
        .map_err(|_| ProgressiveError::Network)?;
    if is_expired_status(response.status()) {
        return Err(ProgressiveError::UrlExpired);
    }
    match response.status() {
        StatusCode::PARTIAL_CONTENT => {
            let content_range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range)
                .ok_or(ProgressiveError::InvalidRange)?;
            if content_range.start != start
                || content_range.end != end
                || content_range.total != inner.content_length
            {
                return Err(ProgressiveError::InvalidRange);
            }
            let bytes = response.bytes().map_err(|_| ProgressiveError::Network)?;
            if bytes.len() as u64 != end.saturating_sub(start).saturating_add(1) {
                return Err(ProgressiveError::InvalidRange);
            }
            Ok(SegmentFetch::Partial(bytes.to_vec()))
        }
        StatusCode::OK => {
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|length| length != inner.content_length)
            {
                return Err(ProgressiveError::InvalidRange);
            }
            let bytes = response.bytes().map_err(|_| ProgressiveError::Network)?;
            if bytes.len() as u64 != inner.content_length {
                return Err(ProgressiveError::RangeUnsupported);
            }
            Ok(SegmentFetch::Complete(bytes.to_vec()))
        }
        StatusCode::RANGE_NOT_SATISFIABLE => Err(ProgressiveError::InvalidRange),
        _ => Err(ProgressiveError::Network),
    }
}

fn write_segment(
    inner: &ProgressiveInner,
    segment: usize,
    bytes: &[u8],
) -> Result<(), ProgressiveError> {
    let mut file = OpenOptions::new()
        .write(true)
        .open(&inner.path)
        .map_err(|_| ProgressiveError::Cache)?;
    file.seek(SeekFrom::Start(segment as u64 * inner.segment_size))
        .map_err(|_| ProgressiveError::Cache)?;
    file.write_all(bytes).map_err(|_| ProgressiveError::Cache)?;
    file.flush().map_err(|_| ProgressiveError::Cache)
}

fn write_complete(inner: &ProgressiveInner, bytes: &[u8]) -> Result<(), ProgressiveError> {
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&inner.path)
        .map_err(|_| ProgressiveError::Cache)?;
    file.write_all(bytes).map_err(|_| ProgressiveError::Cache)?;
    file.flush().map_err(|_| ProgressiveError::Cache)
}

fn promote_complete_source(inner: &ProgressiveInner) -> Result<(), ProgressiveError> {
    inner
        .storage
        .promote_progressive(
            &inner.cache_key,
            &inner.path,
            &inner.extension,
            inner.content_length,
            inner.mime_type.as_deref(),
        )
        .map(|_| ())
        .map_err(map_storage_error)
}

fn set_error(inner: &ProgressiveInner, error: ProgressiveError) {
    let mut state = inner
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.error = Some(error);
    state.in_flight = None;
    inner.waiting.store(false, Ordering::Release);
    inner.ready.notify_all();
}

fn is_expired_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::GONE
    )
}

fn validate_unsatisfied_range(headers: &HeaderMap, max_bytes: u64) -> Result<(), ProgressiveError> {
    let value = headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .ok_or(ProgressiveError::InvalidRange)?;
    let total = value
        .strip_prefix("bytes */")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(ProgressiveError::InvalidRange)?;
    if total > max_bytes {
        return Err(ProgressiveError::ResponseTooLarge);
    }
    Ok(())
}

fn parse_content_range(value: &str) -> Option<ContentRange> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let parsed = ContentRange {
        start: start.parse().ok()?,
        end: end.parse().ok()?,
        total: total.parse().ok()?,
    };
    (parsed.start <= parsed.end && parsed.end < parsed.total).then_some(parsed)
}

fn map_storage_error(error: StorageError) -> ProgressiveError {
    match error {
        StorageError::UrlExpired => ProgressiveError::UrlExpired,
        StorageError::Network | StorageError::Http(_) => ProgressiveError::Network,
        StorageError::ResponseTooLarge => ProgressiveError::ResponseTooLarge,
        StorageError::Initialize | StorageError::Database | StorageError::File => {
            ProgressiveError::Cache
        }
    }
}

impl Drop for ProgressiveInner {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, extract::State, response::Response, routing::get, Router};
    use std::{net::TcpListener, sync::atomic::AtomicUsize};

    #[derive(Clone, Copy)]
    enum ServerMode {
        Range,
        IgnoreRange,
        Unsatisfied,
        ExpireAfterInitial,
    }

    struct TestHttpServer {
        url: String,
        stop: Arc<AtomicBool>,
        requests: Arc<AtomicUsize>,
        ranges: Arc<Mutex<Vec<String>>>,
        server_thread: Option<thread::JoinHandle<()>>,
    }

    #[derive(Clone)]
    struct TestServerState {
        bytes: Arc<Vec<u8>>,
        mode: ServerMode,
        segment_delay: Duration,
        requests: Arc<AtomicUsize>,
        ranges: Arc<Mutex<Vec<String>>>,
    }

    impl TestHttpServer {
        fn start(bytes: Vec<u8>, mode: ServerMode, segment_delay: Duration) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
            listener
                .set_nonblocking(true)
                .expect("nonblocking listener");
            let address = listener.local_addr().expect("server address");
            let stop = Arc::new(AtomicBool::new(false));
            let requests = Arc::new(AtomicUsize::new(0));
            let ranges = Arc::new(Mutex::new(Vec::new()));
            let thread_stop = Arc::clone(&stop);
            let thread_requests = Arc::clone(&requests);
            let thread_ranges = Arc::clone(&ranges);
            let server_thread = thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("test HTTP runtime");
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener)
                        .expect("Tokio test HTTP listener");
                    let router = Router::new()
                        .route("/media", get(serve_test_request))
                        .with_state(TestServerState {
                            bytes: Arc::new(bytes),
                            mode,
                            segment_delay,
                            requests: thread_requests,
                            ranges: thread_ranges,
                        });
                    axum::serve(listener, router)
                        .with_graceful_shutdown(async move {
                            while !thread_stop.load(Ordering::Acquire) {
                                tokio::time::sleep(Duration::from_millis(2)).await;
                            }
                        })
                        .await
                        .expect("test HTTP server");
                });
            });
            Self {
                url: format!("http://{address}/media"),
                stop,
                requests,
                ranges,
                server_thread: Some(server_thread),
            }
        }

        fn request_count(&self) -> usize {
            self.requests.load(Ordering::Acquire)
        }
    }

    impl Drop for TestHttpServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(server_thread) = self.server_thread.take() {
                let _ = server_thread.join();
            }
        }
    }

    async fn serve_test_request(
        State(state): State<TestServerState>,
        headers: HeaderMap,
    ) -> Response<Body> {
        let range = headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let request_index = state.requests.fetch_add(1, Ordering::AcqRel);
        if let Some(value) = &range {
            state
                .ranges
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(value.clone());
        }

        if matches!(state.mode, ServerMode::ExpireAfterInitial) && request_index > 0 {
            return test_response(StatusCode::FORBIDDEN, None, Vec::new());
        }
        if matches!(state.mode, ServerMode::Unsatisfied) {
            return test_response(
                StatusCode::RANGE_NOT_SATISFIABLE,
                Some(format!("bytes */{}", state.bytes.len())),
                Vec::new(),
            );
        }
        if matches!(state.mode, ServerMode::IgnoreRange) || range.is_none() {
            return test_response(StatusCode::OK, None, state.bytes.as_ref().clone());
        }

        let range = range
            .as_deref()
            .and_then(|value| value.strip_prefix("bytes="))
            .and_then(|value| value.split_once('-'));
        let Some((start, end)) = range else {
            return test_response(StatusCode::BAD_REQUEST, None, Vec::new());
        };
        let Ok(start) = start.parse::<usize>() else {
            return test_response(StatusCode::BAD_REQUEST, None, Vec::new());
        };
        let end = end
            .parse::<usize>()
            .unwrap_or_else(|_| state.bytes.len().saturating_sub(1))
            .min(state.bytes.len().saturating_sub(1));
        if start >= state.bytes.len() || start > end {
            return test_response(
                StatusCode::RANGE_NOT_SATISFIABLE,
                Some(format!("bytes */{}", state.bytes.len())),
                Vec::new(),
            );
        }
        if start > 0 && !state.segment_delay.is_zero() {
            tokio::time::sleep(state.segment_delay).await;
        }
        test_response(
            StatusCode::PARTIAL_CONTENT,
            Some(format!("bytes {start}-{end}/{}", state.bytes.len())),
            state.bytes[start..=end].to_vec(),
        )
    }

    fn test_response(
        status: StatusCode,
        content_range: Option<String>,
        body: Vec<u8>,
    ) -> Response<Body> {
        let mut builder = Response::builder()
            .status(status)
            .header(CONTENT_LENGTH, body.len());
        if let Some(content_range) = content_range {
            builder = builder.header(CONTENT_RANGE, content_range);
        }
        builder.body(Body::from(body)).expect("test HTTP response")
    }

    fn fixture_bytes(length: usize) -> Vec<u8> {
        (0..length).map(|index| (index % 251) as u8).collect()
    }

    fn test_storage(root: &tempfile::TempDir) -> Arc<StorageService> {
        Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        )
    }

    async fn prepare_from_server(
        server: &TestHttpServer,
        storage: Arc<StorageService>,
        key: &str,
    ) -> Result<ProgressivePreparation, ProgressiveError> {
        let client = Client::builder().no_proxy().build().expect("HTTP client");
        prepare_progressive(
            &client,
            storage,
            key.to_owned(),
            server.url.clone(),
            HeaderMap::new(),
            "bin".to_owned(),
            Some("application/octet-stream".to_owned()),
            4 * 1024 * 1024,
        )
        .await
    }

    fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        predicate()
    }

    #[test]
    fn content_range_parser_rejects_inverted_and_unbounded_ranges() {
        assert_eq!(
            parse_content_range("bytes 0-511/1024"),
            Some(ContentRange {
                start: 0,
                end: 511,
                total: 1024,
            })
        );
        assert_eq!(parse_content_range("bytes 512-511/1024"), None);
        assert_eq!(parse_content_range("bytes 0-1024/1024"), None);
        assert_eq!(parse_content_range("bytes */1024"), None);
    }

    #[test]
    fn range_reader_waits_only_for_the_segment_it_reads_and_supports_seek() {
        let root = tempfile::tempdir().expect("temp root");
        let path = root.path().join("progressive.part");
        fs::write(&path, b"abcdefghijkl").expect("fixture");
        let storage = Arc::new(
            StorageService::open(root.path().join("data"), root.path().join("cache"))
                .expect("storage"),
        );
        let inner = Arc::new(ProgressiveInner {
            url: "https://example.invalid/media".to_owned(),
            headers: HeaderMap::new(),
            path,
            content_length: 12,
            segment_size: 4,
            cache_key: "test".to_owned(),
            extension: "bin".to_owned(),
            mime_type: None,
            storage,
            state: Mutex::new(SegmentState {
                available: vec![true, true, true],
                requested: VecDeque::new(),
                in_flight: None,
                next_prefetch: 3,
                error: None,
                promoted: true,
            }),
            ready: Condvar::new(),
            waiting: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            reader_count: AtomicUsize::new(1),
            source_count: AtomicUsize::new(0),
            downloaded_bytes: AtomicU64::new(12),
        });
        let mut reader = ProgressiveReader {
            file: File::open(&inner.path).expect("open fixture"),
            inner,
            position: 0,
        };
        reader.seek(SeekFrom::Start(6)).expect("seek");
        let mut bytes = [0_u8; 5];
        reader.read_exact(&mut bytes).expect("read across segments");
        assert_eq!(&bytes, b"ghijk");
    }

    #[test]
    fn unsatisfied_range_requires_a_valid_bounded_total() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_RANGE, "bytes */4096".parse().expect("header"));
        assert_eq!(validate_unsatisfied_range(&headers, 4096), Ok(()));
        assert_eq!(
            validate_unsatisfied_range(&headers, 1024),
            Err(ProgressiveError::ResponseTooLarge)
        );
    }

    #[tokio::test]
    async fn initial_200_response_selects_full_download_fallback() {
        let root = tempfile::tempdir().expect("temp root");
        let server = TestHttpServer::start(
            fixture_bytes(700 * 1024),
            ServerMode::IgnoreRange,
            Duration::ZERO,
        );
        let prepared = prepare_from_server(&server, test_storage(&root), "fallback-200")
            .await
            .expect("fallback response");
        assert!(matches!(
            prepared,
            ProgressivePreparation::FullDownloadFallback
        ));
        assert_eq!(server.request_count(), 1);
    }

    #[tokio::test]
    async fn initial_416_response_is_validated_then_falls_back() {
        let root = tempfile::tempdir().expect("temp root");
        let server = TestHttpServer::start(
            fixture_bytes(700 * 1024),
            ServerMode::Unsatisfied,
            Duration::ZERO,
        );
        let prepared = prepare_from_server(&server, test_storage(&root), "fallback-416")
            .await
            .expect("fallback response");
        assert!(matches!(
            prepared,
            ProgressivePreparation::FullDownloadFallback
        ));
    }

    #[tokio::test]
    async fn progressive_reader_coalesces_overlapping_ranges_and_promotes_complete_cache() {
        let bytes = fixture_bytes(1_300 * 1024);
        let root = tempfile::tempdir().expect("temp root");
        let storage = test_storage(&root);
        let server =
            TestHttpServer::start(bytes.clone(), ServerMode::Range, Duration::from_millis(20));
        let ProgressivePreparation::Progressive(source) =
            prepare_from_server(&server, Arc::clone(&storage), "range-complete")
                .await
                .expect("progressive source")
        else {
            panic!("expected progressive source");
        };
        assert_eq!(source.monitor().downloaded_bytes(), REQUESTED_SEGMENT_BYTES);

        let mut first = source.open_reader().expect("first reader");
        let mut second = source.open_reader().expect("second reader");
        let seek_position = REQUESTED_SEGMENT_BYTES + 37;
        first
            .seek(SeekFrom::Start(seek_position))
            .expect("first seek");
        second
            .seek(SeekFrom::Start(seek_position))
            .expect("second seek");
        let first_read = thread::spawn(move || {
            let mut output = [0_u8; 64];
            first.read_exact(&mut output).expect("first range read");
            output
        });
        let second_read = thread::spawn(move || {
            let mut output = [0_u8; 64];
            second.read_exact(&mut output).expect("second range read");
            output
        });
        let expected = &bytes[seek_position as usize..seek_position as usize + 64];
        assert_eq!(first_read.join().expect("first reader thread"), expected);
        assert_eq!(second_read.join().expect("second reader thread"), expected);

        assert!(wait_until(Duration::from_secs(5), || storage
            .lookup_cached_file("range-complete")
            .expect("cache lookup")
            .is_some()));
        let cached = storage
            .lookup_cached_file("range-complete")
            .expect("cache lookup")
            .expect("promoted cache");
        assert_eq!(fs::read(cached.path).expect("cached bytes"), bytes);
        let second_range = format!(
            "bytes={}-{}",
            REQUESTED_SEGMENT_BYTES,
            REQUESTED_SEGMENT_BYTES * 2 - 1
        );
        assert_eq!(
            server
                .ranges
                .lock()
                .expect("range log")
                .iter()
                .filter(|range| **range == second_range)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn dropping_all_readers_cancels_fetch_and_removes_sparse_part() {
        let root = tempfile::tempdir().expect("temp root");
        let server = TestHttpServer::start(
            fixture_bytes(2_500 * 1024),
            ServerMode::Range,
            Duration::from_millis(250),
        );
        let ProgressivePreparation::Progressive(source) =
            prepare_from_server(&server, test_storage(&root), "range-cancel")
                .await
                .expect("progressive source")
        else {
            panic!("expected progressive source");
        };
        let path = source.inner.path.clone();
        let reader = source.open_reader().expect("reader");
        assert!(path.is_file());
        drop(reader);
        drop(source);
        assert!(wait_until(Duration::from_secs(2), || !path.exists()));
        assert!(server.request_count() < 5);
    }

    #[tokio::test]
    async fn later_forbidden_range_is_classified_as_url_expiration() {
        let root = tempfile::tempdir().expect("temp root");
        let server = TestHttpServer::start(
            fixture_bytes(900 * 1024),
            ServerMode::ExpireAfterInitial,
            Duration::ZERO,
        );
        let ProgressivePreparation::Progressive(source) =
            prepare_from_server(&server, test_storage(&root), "range-expired")
                .await
                .expect("progressive source")
        else {
            panic!("expected progressive source");
        };
        let monitor = source.monitor();
        let mut reader = source.open_reader().expect("reader");
        reader
            .seek(SeekFrom::Start(REQUESTED_SEGMENT_BYTES + 10))
            .expect("seek");
        let mut output = [0_u8; 1];
        assert!(reader.read_exact(&mut output).is_err());
        assert_eq!(monitor.error_kind(), Some(ProgressiveError::UrlExpired));
    }
}
