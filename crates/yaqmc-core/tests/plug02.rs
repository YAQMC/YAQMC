//! PLUG-02: host-proxied network allow/deny + safe-mode crash-loop drill.
//!
//! Uses `plugin/network.rs` (HTTPS-only, private/local IP block) and a temp
//! `ExtensionHost`. The hostile probe is copied into an isolated temp dir and
//! is never enabled as a user plugin. Does not start Electron.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tempfile::TempDir;
use yaqmc_core::plugin::host::ExtensionHost;
use yaqmc_core::plugin::network::proxy_request;
use yaqmc_core::plugin::PluginStatus;

const SAKURA_ID: &str = "dev.yaqmc.example.sakura";
const NETWORK_ID: &str = "dev.yaqmc.example.network";
const HOSTILE_ID: &str = "dev.yaqmc.test.hostile";
const NETWORK_ORIGIN: &str = "network:https://example.com";
const EXAMPLE_ORIGIN: &str = "https://example.com";
const CRASH_LOOP_FAILURES: usize = 3;

fn examples_plugins() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins")
}

fn hostile_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/plugins/hostile")
}

fn example(name: &str) -> PathBuf {
    examples_plugins().join(name)
}

fn assert_example_dir(path: &Path) {
    assert!(
        path.join("manifest.json").is_file(),
        "missing example plugin at {}",
        path.display()
    );
}

fn open_host() -> (TempDir, ExtensionHost) {
    let root = TempDir::new().expect("temp plugin root");
    let host = ExtensionHost::open(root.path().join("plugins")).expect("host opens");
    (root, host)
}

fn assert_not_hostile(host: &ExtensionHost) {
    assert!(
        host.list().iter().all(|record| record.id != HOSTILE_ID),
        "hostile probe must not be installed as a user plugin"
    );
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap_or_else(|error| {
        panic!("create {}: {error}", dst.display());
    });
    for entry in std::fs::read_dir(src).unwrap_or_else(|error| {
        panic!("read {}: {error}", src.display());
    }) {
        let entry = entry.expect("copy dirent");
        let dest = dst.join(entry.file_name());
        if entry.file_type().expect("file type").is_dir() {
            copy_dir(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), &dest).unwrap_or_else(|error| {
                panic!(
                    "copy {} -> {}: {error}",
                    entry.path().display(),
                    dest.display()
                );
            });
        }
    }
}

fn granted_example() -> HashSet<String> {
    HashSet::from([EXAMPLE_ORIGIN.to_owned()])
}

async fn proxy(origins: &HashSet<String>, url: &str) -> Result<Value, String> {
    proxy_request(origins, &json!({ "method": "GET", "url": url })).await
}

fn assert_policy_deny(error: &str, url: &str, needle: &str) {
    assert!(
        error.contains(needle),
        "expected {url} to be denied with `{needle}`, got {error}"
    );
}

#[tokio::test]
async fn proxy_denies_http_and_private_ip_and_allows_granted_https_example() {
    let granted = granted_example();
    let empty = HashSet::new();

    let http = proxy(&granted, "http://example.com/")
        .await
        .expect_err("http must be denied");
    assert_policy_deny(&http, "http://example.com/", "must use https");

    let loopback = proxy(&granted, "https://127.0.0.1/")
        .await
        .expect_err("loopback IP literal must be denied");
    assert_policy_deny(&loopback, "https://127.0.0.1/", "IP literals");

    let link_local = proxy(&granted, "https://169.254.169.254/")
        .await
        .expect_err("link-local IP literal must be denied");
    assert_policy_deny(&link_local, "https://169.254.169.254/", "IP literals");

    let rfc1918 = proxy(&granted, "https://10.0.0.1/")
        .await
        .expect_err("private IP literal must be denied");
    assert_policy_deny(&rfc1918, "https://10.0.0.1/", "IP literals");

    let localhost = proxy(&granted, "https://localhost/")
        .await
        .expect_err("localhost must be denied");
    assert_policy_deny(&localhost, "https://localhost/", "host is not allowed");

    let ungranted = proxy(&empty, "https://example.com/")
        .await
        .expect_err("ungranted origin must be denied before DNS");
    assert_policy_deny(&ungranted, "https://example.com/", "origin is not granted");

    match proxy(&granted, "https://example.com/").await {
        Ok(body) => {
            assert!(
                body.get("status").and_then(Value::as_u64).is_some(),
                "granted https://example.com must return a status: {body}"
            );
        }
        Err(error) => {
            assert!(
                error.contains("timed out")
                    || error.contains("connection failed")
                    || error.contains("request failed")
                    || error.contains("could not be resolved"),
                "granted https://example.com must not be a policy deny: {error}"
            );
            assert!(!error.contains("must use https"), "{error}");
            assert!(!error.contains("origin is not granted"), "{error}");
            assert!(!error.contains("IP literals"), "{error}");
            assert!(!error.contains("private or local"), "{error}");
        }
    }
}

