//! Row C/D: library `Credential` is the primary persisted identity while the
//! legacy `SessionRecord` remains a bounded migration/rollback fallback.

use std::sync::Arc;

use qqmusic_api::{
    credential_store::CredentialPersist, Credential, CredentialStore as QmapiCredentialStore,
    Platform, QmError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use yaqmc_provider_api::{CredentialError, CredentialStore, SpawnBlockingCredentialStore};

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::qmapi_client_with;
use crate::qqmusic::{cookie_value, OpaqueAccountScope, QQMusicError, SessionRecord};

pub(crate) const CREDENTIAL_V2: &str = "qqmusic-credential-v2";
const CREDENTIAL_V2_VERSION: u8 = 1;
const DEFAULT_SESSION_LIFETIME_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialV2Envelope {
    version: u8,
    library_store: Value,
    account_cache_scope: OpaqueAccountScope,
}

#[derive(Deserialize)]
struct LibraryCredentialStore {
    #[serde(default)]
    accounts: std::collections::BTreeMap<i64, Credential>,
    #[serde(default)]
    current: Option<i64>,
}

struct LoadedCredentialV2 {
    credential: Credential,
    account_cache_scope: Option<OpaqueAccountScope>,
}

pub(crate) fn credential_from_uin_and_cookie(
    uin: &str,
    cookie_header: &str,
    encrypt_uin: Option<&str>,
    expires_at_ms: u64,
) -> Result<Credential, QQMusicError> {
    let musickey = cookie_value(cookie_header, "qm_keyst")
        .or_else(|| cookie_value(cookie_header, "qqmusic_key"))
        .filter(|value| !value.is_empty())
        .ok_or(QQMusicError::AuthenticationExpired)?;
    let uin = uin.trim();
    if uin.is_empty() || !uin.chars().all(|character| character.is_ascii_digit()) {
        return Err(QQMusicError::MalformedResponse);
    }
    let musicid = uin.parse().map_err(|_| QQMusicError::MalformedResponse)?;
    let login_type = cookie_value(cookie_header, "tmeLoginType")
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| if musickey.starts_with("W_X") { 1 } else { 2 });
    let encrypt_uin = encrypt_uin
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            cookie_value(cookie_header, "euin")
                .or_else(|| cookie_value(cookie_header, "encryptUin"))
                .map(ToOwned::to_owned)
        })
        .unwrap_or_default();
    Ok(Credential {
        musicid,
        str_musicid: uin.to_owned(),
        musickey: musickey.to_owned(),
        login_type,
        encrypt_uin,
        expired_at: i64::try_from(expires_at_ms / 1_000).unwrap_or(i64::MAX),
        ..Credential::default()
    })
}

pub(crate) fn credential_from_session(session: &SessionRecord) -> Result<Credential, QQMusicError> {
    credential_from_uin_and_cookie(
        &session.uin,
        &session.cookie_header,
        session.encrypted_uin.as_deref(),
        session.expires_at_ms,
    )
}

pub(crate) fn cookie_header_from_credential(credential: &Credential) -> String {
    let uin = credential.str_musicid();
    let mut parts = vec![
        format!("uin=o{uin}"),
        format!("qqmusic_uin={uin}"),
        format!("qm_keyst={}", credential.musickey),
        format!("qqmusic_key={}", credential.musickey),
        format!("tmeLoginType={}", credential.login_type),
    ];
    if !credential.encrypt_uin.trim().is_empty() {
        parts.push(format!("euin={}", credential.encrypt_uin.trim()));
    }
    parts.join("; ")
}

fn credential_expires_at_ms(credential: &Credential, now_ms: u64) -> u64 {
    if credential.musickey_create_time > 0 && credential.key_expires_in > 0 {
        let created = u64::try_from(credential.musickey_create_time).unwrap_or(u64::MAX);
        let created_ms = if created >= 1_000_000_000_000 {
            created
        } else {
            created.saturating_mul(1_000)
        };
        return created_ms.saturating_add(
            u64::try_from(credential.key_expires_in)
                .unwrap_or(u64::MAX)
                .saturating_mul(1_000),
        );
    }
    if credential.expired_at >= 1_000_000_000 {
        return u64::try_from(credential.expired_at)
            .unwrap_or(u64::MAX)
            .saturating_mul(1_000);
    }
    if credential.expired_at > 0 {
        return now_ms.saturating_add(
            u64::try_from(credential.expired_at)
                .unwrap_or(u64::MAX)
                .saturating_mul(1_000),
        );
    }
    now_ms.saturating_add(DEFAULT_SESSION_LIFETIME_MS)
}

