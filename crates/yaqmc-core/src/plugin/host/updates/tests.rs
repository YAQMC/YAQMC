use super::super::tests::{
    account_component_inspection, multi_provider_component_inspection, provider_registry,
    style_inspection,
};
use super::*;

#[tokio::test]
async fn first_install_validation_allows_declarative_ui_but_blocks_player_control() {
    use crate::{
        player::PlayerService,
        plugin::{api::PluginBridgeRequest, bridge::dispatch_bridge, package::PackageFile},
    };
    use serde_json::json;

    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let id = "dev.example.update";
    assert!(host.record(id).is_err());
    let mut inspection = style_inspection(id);
    inspection.manifest.api_version = 4;
    inspection.manifest.permissions = ["ui.pages", "ui.navigation", "ui.layout", "player.control"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    inspection.manifest.entrypoints.script = Some("dist/main.js".into());
    inspection.manifest.validate().unwrap();
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    inspection.files.push(PackageFile {
        path: "dist/main.js".into(),
        bytes: b"definePlugin({ activate() {} });".to_vec(),
    });
    inspection.file_count = inspection.files.len();
    let path = root.path().join("pages-v4");
    extract_to(&inspection, &path).unwrap();
    let op = prepared(&host, &path).await;
    assert_eq!(op.phase, "prepared", "{:?}", op.error);
    let preview = op.preview.as_ref().unwrap();
    assert!(preview.current_version.is_none());
    assert!(preview.needs_renderer && preview.has_script && preview.enabled);
    let hash = preview.sha256.clone();
    host.apply_update(ApplyRequest {
        operation_id: op.operation_id.clone(),
        confirm: true,
        grant: preview.added_permissions.clone(),
        ..Default::default()
    })
    .unwrap();
    let acknowledge = |stage: &str| RuntimeReadyRequest {
        operation_id: op.operation_id.clone(),
        sha256: hash.clone(),
        stage: stage.into(),
        error: None,
    };
    phase(&host, &op.operation_id, "quiescing").await;
    host.update_runtime_ready(acknowledge("quiescing")).unwrap();
    phase(&host, &op.operation_id, "validating").await;
    let token = host.start_runtime(id).unwrap();
    let player = PlayerService::new();
    for (method, payload) in [
        ("ui.pages.register", json!({"id":"page", "title":"Page"})),
        (
            "ui.pages.render",
            json!({"pageId":"page", "blocks":[{"type":"text", "text":"Ready"}]}),
        ),
        (
            "ui.navigation.register",
            json!({"id":"nav", "label":"Page", "pageId":"page"}),
        ),
        (
            "ui.layout.set",
            json!({"target":"home", "order":["radar","for-you"]}),
        ),
        ("ui.layout.clear", json!({"target":"home"})),
        ("ui.navigation.unregister", json!({"id":"nav"})),
        ("ui.pages.unregister", json!({"pageId":"page"})),
    ] {
        let response = dispatch_bridge(
            &host,
            &player,
            &PluginBridgeRequest {
                token: token.token.clone(),
                method: method.into(),
                payload,
            },
        )
        .await
        .expect(method);
        assert_eq!(response["ok"], json!(true), "{method}");
    }
    let error = dispatch_bridge(
        &host,
        &player,
        &PluginBridgeRequest {
            token: token.token.clone(),
            method: "player.pause".into(),
            payload: json!({}),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error, "update-validation-in-progress");
    host.update_runtime_ready(acknowledge("validating"))
        .unwrap();
    let completed = wait(&host, &op.operation_id, false).await;
    assert_eq!(completed.phase, "completed", "{:?}", completed.error);
    assert_eq!(host.record(id).unwrap().version, "1.0.0");
}
use crate::credentials::MemoryCredentialStore;

fn fixture(root: &Path, version: &str, style: &str) -> PathBuf {
    let mut inspection = style_inspection("dev.example.update");
    inspection.manifest.version = version.into();
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    inspection.files[1].bytes = style.as_bytes().to_vec();
    let path = root.join(format!("package-{:016x}", rand::random::<u64>()));
    extract_to(&inspection, &path).unwrap();
    path
}

fn host(root: &Path) -> Arc<ExtensionHost> {
    let host = Arc::new(ExtensionHost::open(root.join("plugins")).unwrap());
    host.set_developer_mode(true).unwrap();
    host
}

#[tokio::test]
async fn only_two_downloads_run_and_cancelling_a_queued_download_never_starts_it() {
    let root = tempfile::tempdir().unwrap();
    let server = remote::tests::TestServer::start().await;
    server
        .routes
        .lock()
        .unwrap()
        .insert("/package".into(), (0, vec![], vec![]));
    let source = remote::TrustedSource {
        id: "test-source".into(),
        plugin_id: "dev.example.update".into(),
        name: "Fixture".into(),
        repository: "https://example.com".into(),
        feed_url: "https://example.com/feed".into(),
        key_id: "test".into(),
        public_key: "".into(),
        download_origins: vec!["https://example.com".into()],
    };
    let mut value = ExtensionHost::open(root.path().join("plugins")).unwrap();
    value.updates.sources = vec![source.clone()];
    value.updates.http = server.http.clone();
    let host = Arc::new(value);
    host.set_developer_mode(true).unwrap();
    apply(
        &host,
        prepared(&host, &fixture(root.path(), "1.0.0", "body { color:red; }")).await,
    )
    .await;
    host.set_update_policy(PolicyRequest {
        plugin_id: source.plugin_id.clone(),
        source_id: Some(source.id.clone()),
        channel: ReleaseChannel::Stable,
        automatic: false,
        confirm_source: true,
    })
    .unwrap();
    let record = remote::ReleaseRecord {
        plugin_id: source.plugin_id.clone(),
        version: "2.0.0".into(),
        release: ReleaseInfo {
            channel: ReleaseChannel::Stable,
            build_id: "test".into(),
            release_sequence: 1,
        },
        sha256: "a".repeat(64),
        size: 100,
        url: "https://example.com/package".into(),
    };
    host.updates.releases.lock().unwrap().insert(
        "fixture".into(),
        remote::AvailableRelease {
            release_id: "fixture".into(),
            source_id: source.id,
            expires_at_ms: now_ms() + 600_000,
            record,
        },
    );
    let prepare = || {
        host.prepare_update(PrepareRequest {
            github: None,
            path: None,
            plugin_id: Some(source.plugin_id.clone()),
            release_id: Some("fixture".into()),
            unpacked: false,
        })
        .unwrap()
    };
    let first = prepare();
    let second = prepare();
    tokio::time::timeout(Duration::from_secs(3), async {
        while server.requests.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let third = prepare();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(server.requests.load(Ordering::SeqCst), 2);
    host.cancel_update(&third.operation_id).unwrap();
    for op in [first, second] {
        host.cancel_update(&op.operation_id).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(server.requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn settings_editing_and_live_calls_delay_installation_without_revoking_tokens() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    apply(
        &host,
        prepared(&host, &fixture(root.path(), "1.0.0", "body { color:red; }")).await,
    )
    .await;
    let token = host.start_runtime("dev.example.update").unwrap();
    let call = host.begin_bridge_call(&token.token).unwrap();
    host.update_editing("dev.example.update", true).unwrap();
    let op = prepared(
        &host,
        &fixture(root.path(), "2.0.0", "body { color:blue; }"),
    )
    .await;
    host.apply_update(ApplyRequest {
        operation_id: op.operation_id.clone(),
        confirm: true,
        ..Default::default()
    })
    .unwrap();
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(
        host.update_status(Some(&op.operation_id)).unwrap()[0].phase,
        "waiting-idle"
    );
    assert!(host.runtime(&token.token).is_some());
    drop(call);
    assert_eq!(
        host.busy_reason("dev.example.update").await,
        Some("settings")
    );
    host.update_editing("dev.example.update", false).unwrap();
    assert_eq!(wait(&host, &op.operation_id, true).await.phase, "completed");
}

async fn prepared(host: &Arc<ExtensionHost>, path: &Path) -> UpdateOperation {
    let op = host
        .prepare_update(PrepareRequest {
            github: None,
            path: Some(path.display().to_string()),
            plugin_id: None,
            release_id: None,
            unpacked: true,
        })
        .unwrap();
    wait(host, &op.operation_id, false).await
}

async fn wait(host: &ExtensionHost, id: &str, acknowledge: bool) -> UpdateOperation {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut acknowledged = HashSet::new();
        loop {
            let op = host.update_status(Some(id)).unwrap().remove(0);
            if op.terminal() || (!acknowledge && op.phase == "prepared") {
                return op;
            }
            if acknowledge
                && matches!(op.phase.as_str(), "quiescing" | "validating")
                && acknowledged.insert(op.phase.clone())
            {
                host.update_runtime_ready(RuntimeReadyRequest {
                    operation_id: id.into(),
                    sha256: op.preview.as_ref().unwrap().sha256.clone(),
                    stage: op.phase.clone(),
                    error: None,
                })
                .unwrap();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("operation should finish")
}

async fn apply(host: &Arc<ExtensionHost>, op: UpdateOperation) -> UpdateOperation {
    assert_eq!(op.phase, "prepared", "{:?}", op.error);
    host.apply_update(ApplyRequest {
        operation_id: op.operation_id.clone(),
        confirm: true,
        grant: op.preview.as_ref().unwrap().added_permissions.clone(),
        ..Default::default()
    })
    .unwrap();
    wait(host, &op.operation_id, true).await
}

#[tokio::test]
async fn upgrades_same_version_replacements_and_identical_packages_preserve_state() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let first = fixture(root.path(), "1.0.0", "body { color: red; }");
    assert_eq!(
        apply(&host, prepared(&host, &first).await).await.phase,
        "completed"
    );
    let token = host.start_runtime("dev.example.update").unwrap();
    let identical = prepared(&host, &first).await;
    assert_eq!(identical.phase, "unchanged");
    assert!(
        host.runtime(&token.token).is_some(),
        "identical content must not revoke the running instance"
    );
    host.storage_set("dev.example.update", "session", "fake-login-reference")
        .unwrap();
    host.set_enabled("dev.example.update", false).unwrap();
    let same = prepared(&host, &first).await;
    assert_eq!(same.phase, "unchanged");
    assert!(!same.runtime_changed);
    let replacement = fixture(root.path(), "1.0.0", "body { color: green; }");
    let op = prepared(&host, &replacement).await;
    assert!(op
        .preview
        .as_ref()
        .unwrap()
        .confirmations
        .contains(&"replacement".into()));
    assert!(host
        .apply_update(ApplyRequest {
            operation_id: op.operation_id.clone(),
            ..Default::default()
        })
        .is_err());
    assert_eq!(apply(&host, op).await.phase, "completed");
    assert!(!host.record("dev.example.update").unwrap().enabled);
    assert_eq!(
        host.storage_get("dev.example.update", "session").as_deref(),
        Some("fake-login-reference")
    );
    let upgrade = fixture(root.path(), "1.2.0", "body { color: blue; }");
    assert_eq!(
        apply(&host, prepared(&host, &upgrade).await).await.phase,
        "completed"
    );
    let packages = fs::read_dir(host.root.join("dev.example.update/packages"))
        .unwrap()
        .count();
    assert_eq!(packages, 2, "retain active and previous content only");
    let downgrade = prepared(&host, &first).await;
    assert!(downgrade
        .preview
        .unwrap()
        .confirmations
        .contains(&"downgrade".into()));
}

async fn phase(host: &ExtensionHost, id: &str, expected: &str) -> UpdateOperation {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let op = host.update_status(Some(id)).unwrap().remove(0);
            if op.phase == expected {
                break op;
            }
            assert!(!op.terminal(), "{}: {:?}", op.phase, op.error);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn renderer_failure_restores_data_and_acknowledgements_are_stage_bound() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let first = fixture(root.path(), "1.0.0", "body { color: red; }");
    apply(&host, prepared(&host, &first).await).await;
    host.storage_set("dev.example.update", "session", "old-session")
        .unwrap();
    let candidate = fixture(root.path(), "2.0.0", "body { color: blue; }");
    let op = prepared(&host, &candidate).await;
    let hash = op.preview.as_ref().unwrap().sha256.clone();
    host.apply_update(ApplyRequest {
        operation_id: op.operation_id.clone(),
        confirm: true,
        grant: op.preview.as_ref().unwrap().added_permissions.clone(),
        ..Default::default()
    })
    .unwrap();
    phase(&host, &op.operation_id, "quiescing").await;
    let ready = |stage: &str, sha256: String, error: Option<String>| RuntimeReadyRequest {
        operation_id: op.operation_id.clone(),
        sha256,
        stage: stage.into(),
        error,
    };
    assert!(host
        .update_runtime_ready(ready("quiescing", "0".repeat(64), None))
        .is_err());
    host.update_runtime_ready(ready("quiescing", hash.clone(), None))
        .unwrap();
    assert!(host
        .update_runtime_ready(ready("quiescing", hash.clone(), None))
        .is_err());
    phase(&host, &op.operation_id, "validating").await;
    assert!(host
        .update_runtime_ready(ready("quiescing", hash.clone(), None))
        .is_err());
    host.storage_set("dev.example.update", "session", "candidate-write")
        .unwrap();
    assert_eq!(
        read_json::<BTreeMap<String, String>>(&host.root.join("dev.example.update.storage.json"))
            .unwrap()["session"],
        "old-session"
    );
    host.update_runtime_ready(ready("validating", hash, Some("activation failed".into())))
        .unwrap();
    let failed = wait(&host, &op.operation_id, false).await;
    assert_eq!(
        failed.error.as_deref(),
        Some("update-renderer-start-failed")
    );
    assert!(failed.runtime_changed);
    assert_eq!(host.record("dev.example.update").unwrap().version, "1.0.0");
    assert_eq!(
        host.storage_get("dev.example.update", "session").as_deref(),
        Some("old-session")
    );
}

#[tokio::test]
async fn concurrent_reviews_are_serialized_and_only_one_generation_wins() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let a = prepared(
        &host,
        &fixture(root.path(), "1.0.0", "body { color: red; }"),
    )
    .await;
    let b = prepared(
        &host,
        &fixture(root.path(), "2.0.0", "body { color: blue; }"),
    )
    .await;
    let (a, b) = tokio::join!(apply(&host, a), apply(&host, b));
    let mut phases = vec![a.phase.as_str(), b.phase.as_str()];
    phases.sort();
    assert_eq!(phases, ["completed", "failed"]);
    let failed = if a.phase == "failed" { a } else { b };
    assert_eq!(failed.error.as_deref(), Some("update-review-stale"));
    assert!(!failed.runtime_changed);
}

#[tokio::test]
async fn preparation_freezes_original_bytes_and_safe_mode_does_not_activate() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    host.set_safe_mode(true).unwrap();
    let path = fixture(root.path(), "1.0.0", "body { color: red; }");
    let candidate = prepared(&host, &path).await;
    fs::write(path.join("styles/main.css"), "body { color: blue; }").unwrap();
    let result = apply(&host, candidate).await;
    assert_eq!(result.phase, "completed");
    assert!(!host.record("dev.example.update").unwrap().enabled);
    let directory = host.inner.lock().unwrap().records["dev.example.update"]
        .2
        .clone();
    assert_eq!(
        fs::read_to_string(directory.join("styles/main.css")).unwrap(),
        "body { color: red; }"
    );
    assert!(host.start_runtime("dev.example.update").is_err());
}

#[tokio::test]
async fn failures_after_commit_keep_the_successful_installation() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    *host.updates.fault.lock().unwrap() = Some("committed".into());
    let op = apply(
        &host,
        prepared(
            &host,
            &fixture(root.path(), "1.0.0", "body { color: red; }"),
        )
        .await,
    )
    .await;
    assert_eq!(op.phase, "completed", "{:?}", op.error);
    assert_eq!(host.record("dev.example.update").unwrap().version, "1.0.0");
}

#[tokio::test]
async fn application_restart_waits_for_plugin_commit_and_closes_new_mutation_admission() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    apply(
        &host,
        prepared(&host, &fixture(root.path(), "1.0.0", "body {color:red}")).await,
    )
    .await;
    let op = prepared(&host, &fixture(root.path(), "2.0.0", "body {color:blue}")).await;
    host.apply_update(ApplyRequest {
        operation_id: op.operation_id.clone(),
        confirm: true,
        ..Default::default()
    })
    .unwrap();
    phase(&host, &op.operation_id, "quiescing").await;
    let restarting = host.clone();
    let drain = tokio::spawn(async move { restarting.prepare_app_restart().await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        !drain.is_finished(),
        "restart cannot interrupt the old worker handoff"
    );
    assert!(host.set_enabled("dev.example.update", false).is_err());
    assert!(host.check_updates(None).is_err());
    assert_eq!(wait(&host, &op.operation_id, true).await.phase, "completed");
    drain.await.unwrap().unwrap();
    assert_eq!(host.record("dev.example.update").unwrap().version, "2.0.0");
    host.cancel_app_restart();
    host.set_enabled("dev.example.update", false).unwrap();
}

#[tokio::test]
async fn local_replacement_keeps_recovery_journal_until_trust_pause_is_durable() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let id = "dev.example.update";
    assert_eq!(
        apply(
            &host,
            prepared(&host, &fixture(root.path(), "1.0.0", "body { color:red; }")).await
        )
        .await
        .phase,
        "completed"
    );
    let policy_path = host.root.join("update-policies.json");
    // Preserve a previously bound source on disk to reproduce a failed final
    // policy write without relying on platform-specific filesystem ACLs.
    {
        let mut policies = host.updates.policies.lock().unwrap();
        let policy = policies.entry(id.into()).or_default();
        policy.source_id = Some("previous-source".into());
        policy.automatic = true;
        policy.bound = true;
        write_json(&policy_path, &*policies).unwrap();
    }
    let next = prepared(
        &host,
        &fixture(root.path(), "2.0.0", "body { color:blue; }"),
    )
    .await;
    *host.updates.fault.lock().unwrap() = Some("policy-write".into());
    let result = apply(&host, next).await;
    assert_eq!(result.phase, "completed");
    assert_eq!(
        result.error.as_deref(),
        Some("update-committed-cleanup-pending")
    );
    assert_eq!(host.record(id).unwrap().version, "2.0.0");
    let persisted: BTreeMap<String, UpdatePolicy> = read_json(&policy_path).unwrap();
    assert!(persisted[id].bound);
    assert!(!host.update_policy(id).automatic);
    assert!(
        host.set_enabled(id, false).is_err(),
        "pending recovery blocks mutations"
    );
    let journal = host
        .root
        .join(".updates")
        .join(&result.operation_id)
        .join("transaction.json");
    let tx: Transaction = read_json(&journal).unwrap();
    assert!(tx.committed && !tx.policy_recorded);
    drop(host);
    let restored = ExtensionHost::open(root.path().join("plugins")).unwrap();
    assert_eq!(restored.record(id).unwrap().version, "2.0.0");
    let persisted: BTreeMap<String, UpdatePolicy> = read_json(&policy_path).unwrap();
    assert!(!persisted[id].bound && !persisted[id].automatic);
    assert_eq!(persisted[id].source_id.as_deref(), Some("previous-source"));
    assert!(!journal.exists());
    restored.set_enabled(id, false).unwrap();
}

#[tokio::test]
async fn malformed_policy_fails_closed_for_remote_but_keeps_local_updates() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("plugins")).unwrap();
    let path = root.path().join("plugins/update-policies.json");
    fs::write(&path, "broken").unwrap();
    let host = host(root.path());
    assert!(host.check_updates(None).is_err());
    assert_eq!(
        apply(
            &host,
            prepared(
                &host,
                &fixture(root.path(), "1.0.0", "body { color: red; }")
            )
            .await
        )
        .await
        .phase,
        "completed"
    );
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "broken",
        "never erase replay protection on parse failure"
    );
}

