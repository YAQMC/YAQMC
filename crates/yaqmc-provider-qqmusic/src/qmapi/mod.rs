//! Optional `qqmusic-api` integration compiled only with `--features qmapi`.
//!
//! HTTP goes through [`transport::YaqmcReqwestTransport`] (YAQMC reqwest 0.13.4).
//! Row J (QMC stream cipher) stays in-tree until the pinned library passes a
//! real-file golden. Under `qmapi` (non-test) production lyrics, clear vkey, and VIP
//! fetch use the library, credential-v2 is the restore primary, and G raw
//! favorite/playlist writes use the library CGI client. Encrypted evkey and A/B
//! signing still use in-tree MD5 `zzb` (Keep). G reconciliation,
//! `choose_source`, QR/OAuth, and K feed mapping stay in-tree.

#![allow(dead_code)]

pub(crate) mod account;
pub(crate) mod catalog;
pub(crate) mod cgi;
pub(crate) mod credential;
pub(crate) mod entitlement;
#[cfg(test)]
pub(crate) mod live;
pub(crate) mod login;
pub(crate) mod lyric;
pub(crate) mod qmc;
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