#[tokio::test]
async fn granted_script_network_runtime_proxies_example_origin_only() {
    let network = example("script-network");
    assert_example_dir(&network);

    let (_root, host) = open_host();
    host.set_developer_mode(true)
        .expect("developer mode enables");
    let granted = host
        .install_unpacked(&network, true, &[NETWORK_ORIGIN.to_owned()])
        .expect("network example installs with grant");
    assert_eq!(granted.id, NETWORK_ID);
    assert!(granted
        .network_origins
        .iter()
        .any(|value| value == EXAMPLE_ORIGIN));
    assert_not_hostile(&host);

    let runtime = host.start_runtime(NETWORK_ID).expect("runtime starts");
    assert!(runtime.network_origins.contains(EXAMPLE_ORIGIN));

    let other_origin = proxy(&runtime.network_origins, "https://evil.example/")
        .await
        .expect_err("origin allowlist is example.com only");
    assert_policy_deny(
        &other_origin,
        "https://evil.example/",
        "origin is not granted",
    );

    let http = proxy(&runtime.network_origins, "http://example.com/")
        .await
        .expect_err("granted origin still requires https");
    assert_policy_deny(&http, "http://example.com/", "must use https");

    host.set_enabled(NETWORK_ID, false).expect("disable");
    host.uninstall(NETWORK_ID, true).expect("uninstall");
    assert_not_hostile(&host);
}

#[test]
fn crash_loop_journal_enters_safe_mode_and_disables_hostile_fixture() {
    let source = hostile_fixture();
    assert!(
        source.join("manifest.json").is_file(),
        "missing hostile fixture at {}",
        source.display()
    );

    let root = TempDir::new().expect("temp plugin root");
    let isolated = root.path().join("hostile-fixture");
    copy_dir(&source, &isolated);
    let host_path = root.path().join("plugins");

    {
        let host = ExtensionHost::open(host_path.clone()).expect("host opens");
        host.set_developer_mode(true)
            .expect("developer mode enables");
        let installed = host
            .install_unpacked(&isolated, true, &[])
            .expect("hostile fixture installs in isolated temp host");
        assert_eq!(installed.id, HOSTILE_ID);
        assert!(installed.enabled);
        assert_eq!(installed.status, PluginStatus::Active);
        assert_eq!(host.active_resources().scripts.len(), 1);
        assert!(!host.safe_mode());
        // Unclean drop: activation started, no mark_clean_exit().
    }

    let recovered = ExtensionHost::open(host_path).expect("host reopens after crash");
    assert!(
        recovered.safe_mode(),
        "unclean activation must enter safe mode"
    );
    assert!(recovered.active_resources().safe_mode);
    assert!(recovered.active_resources().scripts.is_empty());
    assert!(recovered.active_resources().styles.is_empty());
    assert!(recovered.active_resources().scenes.is_empty());
    let record = recovered
        .list()
        .into_iter()
        .find(|item| item.id == HOSTILE_ID)
        .expect("hostile fixture still packaged");
    assert!(!record.enabled);
    assert_eq!(record.status, PluginStatus::Failed);
    let denied = recovered
        .start_runtime(HOSTILE_ID)
        .expect_err("safe mode blocks scripts");
    assert!(denied.to_string().contains("safe mode"), "{denied}");
}

#[test]
fn simulated_failures_then_set_safe_mode_clears_resources() {
    let sakura = example("style-sakura");
    assert_example_dir(&sakura);

    let (_root, host) = open_host();
    host.set_developer_mode(true)
        .expect("developer mode enables");
    host.install_unpacked(&sakura, true, &[])
        .expect("sakura installs");
    assert_eq!(host.active_resources().styles.len(), 1);
    assert_not_hostile(&host);

    for index in 0..CRASH_LOOP_FAILURES {
        let failed = host
            .mark_failed(SAKURA_ID, &format!("simulated worker crash {index}"))
            .expect("mark failed");
        assert_eq!(failed.status, PluginStatus::Failed);
        assert!(!failed.enabled);
    }

    host.set_safe_mode(true)
        .expect("safe mode after simulated crash loop");
    assert!(host.safe_mode());
    let resources = host.active_resources();
    assert!(resources.safe_mode);
    assert!(resources.styles.is_empty());
    assert!(resources.scenes.is_empty());
    assert!(resources.scripts.is_empty());
    let denied = host
        .start_runtime(SAKURA_ID)
        .expect_err("safe mode has disabled plugin scripts");
    assert!(denied.to_string().contains("safe mode"), "{denied}");
    let enable_denied = host
        .set_enabled(SAKURA_ID, true)
        .expect_err("safe mode blocks re-enable");
    assert!(
        enable_denied.to_string().contains("safe mode"),
        "{enable_denied}"
    );
    assert_not_hostile(&host);
}