fn session_from_credential(
    credential: &Credential,
    account_cache_scope: OpaqueAccountScope,
    now_ms: u64,
) -> Result<SessionRecord, QQMusicError> {
    let uin = credential.str_musicid();
    if credential.musicid <= 0
        || uin.is_empty()
        || !uin.chars().all(|character| character.is_ascii_digit())
        || credential.musickey.trim().is_empty()
    {
        return Err(QQMusicError::AuthenticationExpired);
    }
    let expires_at_ms = credential_expires_at_ms(credential, now_ms);
    if expires_at_ms <= now_ms {
        return Err(QQMusicError::AuthenticationExpired);
    }
    Ok(SessionRecord {
        version: 1,
        uin,
        encrypted_uin: (!credential.encrypt_uin.trim().is_empty())
            .then(|| credential.encrypt_uin.trim().to_owned()),
        cookie_header: cookie_header_from_credential(credential),
        expires_at_ms,
        account_cache_scope,
    })
}

fn unwrap_library_store(raw: &str) -> Result<(Value, Option<OpaqueAccountScope>), QQMusicError> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| QQMusicError::AuthenticationExpired)?;
    if value.get("libraryStore").is_some() || value.get("version").is_some() {
        let envelope: CredentialV2Envelope =
            serde_json::from_value(value).map_err(|_| QQMusicError::AuthenticationExpired)?;
        if envelope.version != CREDENTIAL_V2_VERSION {
            return Err(QQMusicError::AuthenticationExpired);
        }
        Ok((envelope.library_store, Some(envelope.account_cache_scope)))
    } else {
        Ok((value, None))
    }
}

fn current_credential(raw: &str) -> Result<LoadedCredentialV2, QQMusicError> {
    let (library_store, account_cache_scope) = unwrap_library_store(raw)?;
    let store: LibraryCredentialStore =
        serde_json::from_value(library_store).map_err(|_| QQMusicError::AuthenticationExpired)?;
    let current = store.current.ok_or(QQMusicError::AuthenticationExpired)?;
    let credential = store
        .accounts
        .get(&current)
        .cloned()
        .ok_or(QQMusicError::AuthenticationExpired)?;
    Ok(LoadedCredentialV2 {
        credential,
        account_cache_scope,
    })
}

fn persist_error(_: CredentialError) -> QmError {
    QmError::Io("credential persist failed".into())
}

fn storage_error<E>(_: E) -> QQMusicError {
    QQMusicError::Storage
}

pub(crate) async fn persist_v2(
    credentials: &SpawnBlockingCredentialStore,
    session: &SessionRecord,
) -> Result<(), QQMusicError> {
    let credential = credential_from_session(session)?;
    persist_credential_v2(credentials, credential, session.account_cache_scope.clone()).await
}

async fn persist_credential_v2(
    credentials: &SpawnBlockingCredentialStore,
    credential: Credential,
    account_cache_scope: OpaqueAccountScope,
) -> Result<(), QQMusicError> {
    let expected_musicid = credential.musicid;
    let expected_musickey = credential.musickey.clone();
    let expected_scope = account_cache_scope.clone();
    let persist = KeyringCredentialPersist::with_scope(credentials.inner(), account_cache_scope);
    tokio::task::spawn_blocking(move || {
        let store = QmapiCredentialStore::new().with_backend(persist);
        store.add(credential).map_err(storage_error)
    })
    .await
    .map_err(storage_error)??;

    let raw = credentials
        .load(CREDENTIAL_V2)
        .await
        .map_err(storage_error)?
        .ok_or(QQMusicError::Storage)?;
    let loaded = current_credential(&raw).map_err(|_| QQMusicError::Storage)?;
    if loaded.credential.musicid != expected_musicid
        || loaded.credential.musickey != expected_musickey
        || loaded.account_cache_scope.as_ref() != Some(&expected_scope)
    {
        return Err(QQMusicError::Storage);
    }
    Ok(())
}

