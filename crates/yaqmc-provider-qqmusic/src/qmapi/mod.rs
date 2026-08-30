//! Pinned `qqmusic-api` production integration.
//!
//! HTTP goes through [`transport::YaqmcReqwestTransport`] (YAQMC reqwest 0.13.4).
//! QMC decryption, lyric fetch/decrypt, clear vkey, VIP fetch, credential-v2,
//! and raw favorite/playlist writes use the library. Encrypted evkey and A/B
//! signing stay on in-tree MD5 `zzb` (Keep); G reconciliation, `choose_source`,
//! QR/OAuth, and home/discover mapping stay in-tree.

#![cfg_attr(test, allow(dead_code))]

pub(crate) mod account;
pub(crate) mod catalog;
pub(crate) mod cgi;
pub(crate) mod credential;
pub(crate) mod entitlement;
pub(crate) mod lyric;
pub(crate) mod qmc;
pub(crate) mod recommend;
pub(crate) mod transport;
pub(crate) mod vkey;

pub(crate) fn qmapi_client() -> Result<qqmusic_api::Client, qqmusic_api::QmError> {
    qmapi_client_with(None, None)
}

pub(crate) fn qmapi_client_with(
    credential: Option<qqmusic_api::Credential>,
    platform: Option<qqmusic_api::Platform>,
) -> Result<qqmusic_api::Client, qqmusic_api::QmError> {
    Ok(qqmusic_api::Client::new_with_transport(
        credential,
        platform,
        transport::qmapi_transport(qqmusic_api::TransportConfig::default())?,
    ))
}
