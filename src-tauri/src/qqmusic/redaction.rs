use reqwest::{
    header::{self, HeaderMap},
    Url,
};
#[cfg(test)]
use serde_json::Value;
use std::collections::BTreeMap;

const REDACTED: &str = "[REDACTED]";
const PRESENT: &str = "[PRESENT]";

#[cfg(test)]
const SECRET_KEYS: &[&str] = &[
    "authorization",
    "cookie",
    "cookies",
    "setcookie",
    "musickey",
    "qmkeyst",
    "qrsig",
    "ptqrtoken",
    "refreshtoken",
    "refreshkey",
    "accesstoken",
    "openid",
    "unionid",
    "uin",
    "musicid",
    "strmusicid",
    "callbackurl",
    "cookieheader",
    "pollsecret",
    "ptsigx",
    "pskey",
    "ptloginsig",
    "gtk",
    "code",
    "accountcachescope",
];

pub(crate) const AUTH_SECRET_HEADERS: &[header::HeaderName] = &[
    header::COOKIE,
    header::AUTHORIZATION,
    header::PROXY_AUTHORIZATION,
];

pub(crate) fn redact_url(url: &Url) -> String {
    let mut redacted = url.clone();
    if !redacted.username().is_empty() {
        let _ = redacted.set_username(REDACTED);
    }
    if redacted.password().is_some() {
        let _ = redacted.set_password(Some(REDACTED));
    }
    let query_names = redacted
        .query_pairs()
        .map(|(name, _)| name.into_owned())
        .collect::<Vec<_>>();
    if !query_names.is_empty() {
        redacted
            .query_pairs_mut()
            .clear()
            .extend_pairs(query_names.iter().map(|name| (name.as_str(), REDACTED)));
    }
    if redacted.fragment().is_some() {
        redacted.set_fragment(Some(REDACTED));
    }
    redacted.to_string()
}

pub(crate) fn redact_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .keys()
        .map(|name| {
            let value = if is_secret_header(name) {
                REDACTED
            } else {
                PRESENT
            };
            (name.as_str().to_owned(), value.to_owned())
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn redact_json(value: &Value) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let value = if is_secret_key(key) {
                        Value::String(REDACTED.to_owned())
                    } else {
                        redact_json(value)
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact_json).collect()),
        _ => value.clone(),
    }
}

pub(crate) fn is_secret_header(name: &header::HeaderName) -> bool {
    *name == header::SET_COOKIE || AUTH_SECRET_HEADERS.iter().any(|secret| secret == name)
}