pub(crate) async fn load_primary_session_v2(
    credentials: &SpawnBlockingCredentialStore,
    legacy: Option<&SessionRecord>,
    now_ms: u64,
) -> Result<Option<SessionRecord>, QQMusicError> {
    load_primary_session_v2_with_refresh(credentials, legacy, now_ms, |credential| async move {
        let client = qmapi_client_with(Some(credential.clone()), Some(Platform::Android))
            .map_err(map_qmapi_error)?;
        client
            .login
            .refresh_credential(Some(&credential))
            .await
            .map_err(map_qmapi_error)
    })
    .await
}

async fn load_primary_session_v2_with_refresh<F, Fut>(
    credentials: &SpawnBlockingCredentialStore,
    legacy: Option<&SessionRecord>,
    now_ms: u64,
    refresh: F,
) -> Result<Option<SessionRecord>, QQMusicError>
where
    F: FnOnce(Credential) -> Fut,
    Fut: std::future::Future<Output = Result<Credential, QQMusicError>>,
{
    let Some(raw) = credentials
        .load(CREDENTIAL_V2)
        .await
        .map_err(storage_error)?
    else {
        return Ok(None);
    };
    let mut loaded = current_credential(&raw)?;
    let fallback_scope = legacy
        .filter(|session| session.uin == loaded.credential.str_musicid())
        .map(|session| session.account_cache_scope.clone());
    let account_cache_scope = loaded
        .account_cache_scope
        .clone()
        .or(fallback_scope)
        .unwrap_or_else(OpaqueAccountScope::generate);
    let expires_at_ms = credential_expires_at_ms(&loaded.credential, now_ms);
    if loaded.credential.is_expired() || expires_at_ms <= now_ms {
        if loaded.credential.refresh_token.trim().is_empty()
            && loaded.credential.refresh_key.trim().is_empty()
        {
            return Err(QQMusicError::AuthenticationExpired);
        }
        let refreshed = refresh(loaded.credential.clone()).await?;
        if refreshed.musicid != loaded.credential.musicid
            || refreshed.str_musicid() != loaded.credential.str_musicid()
        {
            return Err(QQMusicError::AuthenticationExpired);
        }
        persist_credential_v2(credentials, refreshed.clone(), account_cache_scope.clone()).await?;
        loaded.credential = refreshed;
    }
    session_from_credential(&loaded.credential, account_cache_scope, now_ms).map(Some)
}

pub(crate) async fn clear_v2(
    credentials: &SpawnBlockingCredentialStore,
) -> Result<(), QQMusicError> {
    credentials
        .delete(CREDENTIAL_V2)
        .await
        .map_err(storage_error)
}

pub(crate) struct KeyringCredentialPersist {
    inner: Arc<dyn CredentialStore>,
    account_cache_scope: Option<OpaqueAccountScope>,
}

impl KeyringCredentialPersist {
    pub(crate) fn new(inner: Arc<dyn CredentialStore>) -> Self {
        Self {
            inner,
            account_cache_scope: None,
        }
    }

    fn with_scope(
        inner: Arc<dyn CredentialStore>,
        account_cache_scope: OpaqueAccountScope,
    ) -> Self {
        Self {
            inner,
            account_cache_scope: Some(account_cache_scope),
        }
    }
}

impl std::fmt::Debug for KeyringCredentialPersist {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("KeyringCredentialPersist([REDACTED])")
    }
}

impl CredentialPersist for KeyringCredentialPersist {
    fn load(&self) -> qqmusic_api::Result<Option<String>> {
        self.inner
            .load(CREDENTIAL_V2)
            .map_err(persist_error)?
            .map(|raw| {
                let (library_store, _) = unwrap_library_store(&raw)
                    .map_err(|_| QmError::Io("credential persist was malformed".into()))?;
                serde_json::to_string(&library_store).map_err(QmError::from)
            })
            .transpose()
    }

