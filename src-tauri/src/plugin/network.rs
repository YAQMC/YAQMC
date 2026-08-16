use crate::plugin::permissions::is_blocked_ip;
use reqwest::redirect::Policy;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    net::{SocketAddr, ToSocketAddrs},
    time::Duration,
};

const MAX_REQUEST_BODY: usize = 256 * 1024;
const MAX_RESPONSE_BODY: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const REQUEST_TIMEOUT_SECS: u64 = 10;

const ALLOWED_REQUEST_HEADERS: &[&str] = &["accept", "content-type", "user-agent"];

pub async fn proxy_request(
    allowed_origins: &HashSet<String>,
    payload: &Value,
) -> Result<Value, String> {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "HEAD" => {}
        _ => return Err("plugin network method is not allowed".into()),
    }
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "network url is required".to_owned())?;
    let body = payload.get("body").and_then(Value::as_str).unwrap_or("");
    if body.len() > MAX_REQUEST_BODY {
        return Err("plugin network request body is too large".into());
    }
    let headers = payload
        .get("headers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| error.to_string())?;
    let mut current = url.to_owned();
    let mut hops = 0_usize;
    loop {
        let parsed =
            reqwest::Url::parse(&current).map_err(|_| "network url is invalid".to_owned())?;
        deny_url(&parsed)?;
        let origin = origin_of(&parsed)?;
        if !allowed_origins.contains(&origin) {
            return Err("plugin network origin is not granted".into());
        }
        deny_resolved_addresses(&parsed)?;
        let mut builder = client.request(
            reqwest::Method::from_bytes(method.as_bytes())
                .map_err(|_| "network method is invalid")?,
            parsed.clone(),
        );
        for (name, value) in &headers {
            let header = name.to_ascii_lowercase();
            if !ALLOWED_REQUEST_HEADERS.contains(&header.as_str()) {
                return Err(format!("plugin network header {name} is not allowed"));
            }
            let text = value
                .as_str()
                .ok_or_else(|| "plugin network headers must be strings".to_owned())?;
            if text.len() > 240 || text.contains('\n') || text.contains('\r') {
                return Err("plugin network header is invalid".into());
            }
            builder = builder.header(header, text);
        }
        if method != "GET" && method != "HEAD" && !body.is_empty() {
            builder = builder.body(body.to_owned());
        }
        let response = builder.send().await.map_err(classify_reqwest)?;
        let status = response.status();
        if status.is_redirection() {
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err("plugin network redirected too many times".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "plugin network redirect is missing a location".to_owned())?;
            current = parsed
                .join(location)
                .map_err(|_| "plugin network redirect is invalid".to_owned())?
                .to_string();
            continue;
        }
        let bytes = response.bytes().await.map_err(classify_reqwest)?;
        if bytes.len() > MAX_RESPONSE_BODY {
            return Err("plugin network response is too large".into());
        }
        let body = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(json!({
            "ok": status.is_success(),
            "status": status.as_u16(),
            "body": body,
        }));
    }
}

fn origin_of(url: &reqwest::Url) -> Result<String, String> {
    if url.scheme() != "https" {
        return Err("plugin network requests must use https".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "network host is required".to_owned())?;
    Ok(match url.port() {
        None | Some(443) => format!("https://{}", host.to_ascii_lowercase()),
        Some(port) => format!("https://{}:{port}", host.to_ascii_lowercase()),
    })
}

fn deny_url(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("plugin network requests must use https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("plugin network urls cannot include credentials".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "network host is required".to_owned())?;
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.eq_ignore_ascii_case("metadata.google.internal")
    {
        return Err("plugin network host is not allowed".into());
    }
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Err("plugin network IP literals are not allowed".into());
    }
    Ok(())
}

fn deny_resolved_addresses(url: &reqwest::Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "network host is required".to_owned())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|_| "plugin network host could not be resolved".to_owned())?
        .collect();
    if addrs.is_empty() {
        return Err("plugin network host could not be resolved".into());
    }
    if addrs.iter().any(|addr| is_blocked_ip(addr.ip())) {
        return Err("plugin network resolved to a private or local address".into());
    }
    Ok(())
}

fn classify_reqwest(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "plugin network request timed out".into()
    } else if error.is_connect() {
        "plugin network connection failed".into()
    } else {
        "plugin network request failed".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_normalization_strips_path() {
        let url = reqwest::Url::parse("https://API.Example.com/v1").unwrap();
        assert_eq!(origin_of(&url).unwrap(), "https://api.example.com");
        assert!(deny_url(&reqwest::Url::parse("http://api.example.com").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("https://localhost").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("https://169.254.169.254").unwrap()).is_err());
        assert!(deny_url(&reqwest::Url::parse("file:///etc/passwd").unwrap()).is_err());
        assert!(
            deny_url(&reqwest::Url::parse("https://user:pass@api.example.com").unwrap()).is_err()
        );
    }
}
