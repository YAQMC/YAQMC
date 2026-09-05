//! Stub plugin host used by reduced Core builds.

pub struct ExtensionHost;

impl ExtensionHost {
    pub fn open(_root: std::path::PathBuf) -> Result<Self, String> {
        Ok(Self)
    }

    pub async fn restore_provider_accounts(&self) {}

    pub fn mark_clean_exit(&self) {}
}
