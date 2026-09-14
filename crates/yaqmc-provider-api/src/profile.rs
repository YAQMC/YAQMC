//! Provider/profile identity values shared by provider-facing DTOs.

use crate::ProviderId;
use serde::{de, Deserialize, Deserializer, Serialize};
use std::fmt;

/// The profile used by the pre-profile provider API.
pub const DEFAULT_PROFILE_ID: &str = "default";

/// The provider ID used by the pre-provider/profile desktop API.
pub const DEFAULT_PROVIDER_ID: &str = "qqmusic";

/// Maximum encoded size of a local profile identifier.
pub const MAX_PROFILE_ID_BYTES: usize = 64;

/// A validated provider/profile pair.
///
/// `profile_id` is a local opaque identifier. It must not contain account
/// data, credentials, or a provider-specific upstream identifier.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfileKey {
    pub provider_id: String,
    pub profile_id: String,
}

impl ProviderProfileKey {
    /// Construct a key after validating both components.
    pub fn new(
        provider_id: impl AsRef<str>,
        profile_id: impl AsRef<str>,
    ) -> Result<Self, ProviderProfileKeyError> {
        let provider_id = ProviderId::parse(provider_id.as_ref())?;
        let profile_id = validate_profile_id(profile_id.as_ref())?;
        Ok(Self {
            provider_id: provider_id.as_str().to_owned(),
            profile_id: profile_id.to_owned(),
        })
    }

    /// Parse a key from its wire-compatible components.
    pub fn parse(
        provider_id: impl AsRef<str>,
        profile_id: impl AsRef<str>,
    ) -> Result<Self, ProviderProfileKeyError> {
        Self::new(provider_id, profile_id)
    }

    /// Construct the compatibility key for a provider using the legacy
    /// account slot.
    pub fn default_profile(provider_id: impl AsRef<str>) -> Result<Self, ProviderProfileKeyError> {
        Self::new(provider_id, DEFAULT_PROFILE_ID)
    }
}

impl<'de> Deserialize<'de> for ProviderProfileKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct WireKey {
            provider_id: String,
            #[serde(default = "default_profile_id")]
            profile_id: String,
        }

        let key = WireKey::deserialize(deserializer)?;
        Self::new(key.provider_id, key.profile_id).map_err(de::Error::custom)
    }
}

impl TryFrom<(String, String)> for ProviderProfileKey {
    type Error = ProviderProfileKeyError;

    fn try_from(value: (String, String)) -> Result<Self, Self::Error> {
        Self::new(value.0, value.1)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderProfileKeyError {
    InvalidProvider(crate::ProviderIdError),
    EmptyProfile,
    ProfileTooLong,
    InvalidProfileCharacter,
}

impl fmt::Display for ProviderProfileKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProvider(error) => error.fmt(formatter),
            Self::EmptyProfile => formatter.write_str("provider profile ID must not be empty"),
            Self::ProfileTooLong => write!(
                formatter,
                "provider profile ID exceeds the {MAX_PROFILE_ID_BYTES}-byte limit"
            ),
            Self::InvalidProfileCharacter => formatter.write_str(
                "provider profile ID must use lowercase ASCII letters, digits, dots, underscores, or hyphens",
            ),
        }
    }
}

impl std::error::Error for ProviderProfileKeyError {}

impl From<crate::ProviderIdError> for ProviderProfileKeyError {
    fn from(error: crate::ProviderIdError) -> Self {
        Self::InvalidProvider(error)
    }
}

pub(crate) fn default_profile_id() -> String {
    DEFAULT_PROFILE_ID.to_owned()
}

pub(crate) fn default_provider_id() -> String {
    DEFAULT_PROVIDER_ID.to_owned()
}

fn validate_profile_id(value: &str) -> Result<&str, ProviderProfileKeyError> {
    if value.is_empty() {
        return Err(ProviderProfileKeyError::EmptyProfile);
    }
    if value.len() > MAX_PROFILE_ID_BYTES {
        return Err(ProviderProfileKeyError::ProfileTooLong);
    }
    let mut bytes = value.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    {
        return Err(ProviderProfileKeyError::InvalidProfileCharacter);
    }
    if !bytes.all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
    }) {
        return Err(ProviderProfileKeyError::InvalidProfileCharacter);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_profile_key_is_valid_and_uses_camel_case_wire_names() {
        let key = ProviderProfileKey::default_profile("qqmusic").expect("valid key");
        assert_eq!(key.profile_id, DEFAULT_PROFILE_ID);
        assert_eq!(
            serde_json::to_value(key).expect("key serializes"),
            json!({"providerId": "qqmusic", "profileId": "default"})
        );
    }

    #[test]
    fn missing_profile_id_is_legacy_default() {
        let key: ProviderProfileKey = serde_json::from_value(json!({
            "providerId": "qqmusic"
        }))
        .expect("legacy key deserializes");
        assert_eq!(key.profile_id, DEFAULT_PROFILE_ID);
    }

    #[test]
    fn invalid_components_are_rejected() {
        assert_eq!(
            ProviderProfileKey::new("QQMusic", DEFAULT_PROFILE_ID),
            Err(ProviderProfileKeyError::InvalidProvider(
                crate::ProviderIdError::InvalidCharacter
            ))
        );
        assert_eq!(
            ProviderProfileKey::new("qqmusic", "profile one"),
            Err(ProviderProfileKeyError::InvalidProfileCharacter)
        );
        assert!(serde_json::from_value::<ProviderProfileKey>(json!({
            "providerId": "qqmusic",
            "profileId": ""
        }))
        .is_err());
    }
}
