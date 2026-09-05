//! Windows foreground-fullscreen poller (plan §22.2).
//!
//! Linux has no portable foreground-window geometry API (TD-5). The probe
//! returns `None` and production bootstrap does not start a poller there.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::{HostCommand, HostCommandPublisher};

/// Cadence preserved from the original lyrics-surface watcher.
pub const POLL_INTERVAL: Duration = Duration::from_millis(800);

/// Injected foreground check. Tests pass a hook; production Windows uses
/// [`foreground_is_fullscreen`].
pub type ForegroundFullscreenProbe = Arc<dyn Fn() -> Option<bool> + Send + Sync>;

/// Production probe: Win32 geometry on Windows, `None` (NotSupported) elsewhere.
pub fn platform_fullscreen_probe() -> Option<ForegroundFullscreenProbe> {
    #[cfg(all(windows, feature = "system-media"))]
    {
        Some(Arc::new(foreground_is_fullscreen) as ForegroundFullscreenProbe)
    }
    #[cfg(not(all(windows, feature = "system-media")))]
    {
        None
    }
}

pub(crate) fn running_under_cargo_test() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.to_owned()))
        .is_some_and(|dir| dir.ends_with("deps"))
}

/// Start the 800 ms poller from bootstrap on Windows only.
///
/// Cargo-test binaries (`target/*/deps`) skip the real Win32 loop so unit and
/// integration tests do not need a display. Inject [`spawn_fullscreen_watch`]
/// with a probe (and Tokio's paused clock) when a test needs the loop.
pub(crate) fn maybe_spawn_platform_watch(
    runtime: &tokio::runtime::Handle,
    publisher: HostCommandPublisher,
    shutdown: watch::Receiver<bool>,
) {
    if running_under_cargo_test() {
        return;
    }
    let Some(probe) = platform_fullscreen_probe() else {
        return;
    };
    spawn_fullscreen_watch(runtime, publisher, shutdown, probe);
}

#[cfg(all(windows, feature = "system-media"))]
pub fn foreground_is_fullscreen() -> Option<bool> {
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsIconic},
    };

    // Read-only Win32 geometry checks. Failure deliberately returns None so lyrics stay visible.
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        if IsIconic(window) != 0 {
            return Some(false);
        }
        let mut window_rect = RECT::default();
        if GetWindowRect(window, &mut window_rect) == 0 {
            return None;
        }
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        let mut monitor_info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..MONITORINFO::default()
        };
        if GetMonitorInfoW(monitor, &mut monitor_info) == 0 {
            return None;
        }
        let screen = monitor_info.rcMonitor;
        let tolerance = 2;
        Some(
            window_rect.left <= screen.left + tolerance
                && window_rect.top <= screen.top + tolerance
                && window_rect.right >= screen.right - tolerance
                && window_rect.bottom >= screen.bottom - tolerance,
        )
    }
}

#[cfg(not(all(windows, feature = "system-media")))]
pub fn foreground_is_fullscreen() -> Option<bool> {
    // Wayland/X11 do not expose a portable foreground-window geometry API (TD-5).
    // Returning None is the safe fallback: never hide a lyric window permanently.
    None
}

/// 800 ms poller. Publishes [`HostCommand::SurfaceAutoHide`] on edges only.
pub fn spawn_fullscreen_watch(
    runtime: &tokio::runtime::Handle,
    publisher: HostCommandPublisher,
    shutdown: watch::Receiver<bool>,
    probe: ForegroundFullscreenProbe,
) {
    spawn_fullscreen_watch_every(runtime, publisher, shutdown, probe, POLL_INTERVAL);
}

/// Same as [`spawn_fullscreen_watch`] with an injected cadence (tests).
pub fn spawn_fullscreen_watch_every(
    runtime: &tokio::runtime::Handle,
    publisher: HostCommandPublisher,
    mut shutdown: watch::Receiver<bool>,
    probe: ForegroundFullscreenProbe,
    period: Duration,
) {
    runtime.spawn(async move {
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut previous = false;
        loop {
            tokio::select! {
                result = shutdown.changed() => {
                    if result.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
                _ = interval.tick() => {
                    let Some(fullscreen) = probe() else {
                        continue;
                    };
                    if previous == fullscreen {
                        continue;
                    }
                    previous = fullscreen;
                    publisher.publish(HostCommand::SurfaceAutoHide(fullscreen));
                }
            }
        }
    });
}