#[tokio::test]
async fn multi_provider_update_keeps_federation_and_isolates_only_changed_sessions() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    host.attach_provider_runtime(
        provider_registry(root.path()),
        Arc::new(MemoryCredentialStore::default()),
        root.path().join("cache/components"),
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    let mut inspection = multi_provider_component_inspection();
    let id = inspection.manifest.id.clone();
    let path = root.path().join("multi");
    extract_to(&inspection, &path).unwrap();
    assert_eq!(
        apply(&host, prepared(&host, &path).await).await.phase,
        "completed"
    );
    host.settings_set(
        &id,
        serde_json::json!({"mode":"aggregate"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    let changed = inspection.manifest.providers[0].id.clone();
    inspection.manifest.providers[0].session_schema_version = 2;
    inspection.manifest.version = "2.0.0".into();
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    extract_to(&inspection, &path).unwrap();
    let op = prepared(&host, &path).await;
    assert_eq!(
        op.preview.as_ref().unwrap().session_changes,
        [changed.clone()]
    );
    assert_eq!(apply(&host, op).await.phase, "completed");
    let runtime = host.provider_runtime.lock().unwrap();
    assert_eq!(runtime.active.len(), 3);
    assert_eq!(
        runtime.federations[&id],
        ["org.example.multi-music.aggregate"]
    );
    drop(runtime);
    let inner = host.inner.lock().unwrap();
    assert_eq!(inner.records[&id].0.session_epochs.len(), 1);
    assert!(inner.records[&id].0.session_epochs.contains_key(&changed));
}

#[tokio::test]
async fn permission_expansion_needs_grants_and_removal_revokes_old_authority() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let mut inspection = style_inspection("dev.example.permissions");
    inspection.manifest.api_version = 2;
    inspection.manifest.permissions = vec!["player.control".into()];
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    let path = root.path().join("permissions");
    extract_to(&inspection, &path).unwrap();
    apply(&host, prepared(&host, &path).await).await;
    let old = host.start_runtime("dev.example.permissions").unwrap();
    inspection.manifest.version = "2.0.0".into();
    inspection.manifest.permissions = vec![
        "plugin.storage".into(),
        "network:https://api.example.com".into(),
    ];
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    extract_to(&inspection, &path).unwrap();
    let op = prepared(&host, &path).await;
    let view = op.preview.as_ref().unwrap();
    assert!(view.removed_permissions.contains(&"player.control".into()));
    assert!(view.added_permissions.contains(&"plugin.storage".into()));
    assert!(view
        .added_permissions
        .contains(&"network:https://api.example.com".into()));
    assert!(host
        .apply_update(ApplyRequest {
            operation_id: op.operation_id.clone(),
            confirm: true,
            ..Default::default()
        })
        .is_err());
    assert_eq!(apply(&host, op).await.phase, "completed");
    assert!(host.runtime(&old.token).is_none());
    assert!(!host
        .record("dev.example.permissions")
        .unwrap()
        .granted_permissions
        .contains(&"player.control".into()));
}

#[tokio::test]
async fn stale_review_and_staged_tampering_do_not_replace_old_content() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let first = fixture(root.path(), "1.0.0", "body { color: red; }");
    apply(&host, prepared(&host, &first).await).await;
    let next = fixture(root.path(), "1.1.0", "body { color: blue; }");
    let op = prepared(&host, &next).await;
    host.set_enabled("dev.example.update", false).unwrap();
    host.set_enabled("dev.example.update", true).unwrap();
    let failed = apply(&host, op).await;
    assert_eq!(failed.error.as_deref(), Some("update-review-stale"));
    let op = prepared(&host, &next).await;
    fs::write(
        host.root
            .join(".updates")
            .join(&op.operation_id)
            .join("package/styles/main.css"),
        "changed",
    )
    .unwrap();
    let failed = apply(&host, op).await;
    assert_eq!(
        failed.error.as_deref(),
        Some("update-staged-content-changed")
    );
    assert_eq!(host.record("dev.example.update").unwrap().version, "1.0.0");
}

#[tokio::test]
async fn failures_restore_content_enabled_state_and_data_and_allow_retry() {
    for phase in [
        "journal",
        "quiesced",
        "validated",
        "data-write",
        "state-write",
    ] {
        let root = tempfile::tempdir().unwrap();
        let host = host(root.path());
        let first = fixture(root.path(), "1.0.0", "body { color: red; }");
        apply(&host, prepared(&host, &first).await).await;
        host.storage_set("dev.example.update", "account", "simulated-session")
            .unwrap();
        let next = fixture(root.path(), "2.0.0", "body { color: blue; }");
        let op = prepared(&host, &next).await;
        *host.updates.fault.lock().unwrap() = Some(phase.into());
        let failed = apply(&host, op).await;
        assert_eq!(failed.phase, "failed", "{phase}: {:?}", failed.error);
        assert_eq!(
            host.record("dev.example.update").unwrap().version,
            "1.0.0",
            "{phase}"
        );
        assert!(host.record("dev.example.update").unwrap().enabled);
        assert_eq!(
            host.storage_get("dev.example.update", "account").as_deref(),
            Some("simulated-session")
        );
        assert_eq!(
            apply(&host, prepared(&host, &next).await).await.phase,
            "completed"
        );
    }
}

#[tokio::test]
async fn component_credentials_and_settings_survive_and_changed_schema_isolated() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let credentials = Arc::new(MemoryCredentialStore::default());
    host.attach_provider_runtime(
        provider_registry(root.path()),
        credentials,
        root.path().join("cache/components"),
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    let mut inspection = account_component_inspection();
    inspection.manifest.settings_schema = Some(
        serde_json::json!({"fields":[{"id":"accent","type":"text","default":"blue"},{"id":"password","type":"password"}]}),
    );
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    let path = root.path().join("account");
    extract_to(&inspection, &path).unwrap();
    let installed = apply(&host, prepared(&host, &path).await).await;
    assert_eq!(installed.phase, "completed", "{:?}", installed.error);
    let services = host
        .provider_runtime
        .lock()
        .unwrap()
        .host_services
        .clone()
        .unwrap();
    let old = services.for_plugin(
        "dev.example.host-probe",
        "provider.host-probe",
        HashSet::from(["https://api.example.com".into()]),
    );
    old.kv_set("session", "logged-in").unwrap();
    let handle = old
        .credential_create("https://api.example.com", "test-secret-not-in-journal")
        .unwrap();
    host.settings_set(
        "dev.example.host-probe",
        serde_json::json!({"accent":"green","password":"old-password"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    inspection.manifest.version = "1.1.0".into();
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    extract_to(&inspection, &path).unwrap();
    let updated = apply(&host, prepared(&host, &path).await).await;
    assert_eq!(updated.phase, "completed", "{:?}", updated.error);
    let restored = services.for_plugin(
        "dev.example.host-probe",
        "provider.host-probe",
        HashSet::from(["https://api.example.com".into()]),
    );
    assert_eq!(
        restored.kv_get("session").unwrap().as_deref(),
        Some("logged-in")
    );
    assert!(restored
        .credential_resolve(&handle, "https://api.example.com")
        .is_ok());
    assert_eq!(
        host.settings_get("dev.example.host-probe", true).unwrap()["accent"],
        "green"
    );
    inspection
        .manifest
        .provider
        .as_mut()
        .unwrap()
        .session_schema_version = 2;
    inspection.manifest.version = "2.0.0".into();
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    extract_to(&inspection, &path).unwrap();
    let op = prepared(&host, &path).await;
    assert_eq!(
        op.preview.as_ref().unwrap().session_changes,
        ["provider.host-probe"]
    );
    assert_eq!(apply(&host, op).await.phase, "completed");
    let epoch = host.inner.lock().unwrap().records["dev.example.host-probe"]
        .0
        .session_epochs["provider.host-probe"]
        .clone();
    let fresh = services.for_plugin_session(
        "dev.example.host-probe",
        "provider.host-probe",
        HashSet::new(),
        serde_json::json!({}),
        Some(&epoch),
    );
    assert_eq!(fresh.kv_get("session").unwrap(), None);
    assert!(fresh
        .credential_resolve(&handle, "https://api.example.com")
        .is_err());
    assert_eq!(
        restored.kv_get("session").unwrap().as_deref(),
        Some("logged-in")
    );
    let effective = || {
        let adapter = host.provider_runtime.lock().unwrap().active["provider.host-probe"]
            .adapter
            .clone();
        serde_json::from_str::<serde_json::Value>(
            &adapter.component().host_settings_for_test().unwrap(),
        )
        .unwrap()
    };
    assert_eq!(effective()["password"], serde_json::Value::Null);
    assert_eq!(effective()["accent"], "green");
    host.settings_set(
        "dev.example.host-probe",
        serde_json::json!({"password":"new-password"})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(effective()["password"], "new-password");
    host.uninstall("dev.example.host-probe", true).unwrap();
    assert!(
        restored
            .credential_resolve(&handle, "https://api.example.com")
            .is_err(),
        "explicit data removal cleans retained sessions too"
    );
}

#[tokio::test]
async fn renderer_timeout_restores_the_previous_installation() {
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    apply(
        &host,
        prepared(&host, &fixture(root.path(), "1.0.0", "body { color:red; }")).await,
    )
    .await;
    let op = prepared(
        &host,
        &fixture(root.path(), "2.0.0", "body { color:blue; }"),
    )
    .await;
    host.apply_update(ApplyRequest {
        operation_id: op.operation_id.clone(),
        confirm: true,
        ..Default::default()
    })
    .unwrap();
    let quiescing = phase(&host, &op.operation_id, "quiescing").await;
    host.update_runtime_ready(RuntimeReadyRequest {
        operation_id: op.operation_id.clone(),
        stage: "quiescing".into(),
        sha256: quiescing.preview.unwrap().sha256,
        error: None,
    })
    .unwrap();
    phase(&host, &op.operation_id, "validating").await;
    let failed = wait(&host, &op.operation_id, false).await;
    assert_eq!(failed.error.as_deref(), Some("update-renderer-timeout"));
    assert_eq!(host.record("dev.example.update").unwrap().version, "1.0.0");
}

#[tokio::test]
async fn crash_child() {
    let Ok(directory) = std::env::var("YAQMC_TEST_UPDATE_DIRECTORY") else {
        return;
    };
    let root = PathBuf::from(directory);
    let host = host(&root);
    let first = fixture(&root, "1.0.0", "body { color:red; }");
    // Fault injection is activated only after the first successful installation.
    let phase = std::env::var("YAQMC_TEST_CRASH_PHASE").unwrap();
    apply(&host, prepared(&host, &first).await).await;
    host.storage_set("dev.example.update", "session", "kept")
        .unwrap();
    std::env::set_var("YAQMC_TEST_UPDATE_CRASH", phase);
    let next = fixture(&root, "2.0.0", "body { color:blue; }");
    apply(&host, prepared(&host, &next).await).await;
    panic!("crash injection did not execute");
}

#[test]
fn process_exit_recovers_before_commit_and_keeps_committed_content() {
    for phase in [
        "journal",
        "quiesced",
        "validated",
        "data-write",
        "state-write",
        "committed",
    ] {
        let root = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["plugin::host::updates::tests::crash_child", "--exact"])
            .env("YAQMC_TEST_UPDATE_DIRECTORY", root.path())
            .env("YAQMC_TEST_CRASH_PHASE", phase)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(91), "{phase}");
        let recovered = host(root.path());
        let record = recovered.record("dev.example.update").unwrap();
        assert_eq!(
            record.version,
            if phase == "committed" {
                "2.0.0"
            } else {
                "1.0.0"
            },
            "{phase}"
        );
        assert!(record.enabled, "{phase}");
        assert_eq!(
            recovered
                .storage_get("dev.example.update", "session")
                .as_deref(),
            Some("kept")
        );
    }
}

#[tokio::test]
async fn signed_service_auto_updates_after_idle_then_reviews_hotfix_without_losing_login() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use remote::tests::{signed, TestServer};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::io::Write;
    let server = TestServer::start().await;
    let root = tempfile::tempdir().unwrap();
    let pair = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
    let source = remote::TrustedSource {
        id: "test-source".into(),
        plugin_id: "dev.example.host-probe".into(),
        name: "Test publisher".into(),
        repository: "https://example.com/test".into(),
        feed_url: "https://example.com/feed".into(),
        key_id: "test-key".into(),
        public_key: STANDARD.encode(pair.public_key()),
        download_origins: vec!["https://example.com".into()],
    };
    let mut host_value = ExtensionHost::open(root.path().join("plugins")).unwrap();
    host_value.updates.sources = vec![source.clone()];
    host_value.updates.http = server.http.clone();
    let host = Arc::new(host_value);
    host.set_developer_mode(true).unwrap();
    host.attach_provider_runtime(
        provider_registry(root.path()),
        Arc::new(MemoryCredentialStore::default()),
        root.path().join("cache/components"),
        tokio::runtime::Handle::current(),
    )
    .unwrap();
    let mut inspection = account_component_inspection();
    let path = root.path().join("old");
    extract_to(&inspection, &path).unwrap();
    assert_eq!(
        apply(&host, prepared(&host, &path).await).await.phase,
        "completed"
    );
    let services = host
        .provider_runtime
        .lock()
        .unwrap()
        .host_services
        .clone()
        .unwrap();
    let ctx = services.for_plugin(
        &source.plugin_id,
        "provider.host-probe",
        HashSet::from(["https://api.example.com".into()]),
    );
    let handle = ctx
        .credential_create("https://api.example.com", "synthetic-sign-in-secret")
        .unwrap();
    ctx.kv_set("session", &handle).unwrap();
    let policy = PolicyRequest {
        plugin_id: source.plugin_id.clone(),
        source_id: Some(source.id.clone()),
        automatic: true,
        channel: ReleaseChannel::Stable,
        confirm_source: false,
    };
    assert!(host.set_update_policy(policy.clone()).is_err());
    host.set_update_policy(PolicyRequest {
        confirm_source: true,
        ..policy
    })
    .unwrap();

    for sequence in [1u64, 2, 3] {
        inspection.manifest.version = "1.1.0".into();
        inspection.manifest.description = Some(format!("build-{sequence}"));
        inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for file in &inspection.files {
            zip.start_file(&file.path, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&file.bytes).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let record = remote::ReleaseRecord {
            plugin_id: source.plugin_id.clone(),
            version: "1.1.0".into(),
            release: ReleaseInfo {
                channel: ReleaseChannel::Stable,
                build_id: format!("build-{sequence}"),
                release_sequence: sequence,
            },
            sha256: sha256_bytes(&bytes),
            size: bytes.len() as u64,
            url: "https://example.com/package".into(),
        };
        let release = signed(&record, b"YAQMC-PLUGIN-RELEASE-v1\0");
        let feed = remote::Feed {
            schema_version: 1,
            plugin_id: source.plugin_id.clone(),
            sequence,
            expires_at_ms: now_ms() + 600_000,
            releases: vec![release],
        };
        server.put(
            "/feed",
            serde_json::to_vec(&signed(&feed, b"YAQMC-PLUGIN-FEED-v1\0")).unwrap(),
        );
        server.put("/package", bytes);
        if sequence == 1 {
            *host.updates.fault.lock().unwrap() = Some("validated".into());
        }
        let check = host.check_updates(Some(source.plugin_id.clone())).unwrap();
        assert_eq!(
            wait(&host, &check.operation_id, true).await.phase,
            "completed"
        );
        if sequence <= 2 {
            let operation_id = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Some(op) = host
                        .update_status(None)
                        .unwrap()
                        .iter()
                        .find(|op| op.phase == "waiting-idle")
                    {
                        break op.operation_id.clone();
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(host.record(&source.plugin_id).unwrap().version, "1.0.0");
            if sequence == 2 {
                // A call can start and finish entirely between 500 ms idle
                // samples. Its completion still restarts the full idle window.
                host.updates
                    .operations
                    .lock()
                    .unwrap()
                    .get_mut(&operation_id)
                    .unwrap()
                    .idle_since = Some(Instant::now() - Duration::from_secs(31));
                let token = host.start_runtime(&source.plugin_id).unwrap();
                drop(host.begin_bridge_call(&token.token).unwrap());
                tokio::time::sleep(Duration::from_millis(650)).await;
                assert_eq!(
                    host.update_status(Some(&operation_id)).unwrap()[0].phase,
                    "waiting-idle"
                );
                host.stop_runtime(&token.token);
            }
            // Exercise the production 30-second idle interval, including real
            // signed HTTP delivery, Wasm instantiation and credential restore.
            let result = tokio::time::timeout(Duration::from_secs(40), async {
                loop {
                    let op = host.update_status(Some(&operation_id)).unwrap().remove(0);
                    if op.terminal() {
                        break op;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .unwrap();
            if sequence == 1 {
                assert_eq!(result.error.as_deref(), Some("injected-validated"));
                let release_id = host
                    .updates
                    .releases
                    .lock()
                    .unwrap()
                    .values()
                    .next()
                    .unwrap()
                    .release_id
                    .clone();
                let policy = host.update_policy(&source.plugin_id);
                assert_eq!(
                    policy.failed_release_id.as_deref(),
                    Some(release_id.as_str())
                );
                assert!(host.updates.operations.lock().unwrap()[&operation_id]
                    .prepared
                    .is_none());
                let persisted: BTreeMap<String, UpdatePolicy> =
                    read_json(&host.root.join("update-policies.json")).unwrap();
                assert_eq!(
                    persisted[&source.plugin_id].failed_release_id,
                    policy.failed_release_id
                );
                let operation_count = host
                    .update_status(None)
                    .unwrap()
                    .iter()
                    .filter(|o| o.preview.is_some())
                    .count();
                let repeat = host.check_updates(Some(source.plugin_id.clone())).unwrap();
                assert_eq!(
                    wait(&host, &repeat.operation_id, true).await.phase,
                    "completed"
                );
                assert_eq!(
                    host.update_status(None)
                        .unwrap()
                        .iter()
                        .filter(|o| o.preview.is_some())
                        .count(),
                    operation_count,
                    "a failed release must not be automatically prepared again"
                );
                continue;
            }
            assert_eq!(result.phase, "completed", "{:?}", result.error);
        } else {
            let available = host
                .updates
                .releases
                .lock()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .release_id
                .clone();
            let op = host
                .prepare_update(PrepareRequest {
                    github: None,
                    plugin_id: Some(source.plugin_id.clone()),
                    path: None,
                    release_id: Some(available),
                    unpacked: false,
                })
                .unwrap();
            let op = wait(&host, &op.operation_id, false).await;
            assert!(op
                .preview
                .as_ref()
                .unwrap()
                .confirmations
                .contains(&"replacement".into()));
            assert!(host
                .apply_update(ApplyRequest {
                    operation_id: op.operation_id.clone(),
                    automatic: true,
                    confirm: true,
                    ..Default::default()
                })
                .is_err());
            assert_eq!(apply(&host, op).await.phase, "completed");
        }
        let current = services.for_plugin(
            &source.plugin_id,
            "provider.host-probe",
            HashSet::from(["https://api.example.com".into()]),
        );
        assert_eq!(
            current.kv_get("session").unwrap().as_deref(),
            Some(handle.as_str())
        );
        assert_eq!(
            current
                .credential_resolve(&handle, "https://api.example.com")
                .unwrap(),
            "synthetic-sign-in-secret"
        );
        assert!(host.update_policy(&source.plugin_id).automatic);
    }
}

fn store_package(id: &str, version: &str, style: &str) -> Vec<u8> {
    use std::io::Write as _;
    let mut inspection = style_inspection(id);
    inspection.manifest.version = version.into();
    inspection.files[0].bytes = serde_json::to_vec(&inspection.manifest).unwrap();
    inspection.files[1].bytes = style.as_bytes().to_vec();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for file in &inspection.files {
        zip.start_file(&file.path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&file.bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn serve_store_release(
    server: &remote::tests::TestServer,
    owner: &str,
    release_id: u64,
    asset_id: u64,
    bytes: &[u8],
    digest: &str,
) {
    let json = |value: serde_json::Value| (200, vec![], serde_json::to_vec(&value).unwrap());
    let mut routes = server.routes.lock().unwrap();
    routes.insert(
        format!("/repos/{owner}/plugin"),
        json(serde_json::json!({"id": 1, "name": "plugin", "owner": {"login": owner, "type": "User"}, "topics": ["yaqmc-plugin"]})),
    );
    routes.insert(
        format!("/repos/{owner}/plugin/releases/{release_id}"),
        json(serde_json::json!({"id": release_id, "tag_name": "v1", "draft": false, "prerelease": false,
            "assets": [{"id": asset_id, "name": "demo.yaqmc-plugin", "size": bytes.len(), "state": "uploaded",
                        "digest": format!("sha256:{digest}")}]})),
    );
    // GitHub answers the API asset URL with a CDN redirect; both hops are origin-checked.
    routes.insert(
        format!("/repos/{owner}/plugin/releases/assets/{asset_id}"),
        (
            302,
            vec![format!(
                "Location: https://release-assets.githubusercontent.com/cdn/{asset_id}"
            )],
            vec![],
        ),
    );
    routes.insert(format!("/cdn/{asset_id}"), (200, vec![], bytes.to_vec()));
}

#[tokio::test]
async fn store_assets_install_through_review_and_source_changes_need_confirmation() {
    let root = tempfile::tempdir().unwrap();
    let server = remote::tests::TestServer::start().await;
    let mut value = ExtensionHost::open(root.path().join("plugins")).unwrap();
    value.updates.http = server.http.clone();
    let host = Arc::new(value);
    let id = "dev.example.store";
    let first = store_package(id, "1.0.0", "body { color: red; }");
    serve_store_release(&server, "alice", 7, 70, &first, &sha256_bytes(&first));
    let reference = |owner: &str, release_id, asset_id| crate::plugin::store::StoreAssetRef {
        owner: owner.into(),
        repo: "plugin".into(),
        release_id,
        asset_id,
    };
    let request = |github| PrepareRequest {
        github: Some(github),
        path: None,
        plugin_id: None,
        release_id: None,
        unpacked: false,
    };
    // Mixed sources and unpacked store installs are rejected before any request.
    assert!(host
        .prepare_update(PrepareRequest {
            path: Some("x".into()),
            ..request(reference("alice", 7, 70))
        })
        .is_err());
    let op = host
        .prepare_update(request(reference("alice", 7, 70)))
        .unwrap();
    // A second click joins the running operation instead of downloading again.
    let again = host
        .prepare_update(request(reference("alice", 7, 70)))
        .unwrap();
    assert_eq!(again.operation_id, op.operation_id);
    let op = wait(&host, &op.operation_id, false).await;
    let preview = op.preview.clone().expect("reviewed preview");
    assert_eq!(
        preview.sha256,
        sha256_bytes(&first),
        "review binds the downloaded bytes"
    );
    assert_eq!(
        preview.origin.as_deref(),
        Some("github:alice/plugin/releases/7")
    );
    assert!(preview.trusted_source.is_none());
    assert!(preview
        .confirmations
        .contains(&"unverified-source".to_owned()));
    // Unconfirmed apply is refused; confirmed apply installs and records the store source.
    assert!(host
        .apply_update(ApplyRequest {
            operation_id: op.operation_id.clone(),
            ..Default::default()
        })
        .is_err());
    assert_eq!(apply(&host, op).await.phase, "completed");
    assert_eq!(
        host.record(id).unwrap().source,
        "github:alice/plugin/releases/7"
    );

    // The same plugin id from another repository needs an explicit source-change review.
    let second = store_package(id, "1.1.0", "body { color: blue; }");
    serve_store_release(&server, "mallory", 8, 80, &second, &sha256_bytes(&second));
    let op = host
        .prepare_update(request(reference("mallory", 8, 80)))
        .unwrap();
    let op = wait(&host, &op.operation_id, false).await;
    assert!(op
        .preview
        .as_ref()
        .unwrap()
        .confirmations
        .contains(&"source-change".to_owned()));
    host.cancel_update(&op.operation_id).unwrap();
    assert_eq!(host.record(id).unwrap().version, "1.0.0");

    // A GitHub digest that does not match the bytes fails without leaving a staged package.
    serve_store_release(&server, "eve", 9, 90, &second, &"0".repeat(64));
    let op = host
        .prepare_update(request(reference("eve", 9, 90)))
        .unwrap();
    let failed = wait(&host, &op.operation_id, false).await;
    assert_eq!(failed.phase, "failed");
    assert_eq!(failed.error.as_deref(), Some("store-asset-digest-mismatch"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!root
        .path()
        .join("plugins/.updates")
        .join(&op.operation_id)
        .exists());
}
