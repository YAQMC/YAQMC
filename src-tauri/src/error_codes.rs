//! Stable error-code taxonomy for user-reportable failures.
//!
//! Every user-facing error surface should attach one of these codes when
//! recording an entry into the diagnostic ring buffer (`logging::LoggingHandle::record_error`).
//! Codes are intentionally strings so they can be embedded in log lines and
//! Issue Reporter bodies without any conversion, and they are stable across
//! releases (adding a new code is fine; renaming an existing one is not).
//!
//! The `#[allow(dead_code)]` on individual codes intentionally silences the
//! dead-code lint: some codes (e.g. `YAQMC_NETWORK_TIMEOUT`) are attached only
//! from call sites that this milestone does not touch, but they must exist in
//! the taxonomy from day one so that they are stable when adopted.
#![allow(dead_code)]

pub const YAQMC_QQ_AUTH_COOKIES_INVALID: &str = "YAQMC-QQ-AUTH-COOKIES-INVALID";
pub const YAQMC_QQ_AUTH_QR_EXPIRED: &str = "YAQMC-QQ-AUTH-QR-EXPIRED";
pub const YAQMC_QQ_SOURCE_NO_MATCH: &str = "YAQMC-QQ-SOURCE-NO-MATCH";
pub const YAQMC_QQ_SOURCE_UNAUTHORIZED: &str = "YAQMC-QQ-SOURCE-UNAUTHORIZED";
pub const YAQMC_QQ_ACCOUNT_UNAVAILABLE: &str = "YAQMC-QQ-ACCOUNT-UNAVAILABLE";

pub const YAQMC_AUDIO_OUTPUT_OPEN_FAILED: &str = "YAQMC-AUDIO-OUTPUT-OPEN-FAILED";
pub const YAQMC_AUDIO_DECODE_UNSUPPORTED: &str = "YAQMC-AUDIO-DECODE-UNSUPPORTED";
pub const YAQMC_AUDIO_DECODE_CORRUPT: &str = "YAQMC-AUDIO-DECODE-CORRUPT";
pub const YAQMC_AUDIO_QMC_KEY_MISSING: &str = "YAQMC-AUDIO-QMC-KEY-MISSING";

pub const YAQMC_LYRICS_FETCH_FAILED: &str = "YAQMC-LYRICS-FETCH-FAILED";
pub const YAQMC_LYRICS_PARSE_FAILED: &str = "YAQMC-LYRICS-PARSE-FAILED";

pub const YAQMC_NETWORK_UNREACHABLE: &str = "YAQMC-NETWORK-UNREACHABLE";
pub const YAQMC_NETWORK_RANGE_STALLED: &str = "YAQMC-NETWORK-RANGE-STALLED";
pub const YAQMC_NETWORK_TIMEOUT: &str = "YAQMC-NETWORK-TIMEOUT";

pub const YAQMC_UI_EVENT: &str = "YAQMC-UI-EVENT";

/// Every code exposed here. Used by the reporter test suite to guarantee we
/// never rename an existing code by mistake.
pub const ALL_CODES: &[&str] = &[
    YAQMC_QQ_AUTH_COOKIES_INVALID,
    YAQMC_QQ_AUTH_QR_EXPIRED,
    YAQMC_QQ_SOURCE_NO_MATCH,
    YAQMC_QQ_SOURCE_UNAUTHORIZED,
    YAQMC_QQ_ACCOUNT_UNAVAILABLE,
    YAQMC_AUDIO_OUTPUT_OPEN_FAILED,
    YAQMC_AUDIO_DECODE_UNSUPPORTED,
    YAQMC_AUDIO_DECODE_CORRUPT,
    YAQMC_AUDIO_QMC_KEY_MISSING,
    YAQMC_LYRICS_FETCH_FAILED,
    YAQMC_LYRICS_PARSE_FAILED,
    YAQMC_NETWORK_UNREACHABLE,
    YAQMC_NETWORK_RANGE_STALLED,
    YAQMC_NETWORK_TIMEOUT,
    YAQMC_UI_EVENT,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_prefixed() {
        for code in ALL_CODES {
            assert!(
                code.starts_with("YAQMC-"),
                "error code {code} must start with YAQMC-"
            );
        }
    }

    #[test]
    fn every_code_is_unique() {
        use std::collections::HashSet;
        let set: HashSet<&&str> = ALL_CODES.iter().collect();
        assert_eq!(set.len(), ALL_CODES.len(), "duplicate error code detected");
    }
}