    fn save(&self, data: &str) -> qqmusic_api::Result<()> {
        let serialized = if let Some(account_cache_scope) = &self.account_cache_scope {
            let library_store: Value = serde_json::from_str(data)?;
            serde_json::to_string(&CredentialV2Envelope {
                version: CREDENTIAL_V2_VERSION,
                library_store,
                account_cache_scope: account_cache_scope.clone(),
            })?
        } else {
            data.to_owned()
        };
        self.inner
            .save(CREDENTIAL_V2, &serialized)
            .map_err(persist_error)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use qqmusic_api::credential_store::CredentialStore as QmapiCredentialStore;
    use yaqmc_core::credentials::MemoryCredentialStore;
    use yaqmc_provider_api::CredentialStore;

    use super::*;

    fn signed_in_session() -> SessionRecord {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "uin": "1000000001",
            "encryptedUin": "EUIN",
            "cookieHeader": "uin=o1000000001; qqmusic_uin=1000000001; qm_keyst=SYNTHETIC_MUSIC_KEY; qqmusic_key=SYNTHETIC_MUSIC_KEY; tmeLoginType=2; euin=EUIN",
            "expiresAtMs": 1_800_000_000_000_u64,
            "accountCacheScope": "0123456789abcdef0123456789abcdef",
        }))
        .expect("session")
    }

    fn library_store(inner: Arc<dyn CredentialStore>) -> QmapiCredentialStore {
        QmapiCredentialStore::from_backend(KeyringCredentialPersist::new(inner)).expect("store")
    }

    #[test]
    fn session_cookie_header_maps_to_library_credential() {
        let credential = credential_from_session(&signed_in_session()).expect("convert");
        assert_eq!(credential.musicid, 1_000_000_001);
        assert_eq!(credential.str_musicid, "1000000001");
        assert_eq!(credential.musickey, "SYNTHETIC_MUSIC_KEY");
        assert_eq!(credential.login_type, 2);
        assert_eq!(credential.encrypt_uin, "EUIN");
        assert_eq!(credential.expired_at, 1_800_000_000);
        let cookies = cookie_header_from_credential(&credential);
        assert!(cookies.contains("qm_keyst=SYNTHETIC_MUSIC_KEY"));
        assert!(cookies.contains("qqmusic_key=SYNTHETIC_MUSIC_KEY"));
        assert!(cookies.contains("tmeLoginType=2"));
        let roundtrip = credential_from_session(&SessionRecord {
            cookie_header: cookies,
            ..signed_in_session()
        })
        .expect("roundtrip");
        assert_eq!(roundtrip.musickey, credential.musickey);
        assert_eq!(roundtrip.musicid, credential.musicid);
    }

    #[test]
    fn synthetic_session_without_musickey_does_not_dual_write() {
        let session = SessionRecord {
            cookie_header: "synthetic_session=candidate".to_owned(),
            ..signed_in_session()
        };
        assert!(matches!(
            credential_from_session(&session),
            Err(QQMusicError::AuthenticationExpired)
        ));
    }

    #[test]
    fn keyring_persist_feeds_library_credential_store() {
        let inner: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let store = library_store(Arc::clone(&inner));
        store
            .add(credential_from_session(&signed_in_session()).expect("convert"))
            .expect("add");
        let current = store.current().expect("current");
        assert_eq!(current.musickey, "SYNTHETIC_MUSIC_KEY");
        assert_eq!(current.musicid, 1_000_000_001);
        let raw = inner.load(CREDENTIAL_V2).expect("load").expect("present");
        assert!(raw.contains("SYNTHETIC_MUSIC_KEY"));
        assert!(!raw.contains("qqmusic-session"));
    }

    #[tokio::test]
    async fn persisted_v2_uses_library_store_and_preserves_account_scope() {
        let inner: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let credentials = SpawnBlockingCredentialStore::new(Arc::clone(&inner));
        persist_v2(&credentials, &signed_in_session())
            .await
            .expect("persist");
        let loaded = library_store(credentials.inner())
            .current()
            .expect("current");
        assert_eq!(loaded.musickey, "SYNTHETIC_MUSIC_KEY");
        assert_eq!(loaded.musicid, 1_000_000_001);
        let raw = inner.load(CREDENTIAL_V2).expect("load").expect("present");
        let envelope: CredentialV2Envelope = serde_json::from_str(&raw).expect("envelope");
        assert_eq!(envelope.version, CREDENTIAL_V2_VERSION);
        assert_eq!(
            envelope.account_cache_scope.as_str(),
            signed_in_session().account_cache_scope.as_str()
        );
        clear_v2(&credentials).await.expect("clear");
        assert!(inner.load(CREDENTIAL_V2).expect("load").is_none());
    }

    #[tokio::test]
    async fn primary_v2_restores_without_legacy_session() {
        let inner: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let credentials = SpawnBlockingCredentialStore::new(Arc::clone(&inner));
        persist_v2(&credentials, &signed_in_session())
            .await
            .expect("persist");

        let restored = load_primary_session_v2(&credentials, None, 1_700_000_000_000)
            .await
            .expect("load")
            .expect("session");

        assert_eq!(restored.uin, signed_in_session().uin);
        assert_eq!(restored.expires_at_ms, 1_800_000_000_000);
        assert_eq!(
            restored.account_cache_scope.as_str(),
            signed_in_session().account_cache_scope.as_str()
        );
        assert!(restored
            .cookie_header
            .contains("qm_keyst=SYNTHETIC_MUSIC_KEY"));
    }

    #[tokio::test]
    async fn legacy_library_store_format_uses_matching_legacy_scope_then_upgrades() {
        let inner: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let capture = KeyringCredentialPersist::new(Arc::clone(&inner));
        let raw_store = serde_json::json!({
            "accounts": {
                "1000000001": credential_from_session(&signed_in_session()).expect("credential")
            },
            "current": 1000000001
        });
        capture
            .save(&serde_json::to_string(&raw_store).expect("store JSON"))
            .expect("seed direct format");
        let credentials = SpawnBlockingCredentialStore::new(Arc::clone(&inner));

        let restored =
            load_primary_session_v2(&credentials, Some(&signed_in_session()), 1_700_000_000_000)
                .await
                .expect("load")
                .expect("session");
        assert_eq!(
            restored.account_cache_scope.as_str(),
            signed_in_session().account_cache_scope.as_str()
        );

        persist_v2(&credentials, &restored).await.expect("upgrade");
        let raw = inner.load(CREDENTIAL_V2).expect("load").expect("present");
        assert!(serde_json::from_str::<CredentialV2Envelope>(&raw).is_ok());
    }

    #[tokio::test]
    async fn expired_refreshable_v2_is_refreshed_persisted_and_restored() {
        let inner: Arc<dyn CredentialStore> = Arc::new(MemoryCredentialStore::default());
        let credentials = SpawnBlockingCredentialStore::new(Arc::clone(&inner));
        let mut expired = credential_from_session(&signed_in_session()).expect("credential");
        expired.musickey = "EXPIRED_KEY".to_owned();
        expired.refresh_token = "SYNTHETIC_REFRESH_TOKEN".to_owned();
        expired.musickey_create_time = 1;
        expired.key_expires_in = 1;
        persist_credential_v2(
            &credentials,
            expired,
            signed_in_session().account_cache_scope,
        )
        .await
        .expect("seed expired");

        let restored = load_primary_session_v2_with_refresh(
            &credentials,
            None,
            1_700_000_000_000,
            |mut credential| async move {
                credential.musickey = "REFRESHED_KEY".to_owned();
                credential.musickey_create_time = 1_700_000_000;
                credential.key_expires_in = 86_400;
                Ok(credential)
            },
        )
        .await
        .expect("load")
        .expect("session");

        assert!(restored.cookie_header.contains("qm_keyst=REFRESHED_KEY"));
        assert_eq!(restored.expires_at_ms, 1_700_086_400_000);
        let raw = inner.load(CREDENTIAL_V2).expect("load").expect("present");
        assert_eq!(
            current_credential(&raw)
                .expect("current")
                .credential
                .musickey,
            "REFRESHED_KEY"
        );
    }

    #[test]
    fn wechat_musickey_defaults_login_type_one() {
        let session = SessionRecord {
            cookie_header: "qm_keyst=W_Xsecret; qqmusic_key=W_Xsecret".to_owned(),
            encrypted_uin: None,
            ..signed_in_session()
        };
        let credential = credential_from_session(&session).expect("convert");
        assert_eq!(credential.login_type, 1);
    }
}