#[cfg(test)]
fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    SECRET_KEYS.contains(&normalized.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_removes_credentials_and_signed_query_values() {
        let url = reqwest::Url::parse("https://u.y.qq.com/cgi-bin/musicu.fcg?vkey=SECRET&guid=123")
            .expect("URL");
        assert_eq!(
            redact_url(&url),
            "https://u.y.qq.com/cgi-bin/musicu.fcg?vkey=%5BREDACTED%5D&guid=%5BREDACTED%5D"
        );
        let value = serde_json::json!({
            "cookie": "uin=10001; qm_keyst=SECRET",
            "qm_keyst": "SECRET",
            "uin": "10001",
            "nickname": "Synthetic Listener",
            "nested": { "authorization": "Bearer SECRET", "count": 2 }
            ,"cookieHeader": "synthetic-session"
            ,"ptsigx": "synthetic-signature"
            ,"code": "synthetic-code"
        });
        let redacted = redact_json(&value);
        assert_eq!(redacted["cookie"], "[REDACTED]");
        assert_eq!(redacted["qm_keyst"], "[REDACTED]");
        assert_eq!(redacted["uin"], "[REDACTED]");
        assert_eq!(redacted["nested"]["authorization"], "[REDACTED]");
        assert_eq!(redacted["cookieHeader"], "[REDACTED]");
        assert_eq!(redacted["ptsigx"], "[REDACTED]");
        assert_eq!(redacted["code"], "[REDACTED]");
        assert_eq!(redacted["nickname"], "Synthetic Listener");

        let authority_url =
            Url::parse("https://user:password@u.y.qq.com/path?token=SECRET#SECRET-FRAGMENT")
                .expect("URL with authority credentials");
        let authority_redacted = redact_url(&authority_url);
        assert!(!authority_redacted.contains("user"));
        assert!(!authority_redacted.contains("password"));
        assert!(!authority_redacted.contains("SECRET"));
    }

    #[test]
    fn headers_keep_names_without_exposing_values() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "secret-cookie".parse().expect("cookie"));
        headers.insert(
            header::SET_COOKIE,
            "secret-set-cookie".parse().expect("set-cookie"),
        );
        headers.insert("x-request-id", "public-id".parse().expect("request id"));

        let redacted = redact_headers(&headers);

        assert_eq!(redacted.get("cookie").map(String::as_str), Some(REDACTED));
        assert_eq!(
            redacted.get("set-cookie").map(String::as_str),
            Some(REDACTED)
        );
        assert_eq!(
            redacted.get("x-request-id").map(String::as_str),
            Some(PRESENT)
        );
        assert!(!format!("{redacted:?}").contains("secret"));
        assert!(!format!("{redacted:?}").contains("public-id"));
    }

    #[test]
    fn secret_header_allowlist_matches_the_protocol_ledger() {
        let provider_specific_headers: Vec<_> = AUTH_SECRET_HEADERS
            .iter()
            .filter(|name| {
                !matches!(
                    name.as_str(),
                    "cookie" | "authorization" | "proxy-authorization"
                )
            })
            .collect();
        assert!(
            provider_specific_headers.is_empty(),
            "Task 1 records no provider-specific secret request headers"
        );
    }

    #[test]
    fn every_account_secret_shape_is_redacted_without_hiding_public_metadata() {
        let secrets = serde_json::json!({
            "authorization": "Bearer SECRET",
            "Cookie": "uin=SECRET",
            "Set-Cookie": "qm_keyst=SECRET",
            "qm_keyst": "SECRET",
            "qrsig": "SECRET",
            "ptqrtoken": "SECRET",
            "access_token": "SECRET",
            "refresh_token": "SECRET",
            "refresh_key": "SECRET",
            "musickey": "SECRET",
            "openid": "SECRET",
            "unionid": "SECRET",
            "uin": "SECRET",
            "musicid": "SECRET",
            "str_musicid": "SECRET",
            "callback_url": "https://y.qq.com/callback?code=SECRET",
            "pollSecret": "SECRET",
        });
        let redacted = redact_json(&secrets);
        for (key, value) in redacted.as_object().expect("redacted object") {
            assert_eq!(value, REDACTED, "{key}");
        }

        let public = serde_json::json!({
            "offset": 20,
            "limit": 50,
            "trackId": "qqmusic:track:SYNTHETIC_PUBLIC_ID",
            "documentationField": "cookie",
            "sentinel": "SANITIZED_ACCOUNT",
            "avatarUrl": "https://qpic.y.qq.com/synthetic.png",
        });
        assert_eq!(redact_json(&public), public);
    }

    #[test]
    fn signed_media_url_and_all_secret_headers_keep_no_original_value() {
        let url = Url::parse(
            "https://isure.stream.qqmusic.qq.com/M500synthetic.mp3?vkey=SECRET123&token=SECRET456",
        )
        .expect("signed media URL");
        let redacted_url = redact_url(&url);
        assert!(!redacted_url.contains("SECRET123"));
        assert!(!redacted_url.contains("SECRET456"));
        assert_eq!(redacted_url.matches("%5BREDACTED%5D").count(), 2);

        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "cookie-secret".parse().expect("cookie"));
        headers.insert(
            header::SET_COOKIE,
            "set-cookie-secret".parse().expect("set-cookie"),
        );
        headers.insert(
            header::AUTHORIZATION,
            "Bearer authorization-secret"
                .parse()
                .expect("authorization"),
        );
        headers.insert(
            header::PROXY_AUTHORIZATION,
            "Basic proxy-secret".parse().expect("proxy authorization"),
        );
        let redacted = redact_headers(&headers);
        assert!(redacted.values().all(|value| value == REDACTED));
        let rendered = format!("{redacted:?}");
        for forbidden in ["cookie-secret", "authorization-secret", "proxy-secret"] {
            assert!(!rendered.contains(forbidden));
        }
    }
}
