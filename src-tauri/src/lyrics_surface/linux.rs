pub fn foreground_is_fullscreen() -> Option<bool> {
    // Wayland intentionally does not expose a portable foreground-window geometry API.
    // Returning None is the safe fallback: never hide a lyric window permanently.
    None
}
