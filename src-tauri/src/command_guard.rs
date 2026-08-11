use crate::qqmusic::ProviderCommandError;

pub(crate) fn require_main_window(
    window: &tauri::WebviewWindow,
) -> Result<(), ProviderCommandError> {
    require_main_window_label(window.label())
}

pub(crate) fn require_main_window_label(label: &str) -> Result<(), ProviderCommandError> {
    if label == "main" {
        return Ok(());
    }

    Err(ProviderCommandError {
        code: "caller-not-authorized".to_owned(),
        message: "This account operation is available only to the main application window."
            .to_owned(),
        retryable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_is_authorized_for_account_commands() {
        assert!(require_main_window_label("main").is_ok());
    }

    #[test]
    fn lyric_webviews_are_denied_account_commands() {
        for label in [
            "lyrics-desktop",
            "lyrics-island",
            "lyrics-desktop-unlock",
            "lyrics-island-unlock",
            "untrusted",
        ] {
            let error = require_main_window_label(label).expect_err("caller must be denied");
            assert_eq!(error.code, "caller-not-authorized");
            assert!(!error.retryable);
        }
    }
}
