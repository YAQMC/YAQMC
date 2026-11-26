use std::{
    io,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use yaqmc_core::{
    audio::{
        AudioEngine, AudioEngineError, AudioEngineSnapshot, AudioLoadMetadata, AudioOutputDevice,
        PreparedPlaybackLocation, PreparedPlaybackSource, RodioAudioEngine,
    },
    protected_hls::ProtectedHlsSession,
    HostCommand, HostCommandPublisher,
};

fn startup_io_error(stage: &'static str, error: io::Error) -> io::Error {
    // Error text and command arguments can contain a session URL.
    tracing::warn!(
        target: "player.protected_hls",
        stage,
        error_kind = ?error.kind(),
        os_error = ?error.raw_os_error(),
        "protected playback startup failed"
    );
    error
}

struct RunningProtected {
    session: ProtectedHlsSession,
    session_id: u64,
    duration_ms: Option<u64>,
}

pub(crate) struct DesktopAudioEngine {
    rodio: RodioAudioEngine,
    runtime: tokio::runtime::Handle,
    protected: Mutex<Option<RunningProtected>>,
    host_commands: Mutex<Option<HostCommandPublisher>>,
    next_session_id: AtomicU64,
    volume: Mutex<f32>,
    stopped: AtomicBool,
}

impl DesktopAudioEngine {
    pub(crate) fn new(rodio: RodioAudioEngine, runtime: tokio::runtime::Handle) -> Self {
        Self {
            rodio,
            runtime,
            protected: Mutex::new(None),
            host_commands: Mutex::new(None),
            next_session_id: AtomicU64::new(1),
            volume: Mutex::new(1.0),
            stopped: AtomicBool::new(false),
        }
    }

    fn protected_guard(&self) -> std::sync::MutexGuard<'_, Option<RunningProtected>> {
        self.protected
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn attach_host_commands(&self, publisher: HostCommandPublisher) {
        *self
            .host_commands
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(publisher);
    }

    fn publish_host_command(&self, command: HostCommand) -> bool {
        self.host_commands
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .is_some_and(|publisher| publisher.publish(command))
    }

    fn clear_protected(&self) {
        let active = self.protected_guard().take();
        if let Some(active) = active {
            self.publish_host_command(HostCommand::CloseProtectedHls {
                session_id: active.session_id,
            });
        }
    }

    fn load_protected(
        &self,
        source: &PreparedPlaybackSource,
        protected: Arc<dyn yaqmc_core::media::ProtectedHlsSource>,
    ) -> Result<AudioLoadMetadata, AudioEngineError> {
        self.clear_protected();
        self.rodio.stop()?;
        self.stopped.store(false, Ordering::Release);

        let session =
            ProtectedHlsSession::start(protected, self.runtime.clone()).map_err(|error| {
                startup_io_error("loopback-start", error);
                AudioEngineError::DecoderUnsupported
            })?;
        tracing::info!(
            target: "player.protected_hls",
            stage = "loopback-started",
            "protected playback loopback service started"
        );
        let endpoints = session.endpoints();
        let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let volume = *self
            .volume
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        session.set_volume(volume);
        let duration_ms = source
            .timeline_end_ms
            .map(|end| end.saturating_sub(source.timeline_offset_ms));
        if !self.publish_host_command(HostCommand::OpenProtectedHls {
            session_id,
            page_url: endpoints.page_url,
        }) {
            return Err(AudioEngineError::DecoderUnsupported);
        }
        *self.protected_guard() = Some(RunningProtected {
            session,
            session_id,
            duration_ms,
        });
        Ok(AudioLoadMetadata {
            duration_ms,
            format: source.format,
        })
    }

    fn protected_is_active(&self) -> bool {
        self.protected_guard().is_some()
    }
}

impl AudioEngine for DesktopAudioEngine {
    fn load(&self, source: &PreparedPlaybackSource) -> Result<AudioLoadMetadata, AudioEngineError> {
        if let PreparedPlaybackLocation::ProtectedHls(protected) = &source.location {
            return self.load_protected(source, Arc::clone(protected));
        }
        self.clear_protected();
        self.stopped.store(false, Ordering::Release);
        self.rodio.load(source)
    }

    fn play(&self) -> Result<(), AudioEngineError> {
        let guard = self.protected_guard();
        match guard.as_ref() {
            Some(active) => {
                self.stopped.store(false, Ordering::Release);
                active.session.play();
                Ok(())
            }
            None => self.rodio.play(),
        }
    }

    fn pause(&self) -> Result<(), AudioEngineError> {
        let guard = self.protected_guard();
        match guard.as_ref() {
            Some(active) => {
                active.session.pause();
                Ok(())
            }
            None => self.rodio.pause(),
        }
    }

    fn stop(&self) -> Result<(), AudioEngineError> {
        self.stopped.store(true, Ordering::Release);
        let has_protected = self.protected_guard().is_some();
        self.clear_protected();
        let result = self.rodio.stop();
        if has_protected {
            Ok(())
        } else {
            result
        }
    }

    fn seek(&self, position: Duration) -> Result<(), AudioEngineError> {
        let guard = self.protected_guard();
        match guard.as_ref() {
            Some(active) => {
                active
                    .session
                    .seek(position.as_millis().min(u64::MAX as u128) as u64);
                Ok(())
            }
            None => self.rodio.seek(position),
        }
    }

    fn set_volume(&self, volume: f32) -> Result<(), AudioEngineError> {
        *self
            .volume
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = volume.clamp(0.0, 1.0);
        let rodio_result = self.rodio.set_volume(volume);
        if let Some(active) = self.protected_guard().as_ref() {
            active.session.set_volume(volume);
        }
        rodio_result
    }

    fn set_output_device(&self, device_id: &str) -> Result<(), AudioEngineError> {
        self.rodio.set_output_device(device_id)
    }

    fn snapshot(&self) -> AudioEngineSnapshot {
        let mut guard = self.protected_guard();
        let Some(active) = guard.as_mut() else {
            return self.rodio.snapshot();
        };
        let browser = active.session.snapshot();
        let stopped = self.stopped.load(Ordering::Acquire);
        AudioEngineSnapshot {
            loaded: !stopped,
            playing: !stopped && browser.playing,
            paused: stopped || browser.paused,
            ended: browser.ended,
            position_ms: browser.position_ms,
            duration_ms: browser.duration_ms.or(active.duration_ms),
            source_error: browser.error,
            buffering: !stopped && browser.buffering,
            ..AudioEngineSnapshot::default()
        }
    }

    fn output_devices(&self) -> Result<Vec<AudioOutputDevice>, AudioEngineError> {
        self.rodio.output_devices()
    }

    fn recover_output(&self) -> Result<(), AudioEngineError> {
        if self.protected_is_active() {
            Ok(())
        } else {
            self.rodio.recover_output()
        }
    }
}

impl Drop for DesktopAudioEngine {
    fn drop(&mut self) {
        self.clear_protected();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[derive(Clone, Default)]
    struct LogBuffer(Arc<Mutex<Vec<u8>>>);

    impl Write for LogBuffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn startup_diagnostics_preserve_os_errors_without_logging_session_data() {
        let output = LogBuffer::default();
        let writer = output.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let returned = startup_io_error("loopback-spawn", io::Error::from_raw_os_error(5));
            assert_eq!(returned.raw_os_error(), Some(5));
            let sensitive = "http://127.0.0.1/private-session/player?token=secret";
            let returned = startup_io_error(
                "loopback-profile",
                io::Error::new(io::ErrorKind::PermissionDenied, sensitive),
            );
            assert_eq!(returned.to_string(), sensitive);
        });
        let logged = String::from_utf8(output.0.lock().unwrap().clone()).unwrap();
        assert!(logged.contains("loopback-spawn"));
        assert!(logged.contains("os_error=Some(5)"));
        assert!(logged.contains("loopback-profile"));
        assert!(logged.contains("PermissionDenied"));
        assert!(!logged.contains("private-session"));
        assert!(!logged.contains("secret"));
        assert!(!logged.contains("127.0.0.1"));
    }

    #[test]
    fn host_command_debug_redacts_the_protected_page_url() {
        let command = HostCommand::OpenProtectedHls {
            session_id: 7,
            page_url: "http://127.0.0.1/private-session/player?token=secret".to_owned(),
        };
        let debug = format!("{command:?}");
        assert!(debug.contains("session_id: 7"));
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains("private-session"));
        assert!(!debug.contains("secret"));
    }
}
