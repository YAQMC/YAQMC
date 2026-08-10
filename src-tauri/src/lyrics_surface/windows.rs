use windows_sys::Win32::{
    Foundation::RECT,
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect, IsIconic},
};

pub fn foreground_is_fullscreen() -> Option<bool> {
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
