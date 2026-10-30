use super::*;
use crate::plugin::updates::{self as api, remote, storage, *};
use std::{
    collections::BTreeSet,
    sync::Weak,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;

pub(super) use api::atomic_bytes;

pub(super) struct UpdateState {
    operations: Mutex<BTreeMap<String, Operation>>,
    policies: Mutex<BTreeMap<String, UpdatePolicy>>,
    releases: Mutex<BTreeMap<String, remote::AvailableRelease>>,
    sources: Vec<remote::TrustedSource>,
    http: remote::UpdateHttp,
    lifecycle: Arc<Mutex<HashSet<String>>>,
    serial: tokio::sync::Mutex<()>,
    downloads: Semaphore,
    staged: Mutex<HashMap<String, ComponentHostServices>>,
    compiled: Mutex<HashMap<String, crate::plugin::component::CompiledComponent>>,
    events: broadcast::Sender<UpdateOperation>,
    context: Mutex<Option<Weak<crate::CoreHandle>>>,
    editing: Mutex<HashMap<String, Instant>>,
    shutdown: CancellationToken,
    bridge_calls: Mutex<HashMap<String, Arc<BridgeActivity>>>,
    recovery_required: Mutex<HashSet<String>>,
    policy_corrupt: bool,
    app_restart: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    fault: Mutex<Option<String>>,
}

#[derive(Clone)]
struct Prepared {
    manifest: PluginManifest,
    expected: String,
    expected_policy: String,
    content_sha256: String,
    directory: PathBuf,
    style_scan: crate::plugin::scanner::ScanReport,
    script_scan: crate::plugin::scanner::ScanReport,
    release: Option<ReleaseInfo>,
    release_id: Option<String>,
    expires_at_ms: Option<u64>,
    compiled: Option<crate::plugin::component::CompiledComponent>,
    unpacked_path: Option<String>,
}

struct Operation {
    status: UpdateOperation,
    prepared: Option<Prepared>,
    release_id: Option<String>,
    cancel: CancellationToken,
    accepted: Option<ApplyRequest>,
    renderer_ack: Option<Result<(), String>>,
    idle_since: Option<Instant>,
}

pub(super) struct MutationGuard {
    id: String,
    locked: Arc<Mutex<HashSet<String>>>,
}
pub(crate) struct BridgeActivity {
    cancel: CancellationToken,
    count: std::sync::atomic::AtomicUsize,
    last_activity: Mutex<Instant>,
}
pub(crate) struct BridgeCall(pub(crate) Arc<BridgeActivity>);
impl BridgeCall {
    pub(crate) async fn cancelled(&self) {
        self.0.cancel.cancelled().await;
    }
}
impl Drop for BridgeCall {
    fn drop(&mut self) {
        *self
            .0
            .last_activity
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Instant::now();
        self.0.count.fetch_sub(1, Ordering::AcqRel);
    }
}
impl Drop for MutationGuard {
    fn drop(&mut self) {
        self.locked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Transaction {
    plugin_id: String,
    previous: Option<PluginStateFile>,
    candidate: PluginStateFile,
    committed: bool,
    #[serde(default)]
    rolled_back: bool,
    #[serde(default)]
    boot_id: String,
    #[serde(default)]
    runtime_restored: bool,
    #[serde(default)]
    release_id: Option<String>,
    #[serde(default)]
    policy_recorded: bool,
}

impl UpdateState {
    pub(super) fn open(root: &Path) -> Self {
        let (events, _) = broadcast::channel(64);
        let policies = read_json(&root.join("update-policies.json"));
        let policy_corrupt = root.join("update-policies.json").exists() && policies.is_none();
        let recovery_required = fs::read_dir(root.join(".updates"))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|e| read_json::<Transaction>(&e.path().join("transaction.json")))
            .map(|t| t.plugin_id)
            .collect();
        Self {
            operations: Mutex::new(BTreeMap::new()),
            policies: Mutex::new(policies.unwrap_or_default()),
            releases: Mutex::new(BTreeMap::new()),
            sources: remote::builtin_sources(),
            http: remote::UpdateHttp::default(),
            lifecycle: Arc::new(Mutex::new(HashSet::new())),
            serial: tokio::sync::Mutex::new(()),
            downloads: Semaphore::new(2),
            staged: Mutex::new(HashMap::new()),
            events,
            compiled: Mutex::new(HashMap::new()),
            context: Mutex::new(None),
            editing: Mutex::new(HashMap::new()),
            shutdown: CancellationToken::new(),
            bridge_calls: Mutex::new(HashMap::new()),
            recovery_required: Mutex::new(recovery_required),
            policy_corrupt,
            app_restart: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            fault: Mutex::new(None),
        }
    }
}

pub(super) fn package_path(root: &Path, state: &PluginStateFile) -> Result<PathBuf, HostError> {
    if !is_plugin_id(&state.id) {
        return Err(HostError::from("update-id-invalid"));
    }
    if let Some(hash) = &state.active_package {
        if !valid_sha256(hash) {
            return Err(HostError::from("update-hash-invalid"));
        }
        Ok(root.join(&state.id).join("packages").join(hash))
    } else {
        if !crate::plugin::manifest::is_safe_package_path(&state.active_version)
            || state.active_version.contains(['/', '\\'])
        {
            return Err(HostError::from("update-version-path-invalid"));
        }
        Ok(root
            .join(&state.id)
            .join("versions")
            .join(&state.active_version))
    }
}

pub(super) fn recover(root: &Path) -> Result<bool, HostError> {
    let directory = root.join(".updates");
    if !directory.exists() {
        return Ok(false);
    }
    let mut recovered = false;
    let boot = read_json::<JournalFile>(&root.join("journal.json"))
        .unwrap_or_default()
        .boot_id;
    for entry in
        fs::read_dir(directory).map_err(|_| HostError::from("update-recovery-unreadable"))?
    {
        let entry = entry.map_err(|_| HostError::from("update-recovery-unreadable"))?;
        let path = entry.path();
        if !path.join("transaction.json").exists() {
            continue;
        }
        let tx = read_json::<Transaction>(&path.join("transaction.json"))
            .ok_or_else(|| HostError::from("update-journal-invalid"))?;
        recover_one(root, &path)?;
        recover_update_policy(root, &path)?;
        recovered |= !boot.is_empty() && tx.boot_id == boot && !tx.runtime_restored;
        if !path.join("data-journal.json").exists() && !path.join("credentials.json").exists() {
            fs::remove_dir_all(&path).map_err(|_| HostError::from("update-cleanup-failed"))?;
        }
    }
    Ok(recovered)
}

fn recover_one(root: &Path, path: &Path) -> Result<(), HostError> {
    let mut tx: Transaction = read_json(&path.join("transaction.json"))
        .ok_or_else(|| HostError::from("update-journal-invalid"))?;
    if !is_plugin_id(&tx.plugin_id)
        || tx.candidate.id != tx.plugin_id
        || tx.previous.as_ref().is_some_and(|s| s.id != tx.plugin_id)
    {
        return Err(HostError::from("update-journal-invalid"));
    }
    package_path(root, &tx.candidate)?;
    if let Some(previous) = &tx.previous {
        package_path(root, previous)?;
    }
    let current = read_json::<PluginStateFile>(&root.join(&tx.plugin_id).join("state.json"));
    if current
        .as_ref()
        .is_some_and(|state| state.generation > tx.candidate.generation)
    {
        return Err(HostError::from("update-journal-generation-conflict"));
    }
    if !tx.committed && !tx.rolled_back {
        // Component roots are checked and recovered once the credential/cache
        // backend is attached, before any provider context can be created.
        if let Some(state) = &tx.previous {
            write_json(&root.join(&tx.plugin_id).join("state.json"), state)?;
        } else {
            let _ = fs::remove_file(root.join(&tx.plugin_id).join("state.json"));
            let mut host = read_json::<HostFile>(&root.join("host.json")).unwrap_or_default();
            host.style_order.retain(|id| id != &tx.plugin_id);
            write_json(&root.join("host.json"), &host)?;
        }
        if path.join("local-backup-ready").exists() {
            for suffix in ["storage.json", "settings.json"] {
                let backup = path.join(format!("previous.{suffix}"));
                let target = root.join(format!("{}.{suffix}", tx.plugin_id));
                if backup.exists() {
                    atomic_bytes(
                        &target,
                        &fs::read(backup)
                            .map_err(|_| HostError::from("update-recovery-unreadable"))?,
                    )
                    .map_err(HostError::from)?;
                } else if target.exists() {
                    fs::remove_file(target)
                        .map_err(|_| HostError::from("update-recovery-write-failed"))?;
                }
            }
        }
        tx.rolled_back = true;
        api::atomic_json(&path.join("transaction.json"), &tx).map_err(HostError::from)?;
    }
    // Credential cleanup runs after the original credential backend is attached.
    Ok(())
}

fn set_result_policy(
    policy: &mut UpdatePolicy,
    sha256: &str,
    release_id: Option<&str>,
    local: bool,
    error: Option<&str>,
) {
    policy.last_result = Some(error.unwrap_or("updated").to_owned());
    policy.failed_sha256 = error.map(|_| sha256.to_owned());
    policy.failed_release_id = error.and(release_id).map(str::to_owned);
    if error.is_none() && local {
        policy.automatic = false;
        policy.bound = false;
    }
}

// Replay the policy outcome before deleting a recovered transaction. In particular,
// a committed local replacement must revoke automatic trust even if its final
// policy write failed or the process exited immediately after committing.
fn recover_update_policy(root: &Path, path: &Path) -> Result<(), HostError> {
    let journal = path.join("transaction.json");
    let mut tx: Transaction =
        read_json(&journal).ok_or_else(|| HostError::from("update-journal-invalid"))?;
    if tx.policy_recorded {
        return Ok(());
    }
    let policy_path = root.join("update-policies.json");
    let policies: Option<BTreeMap<String, UpdatePolicy>> = read_json(&policy_path);
    // A corrupt policy file already disables all remote updates. Preserve its
    // replay protection data for repair instead of replacing it with defaults.
    if !policy_path.exists() || policies.is_some() {
        let mut policies = policies.unwrap_or_default();
        set_result_policy(
            policies.entry(tx.plugin_id.clone()).or_default(),
            &tx.candidate.package_sha256,
            tx.release_id.as_deref(),
            !tx.candidate.source.starts_with("trusted:"),
            (!tx.committed).then_some("update-interrupted"),
        );
        write_json(&policy_path, &policies)?;
    }
    tx.policy_recorded = true;
    api::atomic_json(&journal, &tx).map_err(HostError::from)
}

impl ExtensionHost {
    pub async fn prepare_app_restart(&self) -> Result<(), String> {
        self.updates.app_restart.store(true, Ordering::Release);
        let drain = tokio::time::timeout(Duration::from_secs(60), async {
            let _serial = self.updates.serial.lock().await;
            loop {
                if self
                    .updates
                    .lifecycle
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            if !self
                .updates
                .recovery_required
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_empty()
            {
                return Err("update-recovery-required".to_owned());
            }
            Ok(())
        })
        .await;
        match drain {
            Ok(Ok(())) => Ok(()),
            other => {
                self.cancel_app_restart();
                other.unwrap_or_else(|_| Err("update-plugin-drain-timeout".into()))
            }
        }
    }

    pub fn cancel_app_restart(&self) {
        self.updates.app_restart.store(false, Ordering::Release);
    }

    pub(crate) fn begin_bridge_call(&self, token: &str) -> Result<BridgeCall, String> {
        let mut calls = self
            .updates
            .bridge_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let runtime = self.runtime(token).ok_or("unknown plugin runtime")?;
        if self
            .update_phase(&runtime.plugin_id)
            .as_deref()
            .is_some_and(|s| matches!(s, "quiescing" | "committing" | "rolling-back" | "restoring"))
        {
            return Err("update-validation-in-progress".into());
        }
        let activity = calls
            .entry(runtime.plugin_id)
            .or_insert_with(|| {
                Arc::new(BridgeActivity {
                    cancel: CancellationToken::new(),
                    count: std::sync::atomic::AtomicUsize::new(0),
                    last_activity: Mutex::new(Instant::now()),
                })
            })
            .clone();
        activity.count.fetch_add(1, Ordering::AcqRel);
        Ok(BridgeCall(activity))
    }

    pub(crate) fn update_phase(&self, id: &str) -> Option<String> {
        self.updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .find(|o| {
                o.status.plugin_id.as_deref() == Some(id)
                    && matches!(
                        o.status.phase.as_str(),
                        "quiescing"
                            | "applying"
                            | "validating"
                            | "committing"
                            | "rolling-back"
                            | "restoring"
                    )
            })
            .map(|o| o.status.phase.clone())
    }

    fn fault_point(&self, phase: &str) -> Result<(), String> {
        #[cfg(test)]
        {
            let mut fault = self.updates.fault.lock().unwrap_or_else(|p| p.into_inner());
            if fault.as_deref() == Some(phase) {
                *fault = None;
                return Err(format!("injected-{phase}"));
            }
            if std::env::var("YAQMC_TEST_UPDATE_CRASH").ok().as_deref() == Some(phase) {
                std::process::exit(91);
            }
        }
        let _ = phase;
        Ok(())
    }
    pub fn apply_update(
        self: &Arc<Self>,
        request: ApplyRequest,
    ) -> Result<UpdateOperation, HostError> {
        if self.updates.app_restart.load(Ordering::Acquire) {
            return Err(HostError::from("application-update-in-progress"));
        }
        let mut ops = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let op = ops
            .get_mut(&request.operation_id)
            .ok_or_else(|| HostError::from("update-operation-missing"))?;
        if op.status.phase == "unchanged" {
            return Ok(op.status.clone());
        }
        if op.status.phase == "waiting-idle" && request.stop_using && !request.automatic {
            if let Some(accepted) = op.accepted.as_mut() {
                if accepted.confirm == request.confirm && accepted.grant == request.grant {
                    accepted.stop_using = true;
                    accepted.automatic = false;
                    return Ok(op.status.clone());
                }
            }
        }
        if !matches!(op.status.phase.as_str(), "prepared" | "waiting-idle") || op.accepted.is_some()
        {
            return Err(HostError::from("update-not-prepared"));
        }
        let preview = op
            .status
            .preview
            .as_ref()
            .ok_or_else(|| HostError::from("update-not-prepared"))?;
        if !preview.confirmations.is_empty() && !request.confirm {
            return Err(HostError::from("update-confirmation-required"));
        }
        if request.automatic
            && (preview.trusted_source.is_none() || !preview.confirmations.is_empty())
        {
            return Err(HostError::from("update-manual-review-required"));
        }
        if preview
            .added_permissions
            .iter()
            .any(|p| !request.grant.contains(p))
        {
            return Err(HostError::from(
                "new permissions must be explicitly accepted",
            ));
        }
        op.accepted = Some(request.clone());
        op.status.phase = "waiting-idle".into();
        let status = op.status.clone();
        let _ = self.updates.events.send(status.clone());
        drop(ops);
        let host = self.clone();
        tokio::spawn(async move {
            let result = loop {
                let result = host.apply_task(&request).await;
                if result.as_ref().err().map(String::as_str) != Some("update-plugin-became-busy") {
                    break result;
                }
                if let Some(op) = host
                    .updates
                    .operations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get_mut(&request.operation_id)
                {
                    op.idle_since = None;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            };
            if let Err(error) = result {
                let cancelled = host
                    .updates
                    .operations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&request.operation_id)
                    .is_some_and(|o| o.cancel.is_cancelled());
                let cleanup = host.clone();
                let id = request.operation_id.clone();
                let recorded_error = error.clone();
                let recorded = tokio::task::spawn_blocking(move || {
                    cleanup.record_update_result(&id, Some(&recorded_error))?;
                    let journal = cleanup
                        .root
                        .join(".updates")
                        .join(&id)
                        .join("transaction.json");
                    if let Some(tx) = read_json::<Transaction>(&journal) {
                        if tx.rolled_back && tx.runtime_restored {
                            cleanup
                                .updates
                                .recovery_required
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .remove(&tx.plugin_id);
                        }
                    }
                    cleanup.cleanup_update(&id);
                    Ok::<_, HostError>(())
                })
                .await;
                let error = if matches!(recorded, Ok(Ok(()))) {
                    error
                } else {
                    format!("{error}; update-policy-recovery-required")
                };
                host.emit_update(
                    &request.operation_id,
                    if cancelled { "cancelled" } else { "failed" },
                    Some(error.clone()),
                );
            }
        });
        Ok(status)
    }

    fn core_context(&self) -> Option<Arc<crate::CoreHandle>> {
        self.updates
            .context
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .and_then(Weak::upgrade)
    }

    pub fn update_info(&self, id: &str) -> serde_json::Value {
        let available = self
            .updates
            .releases
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .filter(|r| r.record.plugin_id == id)
            .cloned()
            .collect::<Vec<_>>();
        serde_json::json!({ "policy": self.update_policy(id), "sources": self.updates.sources.iter().filter(|s| s.plugin_id == id).collect::<Vec<_>>(), "available": available })
    }

    pub fn start_update_service(self: &Arc<Self>, core: Weak<crate::CoreHandle>) {
        *self
            .updates
            .context
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(core);
        let weak = Arc::downgrade(self);
        let stop = self.updates.shutdown.clone();
        tokio::spawn(async move {
            tokio::select! { _ = stop.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(30)) => {} }
            loop {
                let Some(host) = weak.upgrade() else {
                    return;
                };
                let ids = host
                    .updates
                    .policies
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .iter()
                    .filter(|(_, p)| {
                        p.bound
                            && now_ms() >= p.retry_after_ms
                            && (p.failures > 0
                                || now_ms().saturating_sub(p.last_check_ms) >= 86_400_000)
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                if !ids.is_empty() {
                    let _ = host.check_updates_internal(None, true);
                }
                drop(host);
                tokio::select! { _ = stop.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(60)) => {} }
            }
        });
    }

    pub fn stop_update_service(&self) {
        self.updates.shutdown.cancel();
    }
    pub fn update_shutdown(&self) -> CancellationToken {
        self.updates.shutdown.clone()
    }

    pub fn check_updates(
        self: &Arc<Self>,
        plugin_id: Option<String>,
    ) -> Result<UpdateOperation, HostError> {
        self.check_updates_internal(plugin_id, false)
    }

    fn check_updates_internal(
        self: &Arc<Self>,
        plugin_id: Option<String>,
        scheduled: bool,
    ) -> Result<UpdateOperation, HostError> {
        if self.updates.app_restart.load(Ordering::Acquire) {
            return Err(HostError::from("application-update-in-progress"));
        }
        if self.updates.policy_corrupt {
            return Err(HostError::from("update-policy-recovery-required"));
        }
        let id = format!("{:032x}", rand::random::<u128>());
        let cancel = CancellationToken::new();
        let status = UpdateOperation {
            operation_id: id.clone(),
            plugin_id: plugin_id.clone(),
            phase: "checking".into(),
            preview: None,
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            runtime_changed: false,
        };
        let mut ops = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if ops.values().any(|o| o.status.phase == "checking") {
            return Err(HostError::from("update-check-in-progress"));
        }
        if ops.len() >= 64 {
            ops.retain(|_, o| !o.status.terminal());
        }
        ops.insert(
            id.clone(),
            Operation {
                status: status.clone(),
                prepared: None,
                release_id: None,
                cancel: cancel.clone(),
                accepted: None,
                renderer_ack: None,
                idle_since: None,
            },
        );
        drop(ops);
        let host = self.clone();
        tokio::spawn(async move {
            let sources = host
                .updates
                .sources
                .iter()
                .filter(|s| {
                    let p = host.update_policy(&s.plugin_id);
                    plugin_id.as_ref().is_none_or(|id| id == &s.plugin_id)
                        && p.bound
                        && p.source_id.as_ref() == Some(&s.id)
                        && (!scheduled
                            || (now_ms() >= p.retry_after_ms
                                && (p.failures > 0
                                    || now_ms().saturating_sub(p.last_check_ms) >= 86_400_000)))
                })
                .cloned()
                .collect::<Vec<_>>();
            let mut error = None;
            for source in sources {
                match host.check_source(&source, &cancel).await {
                    Ok(releases) => {
                        let policy = host.update_policy(&source.plugin_id);
                        if policy.automatic {
                            if let Some(release) = remote::select_release(&releases, policy.channel)
                            {
                                if host.record(&source.plugin_id).is_ok_and(|current| {
                                    current.package_sha256 != release.record.sha256
                                        && version_change(&current.version, &release.record.version)
                                            == "upgrade"
                                }) && policy.failed_release_id.as_deref()
                                    != Some(&release.release_id)
                                {
                                    let existing = host
                                        .updates
                                        .operations
                                        .lock()
                                        .unwrap_or_else(|p| p.into_inner())
                                        .values()
                                        .any(|o| {
                                            o.status.preview.is_some()
                                                && o.status.plugin_id.as_deref()
                                                    == Some(&source.plugin_id)
                                                && !o.status.terminal()
                                        });
                                    if !existing {
                                        if let Ok(operation) = host.prepare_update(PrepareRequest {
                                            plugin_id: Some(source.plugin_id.clone()),
                                            path: None,
                                            release_id: Some(release.release_id.clone()),
                                            unpacked: false,
                                        }) {
                                            let automatic_host = host.clone();
                                            tokio::spawn(async move {
                                                loop {
                                                    let status = automatic_host
                                                        .update_status(Some(
                                                            &operation.operation_id,
                                                        ))
                                                        .ok()
                                                        .and_then(|v| v.into_iter().next());
                                                    match status {
                                                        Some(status)
                                                            if status.phase == "prepared" =>
                                                        {
                                                            if status.preview.as_ref().is_some_and(
                                                                |p| p.confirmations.is_empty(),
                                                            ) {
                                                                let _ = automatic_host
                                                                    .apply_update(ApplyRequest {
                                                                        operation_id: status
                                                                            .operation_id,
                                                                        automatic: true,
                                                                        ..Default::default()
                                                                    });
                                                            }
                                                            break;
                                                        }
                                                        Some(status) if !status.terminal() => {
                                                            tokio::time::sleep(
                                                                Duration::from_millis(100),
                                                            )
                                                            .await
                                                        }
                                                        _ => break,
                                                    }
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(reason) => {
                        error = Some(reason);
                    }
                }
            }
            host.emit_update(
                &id,
                if cancel.is_cancelled() {
                    "cancelled"
                } else if error.is_some() {
                    "failed"
                } else {
                    "completed"
                },
                error,
            );
        });
        Ok(status)
    }

    async fn check_source(
        &self,
        source: &remote::TrustedSource,
        cancel: &CancellationToken,
    ) -> Result<Vec<remote::AvailableRelease>, String> {
        let result = self.updates.http.fetch_feed(source, cancel).await;
        let mut policies = self
            .updates
            .policies
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut next = policies.clone();
        let policy = next.entry(source.plugin_id.clone()).or_default();
        if !policy.bound
            || policy.source_id.as_deref() != Some(&source.id)
            || policy.trust_digest != source_digest(source)
        {
            return Err("update-source-confirmation-required".into());
        }
        let verified =
            result.and_then(|bytes| remote::verify_feed(&bytes, source, policy, now_ms()));
        match &verified {
            Ok(releases) => {
                policy.last_check_ms = now_ms();
                policy.retry_after_ms = 0;
                policy.failures = 0;
                policy.last_result = Some("checked".into());
                let _ = releases;
            }
            Err(reason) => {
                policy.failures = policy.failures.saturating_add(1);
                policy.last_result = Some(reason.clone());
                policy.retry_after_ms =
                    now_ms().saturating_add((60_000u64 << policy.failures.min(6)).min(3_600_000));
            }
        }
        write_json(&self.root.join("update-policies.json"), &next).map_err(|e| e.to_string())?;
        *policies = next;
        if let Ok(releases) = &verified {
            let mut cached = self
                .updates
                .releases
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            cached.retain(|_, r| r.source_id != source.id);
            for release in releases {
                cached.insert(release.release_id.clone(), release.clone());
            }
        }
        verified
    }

    async fn busy_reason(&self, id: &str) -> Option<&'static str> {
        self.busy_reason_with_admission(id, false).await
    }

    fn last_update_activity(&self, id: &str) -> Option<Instant> {
        let provider = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .active
            .values()
            .filter(|a| a.plugin_id == id)
            .filter_map(|a| a.adapter.update_last_activity())
            .max();
        let bridge = self
            .updates
            .bridge_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .map(|a| *a.last_activity.lock().unwrap_or_else(|p| p.into_inner()));
        provider.into_iter().chain(bridge).max()
    }

    async fn busy_reason_with_admission(&self, id: &str, admitted: bool) -> Option<&'static str> {
        if self
            .updates
            .bridge_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .is_some_and(|a| a.count.load(Ordering::Acquire) > 0)
        {
            return Some("calls");
        }
        if self
            .updates
            .editing
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .is_some_and(|t| t.elapsed() < Duration::from_secs(45))
        {
            return Some("settings");
        }
        {
            let runtime = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let adapters = runtime
                .active
                .values()
                .filter(|a| a.plugin_id == id)
                .map(|a| a.adapter.clone())
                .collect::<Vec<_>>();
            if adapters.iter().any(|a| {
                if admitted {
                    a.update_session_busy()
                } else {
                    a.update_busy()
                }
            }) {
                return Some("provider");
            }
        }
        if self.playback_uses_plugin(id).await {
            return Some("playback");
        }
        if let Some(core) = self.core_context() {
            let continuation = core.continuation().snapshot().await;
            if continuation.active
                && continuation.request_state != crate::continuation::ContinuationRequestState::Idle
            {
                let owns = self
                    .inner
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .records
                    .get(id)
                    .is_some_and(|(_, m, _)| {
                        m.provider_declarations()
                            .iter()
                            .any(|p| Some(&p.id) == continuation.provider_id.as_ref())
                            || m.federations
                                .iter()
                                .any(|f| Some(&f.id) == continuation.provider_id.as_ref())
                    });
                if owns {
                    return Some("preloading");
                }
            }
        }
        None
    }

    async fn playback_uses_plugin(&self, id: &str) -> bool {
        let providers = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .records
            .get(id)
            .map(|(_, m, _)| {
                m.provider_declarations()
                    .iter()
                    .map(|p| p.id.clone())
                    .chain(m.federations.iter().map(|f| f.id.clone()))
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        if let Some(core) = self.core_context() {
            let snapshot = core.player().snapshot().await;
            // Stop clears the audio source but intentionally retains the selected track.
            if !matches!(
                snapshot.playback_state,
                crate::player::PlaybackState::Stopped | crate::player::PlaybackState::Idle
            ) {
                if let Some(track) = core.player().current_track().await {
                    if crate::plugin::federation::song_uses_providers(&track, &providers) {
                        return true;
                    }
                }
            }
        }
        false
    }

    async fn apply_task(self: &Arc<Self>, request: &ApplyRequest) -> Result<(), String> {
        let mut request = request.clone();
        let operation_id = request.operation_id.clone();
        let id = &operation_id;
        let (prepared, preview, cancel) = {
            let ops = self
                .updates
                .operations
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let op = ops.get(id).ok_or("update-operation-missing")?;
            (
                op.prepared.clone().ok_or("update-not-prepared")?,
                op.status.preview.clone().ok_or("update-not-prepared")?,
                op.cancel.clone(),
            )
        };
        let _serial = loop {
            if cancel.is_cancelled()
                || self.updates.shutdown.is_cancelled()
                || self.updates.app_restart.load(Ordering::Acquire)
            {
                return Err("update-cancelled".into());
            }
            if let Some(accepted) = self
                .updates
                .operations
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(id)
                .and_then(|o| o.accepted.clone())
            {
                request = accepted;
            }
            let busy = self.busy_reason(&preview.plugin_id).await;
            let activity = self.last_update_activity(&preview.plugin_id);
            let ready = {
                let mut ops = self
                    .updates
                    .operations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                let op = ops.get_mut(id).ok_or("update-operation-missing")?;
                if request.stop_using {
                    true
                } else if busy.is_some() {
                    op.idle_since = None;
                    false
                } else if !request.automatic {
                    true
                } else {
                    let idle_since = op.idle_since.get_or_insert_with(Instant::now);
                    if let Some(activity) = activity.filter(|activity| activity > idle_since) {
                        *idle_since = activity;
                    }
                    idle_since.elapsed() >= Duration::from_secs(30)
                }
            };
            // Keep observing activity while another plugin owns the commit slot.
            if ready {
                if let Ok(guard) = self.updates.serial.try_lock() {
                    break guard;
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };
        let _guard = self
            .mutation_guard(&preview.plugin_id)
            .map_err(|e| e.to_string())?;
        if cancel.is_cancelled() {
            return Err("update-cancelled".into());
        }
        if prepared
            .expires_at_ms
            .is_some_and(|expiry| now_ms() >= expiry)
        {
            return Err("update-feed-expired".into());
        }
        if request.automatic && self.safe_mode() {
            return Err("update-safe-mode".into());
        }
        if !request.stop_using && self.busy_reason(&preview.plugin_id).await.is_some() {
            return Err("update-plugin-became-busy".into());
        }
        let current = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .records
            .get(&preview.plugin_id)
            .cloned();
        if state_fingerprint(current.as_ref().map(|r| &r.0)) != prepared.expected {
            return Err("update-review-stale".into());
        }
        if current.as_ref().map(|r| r.0.generation) != preview.expected_generation {
            return Err("update-review-stale".into());
        }
        if self.policy_fingerprint(&preview.plugin_id) != prepared.expected_policy {
            return Err("update-review-stale".into());
        }
        if let Some(source) = &preview.trusted_source {
            let policy = self.update_policy(&preview.plugin_id);
            if !policy.bound
                || policy.source_id.as_ref() != Some(source)
                || (request.automatic
                    && (!policy.automatic
                        || preview
                            .release
                            .as_ref()
                            .is_none_or(|r| r.channel != policy.channel)))
            {
                return Err("update-source-confirmation-required".into());
            }
        }
        self.validate_update_manifest(&prepared.manifest)
            .map_err(|e| e.to_string())?;
        if request.stop_using && self.playback_uses_plugin(&preview.plugin_id).await {
            if let Some(core) = self.core_context() {
                core.player()
                    .stop()
                    .await
                    .map_err(|_| "update-playback-stop-failed")?;
            }
        }
        // Exclude new native calls before stopping the old runtime. Already
        // admitted logins keep their lease and are never cancelled here.
        let _provider_admission = if request.stop_using {
            Vec::new()
        } else {
            let adapters = self
                .provider_runtime
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .active
                .values()
                .filter(|a| a.plugin_id == preview.plugin_id)
                .map(|a| a.adapter.clone())
                .collect::<Vec<_>>();
            let guards = adapters
                .iter()
                .map(|a| a.try_admit_update())
                .collect::<Option<Vec<_>>>()
                .ok_or("update-plugin-became-busy")?;
            if self
                .busy_reason_with_admission(&preview.plugin_id, true)
                .await
                .is_some()
                || (request.automatic
                    && self
                        .last_update_activity(&preview.plugin_id)
                        .is_some_and(|at| at.elapsed() < Duration::from_secs(30)))
            {
                return Err("update-plugin-became-busy".into());
            }
            guards
        };
        {
            let calls = self
                .updates
                .bridge_calls
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if !request.stop_using
                && calls.get(&preview.plugin_id).is_some_and(|a| {
                    a.count.load(Ordering::Acquire) > 0
                        || (request.automatic
                            && a.last_activity
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .elapsed()
                                < Duration::from_secs(30))
                })
            {
                return Err("update-plugin-became-busy".into());
            }
            self.emit_update(id, "quiescing", None);
        }
        if preview.needs_renderer && preview.enabled && !self.safe_mode() {
            self.wait_renderer(id).await?;
        }
        let host = self.clone();
        let pending = prepared.clone();
        let view = preview.clone();
        let req = request.clone();
        let tx_result =
            tokio::task::spawn_blocking(move || host.begin_update(&req, &pending, &view))
                .await
                .unwrap_or_else(|_| Err("update-install-failed".into()));
        let transaction = match tx_result {
            Ok(tx) => tx,
            Err(error) => {
                self.rollback_update(id, &preview.plugin_id, current)
                    .await?;
                return Err(error);
            }
        };
        let validating = if preview.needs_renderer && !self.safe_mode() {
            self.emit_update(id, "validating", None);
            self.wait_renderer(id).await
        } else {
            Ok(())
        };
        if let Err(error) = validating {
            self.rollback_update(id, &preview.plugin_id, current)
                .await?;
            return Err(error);
        }
        self.emit_update(id, "committing", None);
        // Freeze new bridge calls before draining validation writes. No write
        // may escape staging while the durable state pointer is being switched.
        let drain = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if self
                    .updates
                    .bridge_calls
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&preview.plugin_id)
                    .is_none_or(|a| a.count.load(Ordering::Acquire) == 0)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if drain.is_err() {
            self.rollback_update(id, &preview.plugin_id, current)
                .await?;
            return Err("update-validation-calls-did-not-stop".into());
        }
        let host = self.clone();
        let operation_id = id.clone();
        let mut tx = transaction;
        let commit = tokio::task::spawn_blocking(move || {
            let directory = host.root.join(".updates").join(&operation_id);
            let data_path = directory.join("data-journal.json");
            if data_path.exists() {
                let data = read_json::<storage::DataJournal>(&data_path)
                    .ok_or("update-journal-invalid")?;
                data.install(&directory, false)?;
            }
            host.fault_point("data-write")?;
            let storage_path = directory.join("next.storage.json");
            if storage_path.exists() {
                let bytes = fs::read(&storage_path).map_err(|_| "update-data-unreadable")?;
                atomic_bytes(
                    &host.root.join(format!("{}.storage.json", tx.plugin_id)),
                    &bytes,
                )?;
            }
            let candidate_dir =
                package_path(&host.root, &tx.candidate).map_err(|e| e.to_string())?;
            let inner = host.inner.lock().unwrap_or_else(|p| p.into_inner());
            let manifest = &inner
                .records
                .get(&tx.plugin_id)
                .ok_or("update-plugin-missing")?
                .1;
            persist_state(&host.root, &tx.candidate, manifest, candidate_dir)
                .map_err(|e| e.to_string())?;
            write_json(&host.root.join("host.json"), &inner.host).map_err(|e| e.to_string())?;
            host.fault_point("state-write")?;
            tx.committed = true;
            api::atomic_json(&directory.join("transaction.json"), &tx)?;
            host.fault_point("committed")?;
            Ok::<_, String>(())
        })
        .await
        .unwrap_or_else(|_| Err("update-commit-failed".into()));
        if let Err(error) = commit {
            let committed = read_json::<Transaction>(
                &self.root.join(".updates").join(id).join("transaction.json"),
            )
            .is_some_and(|tx| tx.committed);
            if !committed {
                self.rollback_update(id, &preview.plugin_id, current)
                    .await?;
                return Err(error);
            }
            tracing::warn!(target: "plugin.update", %error, "installation committed; completing recovery");
        }
        let host = self.clone();
        let operation_id = id.clone();
        let result = tokio::task::spawn_blocking(move || {
            host.finish_committed_update(&operation_id, &preview, &prepared, current)
        })
        .await
        .unwrap_or_else(|_| Some("update-committed-restart-required".into()));
        drop(_guard);
        drop(_serial);
        self.emit_update(id, "completed", result);
        Ok(())
    }

    fn finish_committed_update(
        &self,
        id: &str,
        preview: &UpdatePreview,
        prepared: &Prepared,
        current: Option<(PluginStateFile, PluginManifest, PathBuf)>,
    ) -> Option<String> {
        self.updates
            .staged
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&preview.plugin_id);
        let directory = self.root.join(".updates").join(id);
        let services = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .host_services
            .clone();
        let mut cleanup_complete = match services {
            Some(services) => services.finish_update(&directory, true).is_ok(),
            None => true,
        };
        // Replace staging contexts before restoring sessions; data/credentials now use the committed roots.
        let _ = self.deactivate_provider_plugin(&preview.plugin_id);
        // Clear the validation phase before constructing committed contexts.
        {
            let mut ops = self
                .updates
                .operations
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if let Some(op) = ops.get_mut(id) {
                op.status.phase = "restoring".into();
            }
        }
        let restore_error = if preview.enabled {
            self.activate_provider_plugin(&preview.plugin_id)
                .err()
                .map(|e| e.to_string())
        } else {
            None
        };
        cleanup_complete &= self.record_update_result(id, None).is_ok();
        if cleanup_complete && restore_error.is_none() {
            if let Some(mut tx) = read_json::<Transaction>(&directory.join("transaction.json")) {
                tx.runtime_restored = true;
                cleanup_complete =
                    api::atomic_json(&directory.join("transaction.json"), &tx).is_ok();
            } else {
                cleanup_complete = false;
            }
            if cleanup_complete {
                self.updates
                    .recovery_required
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&preview.plugin_id);
            }
        }
        self.forget_removed_providers(current.as_ref().map(|r| &r.1), Some(&prepared.manifest));
        self.cleanup_old_packages(&preview.plugin_id, current.as_ref().map(|r| &r.0));
        if cleanup_complete {
            self.cleanup_update(id);
        }
        self.updates
            .compiled
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&preview.plugin_id);
        restore_error
            .map(|_| "update-committed-restart-required".into())
            .or_else(|| (!cleanup_complete).then(|| "update-committed-cleanup-pending".into()))
    }

    async fn wait_renderer(&self, id: &str) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(result) = self
                    .updates
                    .operations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .and_then(|o| o.renderer_ack.clone())
                {
                    return result;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| "update-renderer-timeout")?
    }

    fn begin_update(
        &self,
        request: &ApplyRequest,
        prepared: &Prepared,
        preview: &UpdatePreview,
    ) -> Result<Transaction, String> {
        let id = &preview.plugin_id;
        let directory = self.root.join(".updates").join(&request.operation_id);
        let inspected = crate::plugin::package::inspect_directory(&prepared.directory)
            .map_err(|e| e.to_string())?;
        if inspected.sha256 != prepared.content_sha256 {
            return Err("update-staged-content-changed".into());
        }
        let destination = self.root.join(id).join("packages").join(&preview.sha256);
        if destination.exists() {
            if crate::plugin::package::inspect_directory(&destination)
                .map_err(|e| e.to_string())?
                .sha256
                != prepared.content_sha256
            {
                return Err("update-installed-content-changed".into());
            }
        } else {
            fs::create_dir_all(destination.parent().ok_or("update-path-invalid")?)
                .map_err(|_| "update-stage-failed")?;
            fs::rename(&prepared.directory, &destination).map_err(|_| "update-stage-failed")?;
        }
        let previous = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .records
            .get(id)
            .map(|r| r.0.clone());
        let mut epochs = previous
            .as_ref()
            .map(|s| s.session_epochs.clone())
            .unwrap_or_default();
        for provider in &preview.session_changes {
            epochs.insert(provider.clone(), format!("{:032x}", rand::random::<u128>()));
        }
        let mut session_secret_fields = previous
            .as_ref()
            .map(|s| s.session_secret_fields.clone())
            .unwrap_or_default();
        for provider in &preview.session_changes {
            session_secret_fields.remove(provider);
        }
        let mut retained_session_namespaces = previous
            .as_ref()
            .map(|s| s.retained_session_namespaces.clone())
            .unwrap_or_default();
        if let Some((state, manifest, _)) = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .records
            .get(id)
        {
            for provider in manifest.provider_declarations() {
                retained_session_namespaces.push(crate::plugin::component_host::session_namespace(
                    id,
                    &provider.id,
                    state.session_epochs.get(&provider.id).map(String::as_str),
                ));
            }
        }
        retained_session_namespaces.sort();
        retained_session_namespaces.dedup();
        let candidate = PluginStateFile {
            id: id.clone(),
            active_version: prepared.manifest.version.clone(),
            active_package: Some(preview.sha256.clone()),
            release: prepared.release.clone(),
            session_epochs: epochs,
            session_secret_fields,
            retained_session_namespaces,
            generation: previous
                .as_ref()
                .map_or(1, |s| s.generation.saturating_add(1)),
            enabled: preview.enabled,
            status: if preview.enabled {
                PluginStatus::Active
            } else {
                PluginStatus::Disabled
            },
            status_reason: None,
            granted_permissions: preview.permissions.clone(),
            package_sha256: preview.sha256.clone(),
            content_sha256: prepared.content_sha256.clone(),
            source: preview
                .trusted_source
                .as_ref()
                .map_or_else(|| "local-file".into(), |s| format!("trusted:{s}")),
            style_scan: prepared.style_scan.clone(),
            script_scan: prepared.script_scan.clone(),
            unpacked_path: prepared.unpacked_path.clone(),
        };
        let boot_id = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .journal
            .boot_id
            .clone();
        let tx = Transaction {
            plugin_id: id.clone(),
            previous,
            candidate: candidate.clone(),
            committed: false,
            rolled_back: false,
            boot_id,
            runtime_restored: false,
            release_id: prepared.release_id.clone(),
            policy_recorded: false,
        };
        api::atomic_json(&directory.join("transaction.json"), &tx)?;
        self.updates
            .recovery_required
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone());
        self.fault_point("journal")?;
        let bridge = self
            .updates
            .bridge_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
        if let Some(activity) = &bridge {
            activity.cancel.cancel();
        }
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .runtimes
            .retain(|_, token| token.plugin_id != *id);
        let active = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .active
            .values()
            .filter(|a| a.plugin_id == *id)
            .map(|a| a.adapter.clone())
            .collect::<Vec<_>>();
        for adapter in &active {
            adapter.stop_for_update();
        }
        self.deactivate_provider_plugin(id)
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        while active.iter().any(|a| a.component().busy())
            || bridge
                .as_ref()
                .is_some_and(|a| a.count.load(Ordering::Acquire) > 0)
        {
            if started.elapsed() > Duration::from_secs(15) {
                return Err("update-calls-did-not-stop".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .runtimes
            .retain(|_, token| token.plugin_id != *id);
        for suffix in ["storage.json", "settings.json"] {
            storage::copy_tree(
                &self.root.join(format!("{id}.{suffix}")),
                &directory.join(format!("previous.{suffix}")),
            )?;
        }
        atomic_bytes(&directory.join("local-backup-ready"), b"1")?;
        self.fault_point("quiesced")?;
        let services = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .host_services
            .clone();
        if let Some(services) = services {
            let namespaces = prepared
                .manifest
                .provider_declarations()
                .iter()
                .map(|p| {
                    crate::plugin::component_host::session_namespace(
                        id,
                        &p.id,
                        candidate.session_epochs.get(&p.id).map(String::as_str),
                    )
                })
                .collect();
            let staged = services.stage_update(&directory, namespaces)?;
            self.updates
                .staged
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id.clone(), staged);
        }
        if let Some(compiled) = &prepared.compiled {
            self.updates
                .compiled
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id.clone(), compiled.clone());
        }
        if !preview.enabled || self.safe_mode() {
            if let Some(compiled) = &prepared.compiled {
                for provider in prepared.manifest.provider_declarations() {
                    let host = self.staged_component_services(id).map(|s| {
                        s.for_plugin_session(
                            id,
                            &provider.id,
                            HashSet::new(),
                            serde_json::json!({}),
                            candidate
                                .session_epochs
                                .get(&provider.id)
                                .map(String::as_str),
                        )
                    });
                    let adapter = ComponentProviderAdapter::from_precompiled(
                        &prepared.manifest,
                        provider,
                        compiled.clone(),
                        host,
                    )
                    .map_err(|e| e.to_string())?;
                    adapter
                        .component()
                        .validate_start()
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if preview.enabled && !inner.host.safe_mode {
                inner.journal.activation_started = true;
                write_json(&self.root.join("journal.json"), &inner.journal)
                    .map_err(|e| e.to_string())?;
            }
            inner.records.insert(
                id.clone(),
                (candidate, prepared.manifest.clone(), destination),
            );
            if !inner.host.style_order.contains(id) {
                inner.host.style_order.push(id.clone());
            }
        }
        self.emit_update(&request.operation_id, "applying", None);
        if preview.enabled {
            self.activate_provider_plugin(id)
                .map_err(|e| e.to_string())?;
        }
        self.fault_point("validated")?;
        Ok(tx)
    }

    async fn rollback_update(
        self: &Arc<Self>,
        operation_id: &str,
        id: &str,
        previous: Option<(PluginStateFile, PluginManifest, PathBuf)>,
    ) -> Result<(), String> {
        self.emit_update(operation_id, "rolling-back", None);
        let host = self.clone();
        let operation_id = operation_id.to_owned();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            let restore_previous = previous.is_some();
            let directory = host.root.join(".updates").join(&operation_id);
            if !directory.join("transaction.json").exists() {
                return Ok(());
            }
            if read_json::<Transaction>(&directory.join("transaction.json"))
                .is_some_and(|t| t.committed)
            {
                return Err("update-committed-cleanup-pending".into());
            }
            let _ = host.deactivate_provider_plugin(&id);
            host.inner
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .runtimes
                .retain(|_, token| token.plugin_id != id);
            let bridge = host
                .updates
                .bridge_calls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            if let Some(activity) = &bridge {
                activity.cancel.cancel();
            }
            let started = Instant::now();
            while bridge
                .as_ref()
                .is_some_and(|a| a.count.load(Ordering::Acquire) > 0)
            {
                if started.elapsed() >= Duration::from_secs(15) {
                    return Err("update-recovery-required".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let candidate = host
                .inner
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .records
                .get(&id)
                .map(|r| r.1.clone());
            host.forget_removed_providers(candidate.as_ref(), previous.as_ref().map(|r| &r.1));
            host.updates
                .staged
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            host.updates
                .compiled
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            recover_one(&host.root, &directory)
                .map_err(|e| format!("update-recovery-required: {e}"))?;
            {
                let mut inner = host.inner.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(previous) = previous {
                    inner.records.insert(id.clone(), previous);
                } else {
                    inner.records.remove(&id);
                    inner.host.style_order.retain(|v| v != &id);
                }
                let values =
                    read_json(&host.root.join(format!("{id}.storage.json"))).unwrap_or_default();
                inner.storage.insert(id.clone(), values);
            }
            let services = host
                .provider_runtime
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .host_services
                .clone();
            if let Some(services) = services {
                services.finish_update(&directory, false)?;
            }
            host.register_installed_provider_descriptors();
            {
                let mut ops = host
                    .updates
                    .operations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                if let Some(op) = ops.get_mut(&operation_id) {
                    op.status.phase = "rolling-back".into();
                }
            }
            host.inner
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .runtimes
                .retain(|_, token| token.plugin_id != id);
            if restore_previous {
                host.activate_provider_plugin(&id)
                    .map_err(|_| "update-recovery-required".to_owned())?;
            }
            let journal = directory.join("transaction.json");
            let mut tx: Transaction = read_json(&journal).ok_or("update-journal-invalid")?;
            tx.runtime_restored = true;
            api::atomic_json(&journal, &tx)?;
            Ok(())
        })
        .await
        .map_err(|_| "update-recovery-required".to_owned())?
    }

    fn record_update_result(
        &self,
        operation_id: &str,
        error: Option<&str>,
    ) -> Result<(), HostError> {
        let details = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(operation_id)
            .and_then(|o| {
                o.status
                    .preview
                    .clone()
                    .map(|p| (p, o.release_id.clone(), o.status.runtime_changed))
            });
        let Some((preview, release_id, runtime_changed)) = details else {
            return Ok(());
        };
        let mut policies = self
            .updates
            .policies
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let policy = policies.entry(preview.plugin_id).or_default();
        if error.is_some() && !runtime_changed {
            // Busy/stale/cancelled reviews never attempted an installation.
            policy.last_result = error.map(str::to_owned);
        } else {
            set_result_policy(
                policy,
                &preview.sha256,
                release_id.as_deref(),
                preview.trusted_source.is_none(),
                error,
            );
        }
        if !self.updates.policy_corrupt {
            self.fault_point("policy-write").map_err(HostError::from)?;
            write_json(&self.root.join("update-policies.json"), &*policies)?;
        }
        let journal = self
            .root
            .join(".updates")
            .join(operation_id)
            .join("transaction.json");
        if let Some(mut tx) = read_json::<Transaction>(&journal) {
            tx.policy_recorded = true;
            api::atomic_json(&journal, &tx).map_err(HostError::from)?;
        }
        Ok(())
    }

    fn cleanup_update(&self, operation_id: &str) {
        let directory = self.root.join(".updates").join(operation_id);
        if read_json::<Transaction>(&directory.join("transaction.json")).is_some_and(|tx| {
            self.updates
                .recovery_required
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains(&tx.plugin_id)
        }) {
            return;
        }
        if read_json::<Transaction>(&directory.join("transaction.json"))
            .is_some_and(|tx| (!tx.committed && !tx.rolled_back) || !tx.policy_recorded)
        {
            return;
        }
        if directory.join("credentials.json").exists() {
            return;
        }
        let _ = fs::remove_dir_all(directory);
        let mut ops = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(op) = ops.get_mut(operation_id) {
            op.prepared = None;
        }
    }

    fn cleanup_old_packages(&self, id: &str, previous: Option<&PluginStateFile>) {
        let current = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .records
            .get(id)
            .map(|r| r.2.clone());
        let previous = previous.and_then(|s| package_path(&self.root, s).ok());
        for parent in [
            self.root.join(id).join("packages"),
            self.root.join(id).join("versions"),
        ] {
            if let Ok(entries) = fs::read_dir(&parent) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if current.as_ref() != Some(&path)
                        && previous.as_ref() != Some(&path)
                        && entry
                            .file_type()
                            .is_ok_and(|t| t.is_dir() && !t.is_symlink())
                    {
                        let _ = fs::remove_dir_all(path);
                    }
                }
            }
        }
    }

    fn forget_removed_providers(
        &self,
        old: Option<&PluginManifest>,
        next: Option<&PluginManifest>,
    ) {
        let registry = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .registry
            .clone();
        if let (Some(registry), Some(old)) = (registry, old) {
            let next = next
                .map(|m| {
                    m.provider_declarations()
                        .iter()
                        .map(|p| p.id.clone())
                        .chain(m.federations.iter().map(|p| p.id.clone()))
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default();
            for id in old
                .provider_declarations()
                .iter()
                .map(|p| &p.id)
                .chain(old.federations.iter().map(|p| &p.id))
            {
                if !next.contains(id) {
                    registry.forget_inactive(id);
                }
            }
        }
    }
    pub(super) fn mutation_guard(&self, id: &str) -> Result<MutationGuard, HostError> {
        if self.updates.app_restart.load(Ordering::Acquire) {
            return Err(HostError::from("application-update-in-progress"));
        }
        let recovery = self
            .updates
            .recovery_required
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if recovery.contains(id) || (id == "*" && !recovery.is_empty()) {
            return Err(HostError::from("update-recovery-required"));
        }
        drop(recovery);
        let mut locked = self
            .updates
            .lifecycle
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if self.updates.app_restart.load(Ordering::Acquire) {
            return Err(HostError::from("application-update-in-progress"));
        }
        if locked.contains("*")
            || (id == "*" && !locked.is_empty())
            || !locked.insert(id.to_owned())
        {
            return Err(HostError::from("plugin-operation-in-progress"));
        }
        Ok(MutationGuard {
            id: id.to_owned(),
            locked: self.updates.lifecycle.clone(),
        })
    }

    pub(crate) fn update_in_progress(&self, id: &str) -> bool {
        self.updates
            .staged
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(id)
            || self
                .updates
                .operations
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values()
                .any(|o| {
                    o.status.plugin_id.as_deref() == Some(id)
                        && matches!(
                            o.status.phase.as_str(),
                            "quiescing" | "applying" | "validating"
                        )
                })
    }

    pub(super) fn staged_component_services(&self, id: &str) -> Option<ComponentHostServices> {
        self.updates
            .staged
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }

    pub(super) fn precompiled_component(
        &self,
        id: &str,
    ) -> Option<crate::plugin::component::CompiledComponent> {
        self.updates
            .compiled
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }

    pub(super) fn update_storage_path(&self, id: &str) -> PathBuf {
        let ops = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(op) = ops.values().find(|o| {
            o.status.plugin_id.as_deref() == Some(id)
                && matches!(o.status.phase.as_str(), "applying" | "validating")
        }) {
            return self
                .root
                .join(".updates")
                .join(&op.status.operation_id)
                .join("next.storage.json");
        }
        self.root.join(format!("{id}.storage.json"))
    }

    pub(super) fn recover_update_credentials(
        &self,
        services: &ComponentHostServices,
    ) -> Result<(), HostError> {
        let directory = self.root.join(".updates");
        if !directory.exists() {
            return Ok(());
        }
        for entry in
            fs::read_dir(directory).map_err(|_| HostError::from("update-recovery-unreadable"))?
        {
            let path = entry
                .map_err(|_| HostError::from("update-recovery-unreadable"))?
                .path();
            if let Some(tx) = read_json::<Transaction>(&path.join("transaction.json")) {
                services
                    .finish_update(&path, tx.committed)
                    .map_err(HostError::from)?;
                if tx.committed || tx.rolled_back {
                    fs::remove_dir_all(path)
                        .map_err(|_| HostError::from("update-cleanup-failed"))?;
                }
                self.updates
                    .recovery_required
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&tx.plugin_id);
            }
        }
        Ok(())
    }

    pub fn subscribe_updates(&self) -> broadcast::Receiver<UpdateOperation> {
        self.updates.events.subscribe()
    }

    pub fn update_sources(&self) -> Vec<remote::TrustedSource> {
        self.updates.sources.clone()
    }

    pub fn update_policy(&self, id: &str) -> UpdatePolicy {
        let mut policy = self
            .updates
            .policies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
            .unwrap_or_default();
        if self.updates.policy_corrupt {
            policy.last_result = Some("update-policy-recovery-required".into());
        }
        if policy.bound
            && !self.updates.sources.iter().any(|s| {
                policy.source_id.as_ref() == Some(&s.id) && policy.trust_digest == source_digest(s)
            })
        {
            policy.bound = false;
            policy.automatic = false;
        }
        policy
    }

    fn policy_fingerprint(&self, id: &str) -> String {
        let policy = self.update_policy(id);
        serde_json::json!([
            policy.source_id,
            policy.channel,
            policy.bound,
            policy.automatic,
            policy.trust_digest
        ])
        .to_string()
    }

    pub fn set_update_policy(&self, request: PolicyRequest) -> Result<UpdatePolicy, HostError> {
        if self.updates.policy_corrupt {
            return Err(HostError::from("update-policy-recovery-required"));
        }
        let _guard = self.mutation_guard(&request.plugin_id)?;
        self.record(&request.plugin_id)?;
        if let Some(source_id) = &request.source_id {
            if !self
                .updates
                .sources
                .iter()
                .any(|s| s.id == *source_id && s.plugin_id == request.plugin_id)
            {
                return Err(HostError::from("update-source-not-trusted"));
            }
        }
        let mut policies = self
            .updates
            .policies
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut policy = policies
            .get(&request.plugin_id)
            .cloned()
            .unwrap_or_default();
        let digest = request
            .source_id
            .as_ref()
            .and_then(|id| self.updates.sources.iter().find(|s| &s.id == id))
            .map(source_digest)
            .unwrap_or_default();
        if request.source_id.is_some()
            && (policy.source_id != request.source_id
                || !policy.bound
                || policy.trust_digest != digest)
            && !request.confirm_source
        {
            return Err(HostError::from("update-source-confirmation-required"));
        }
        if policy.source_id != request.source_id {
            if let Some(source) = policy.source_id.clone() {
                policy.source_history.insert(
                    source,
                    SourceHistory {
                        feed_sequence: policy.feed_sequence,
                        feed_digest: policy.feed_digest.clone(),
                        releases_seen: policy.releases_seen.clone(),
                    },
                );
            }
            let history = request
                .source_id
                .as_ref()
                .and_then(|id| policy.source_history.get(id))
                .cloned()
                .unwrap_or_default();
            policy.feed_sequence = history.feed_sequence;
            policy.feed_digest = history.feed_digest;
            policy.releases_seen = history.releases_seen;
            policy.last_check_ms = 0;
            policy.failures = 0;
            policy.retry_after_ms = 0;
        }
        policy.trust_digest = digest;
        policy.source_id = request.source_id;
        policy.bound = policy.source_id.is_some();
        policy.automatic = request.automatic && policy.bound;
        policy.channel = request.channel;
        let mut next = policies.clone();
        next.insert(request.plugin_id, policy.clone());
        write_json(&self.root.join("update-policies.json"), &next)?;
        *policies = next;
        Ok(policy)
    }

    pub fn update_status(
        &self,
        operation_id: Option<&str>,
    ) -> Result<Vec<UpdateOperation>, HostError> {
        let operations = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        match operation_id {
            Some(id) => Ok(vec![operations
                .get(id)
                .ok_or_else(|| HostError::from("update-operation-missing"))?
                .status
                .clone()]),
            None => Ok(operations.values().map(|o| o.status.clone()).collect()),
        }
    }

    fn emit_update(&self, id: &str, phase: &str, error: Option<String>) {
        let mut operations = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(op) = operations.get_mut(id) {
            if op.status.phase != phase {
                op.renderer_ack = None;
            }
            if phase == "quiescing" {
                op.status.runtime_changed = true;
            }
            op.status.phase = phase.into();
            op.status.error = error;
            let _ = self.updates.events.send(op.status.clone());
        }
    }

    pub fn cancel_update(self: &Arc<Self>, id: &str) -> Result<(), HostError> {
        let mut operations = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let operation = operations
            .get_mut(id)
            .ok_or_else(|| HostError::from("update-operation-missing"))?;
        if matches!(
            operation.status.phase.as_str(),
            "quiescing" | "applying" | "validating" | "committing" | "restoring" | "rolling-back"
        ) {
            return Err(HostError::from("update-commit-in-progress"));
        }
        if !operation.status.terminal() {
            operation.cancel.cancel();
            operation.prepared = None;
            operation.status.phase = "cancelled".into();
            let _ = self.updates.events.send(operation.status.clone());
        }
        let cleanup = operation.status.phase == "cancelled";
        drop(operations);
        if cleanup {
            let host = self.clone();
            let id = id.to_owned();
            tokio::task::spawn_blocking(move || host.cleanup_update(&id));
        }
        Ok(())
    }

    pub fn update_editing(&self, id: &str, editing: bool) -> Result<(), HostError> {
        self.record(id)?;
        let mut entries = self
            .updates
            .editing
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if editing {
            entries.insert(id.to_owned(), Instant::now());
        } else {
            entries.remove(id);
        }
        drop(entries);
        for op in self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values_mut()
        {
            if op.status.plugin_id.as_deref() == Some(id) {
                op.idle_since = None;
            }
        }
        Ok(())
    }

    pub fn update_runtime_ready(&self, request: RuntimeReadyRequest) -> Result<(), HostError> {
        let mut ops = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let op = ops
            .get_mut(&request.operation_id)
            .ok_or_else(|| HostError::from("update-operation-missing"))?;
        if op.status.phase != request.stage
            || !matches!(request.stage.as_str(), "quiescing" | "validating")
            || op.status.preview.as_ref().map(|p| p.sha256.as_str()) != Some(&request.sha256)
        {
            return Err(HostError::from("update-stale-runtime-ack"));
        }
        if op.renderer_ack.is_some() {
            return Err(HostError::from("update-duplicate-runtime-ack"));
        }
        op.renderer_ack = Some(
            request
                .error
                .map_or(Ok(()), |_| Err("update-renderer-start-failed".into())),
        );
        Ok(())
    }

    pub fn prepare_update(
        self: &Arc<Self>,
        request: PrepareRequest,
    ) -> Result<UpdateOperation, HostError> {
        if self.updates.app_restart.load(Ordering::Acquire) {
            return Err(HostError::from("application-update-in-progress"));
        }
        if request.path.is_some() == request.release_id.is_some() {
            return Err(HostError::from("update-source-required"));
        }
        if request.unpacked && !self.developer_mode() {
            return Err(HostError::from("developer mode is required"));
        }
        let mut ops = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if ops.values().filter(|o| !o.status.terminal()).count() >= 8 {
            return Err(HostError::from("update-queue-full"));
        }
        // Bound status history. Active operations and their staged bytes are never evicted.
        if ops.len() >= 64 {
            ops.retain(|_, o| !o.status.terminal());
        }
        let id = format!("{:032x}", rand::random::<u128>());
        let status = UpdateOperation {
            operation_id: id.clone(),
            plugin_id: request.plugin_id.clone(),
            phase: "preparing".into(),
            preview: None,
            downloaded_bytes: 0,
            total_bytes: None,
            error: None,
            runtime_changed: false,
        };
        let cancel = CancellationToken::new();
        ops.insert(
            id.clone(),
            Operation {
                status: status.clone(),
                prepared: None,
                release_id: request.release_id.clone(),
                cancel: cancel.clone(),
                accepted: None,
                renderer_ack: None,
                idle_since: None,
            },
        );
        drop(ops);
        let host = self.clone();
        tokio::spawn(async move {
            let remote_plugin = request.release_id.as_ref().and_then(|id| {
                host.updates
                    .releases
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .map(|r| r.record.plugin_id.clone())
            });
            let result = host.prepare_task(&id, request, &cancel).await;
            if let Err(error) = result {
                if let Some(plugin) = remote_plugin.filter(|_| !cancel.is_cancelled()) {
                    let mut policies = host
                        .updates
                        .policies
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    let policy = policies.entry(plugin).or_default();
                    policy.failures = policy.failures.saturating_add(1);
                    policy.last_result = Some(error.clone());
                    policy.retry_after_ms = now_ms()
                        .saturating_add((60_000u64 << policy.failures.min(6)).min(3_600_000));
                    let _ = write_json(&host.root.join("update-policies.json"), &*policies);
                }
                host.emit_update(
                    &id,
                    if cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    Some(error),
                );
            }
            if host
                .update_status(Some(&id))
                .is_ok_and(|ops| ops[0].terminal())
            {
                let cleanup = host.clone();
                let _ = tokio::task::spawn_blocking(move || cleanup.cleanup_update(&id)).await;
            }
        });
        Ok(status)
    }

    async fn prepare_task(
        self: &Arc<Self>,
        id: &str,
        request: PrepareRequest,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let directory = self.root.join(".updates").join(id);
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|_| "update-stage-failed")?;
        let remote_release = request
            .release_id
            .as_ref()
            .map(|release_id| {
                self.updates
                    .releases
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(release_id)
                    .cloned()
                    .ok_or("update-release-missing")
            })
            .transpose()?;
        let path = if let Some(release) = &remote_release {
            if now_ms() >= release.expires_at_ms {
                return Err("update-feed-expired".into());
            }
            let source = self
                .updates
                .sources
                .iter()
                .find(|s| s.id == release.source_id)
                .ok_or("update-source-not-trusted")?;
            let policy = self.update_policy(&source.plugin_id);
            if !policy.bound || policy.source_id.as_deref() != Some(&source.id) {
                return Err("update-source-confirmation-required".into());
            }
            let _permit = tokio::select! { _ = cancel.cancelled() => return Err("update-cancelled".into()), p = self.updates.downloads.acquire() => p.map_err(|_| "update-shutdown")? };
            let path = directory.join("download.yaqmc-plugin");
            self.updates
                .http
                .download(&release.record, source, &path, cancel, |count| {
                    let mut ops = self
                        .updates
                        .operations
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    if let Some(op) = ops.get_mut(id) {
                        op.status.downloaded_bytes = count;
                        op.status.total_bytes = Some(release.record.size);
                        let _ = self.updates.events.send(op.status.clone());
                    }
                })
                .await?;
            path
        } else {
            PathBuf::from(request.path.as_deref().ok_or("update-source-required")?)
        };
        if path.is_dir() && !request.unpacked {
            return Err("update-unpacked-requires-developer-mode".into());
        }
        let host = self.clone();
        let operation_id = id.to_owned();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            host.prepare_sync(
                &operation_id,
                &path,
                &directory,
                request,
                remote_release,
                &cancel,
            )
        })
        .await
        .map_err(|_| "update-prepare-failed")?
    }

    fn prepare_sync(
        &self,
        operation_id: &str,
        path: &Path,
        directory: &Path,
        request: PrepareRequest,
        remote_release: Option<remote::AvailableRelease>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let inspection = if remote_release.is_none()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("css"))
        {
            Self::inspect_loose_css(path).map_err(|e| e.to_string())?
        } else if remote_release.is_none()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("js"))
        {
            Self::inspect_loose_script(path).map_err(|e| e.to_string())?
        } else {
            inspect_package(path).map_err(|e| e.to_string())?
        };
        let manifest = &inspection.manifest;
        if let Some(script) = &manifest.entrypoints.script {
            let file = inspection
                .files
                .iter()
                .find(|f| &f.path == script)
                .ok_or("update-script-missing")?;
            std::str::from_utf8(&file.bytes).map_err(|_| "update-script-encoding-invalid")?;
        }
        if request
            .plugin_id
            .as_ref()
            .is_some_and(|id| id != &manifest.id)
        {
            return Err("update-plugin-id-mismatch".into());
        }
        if css_is_blocked(&inspection.style_scan) {
            return Err("update-unsafe-style".into());
        }
        if let Some(schema) = &manifest.settings_schema {
            crate::plugin::settings::parse_settings_fields(schema)?;
        }
        if let Some(message) = crate::plugin::package::stale_typescript_message(&inspection.files) {
            return Err(message);
        }
        let mut scene_ids = HashSet::new();
        for scene in &manifest.entrypoints.scenes {
            let bytes = &inspection
                .files
                .iter()
                .find(|file| &file.path == scene)
                .ok_or("update-scene-missing")?
                .bytes;
            let value: serde_json::Value =
                serde_json::from_slice(bytes).map_err(|_| "update-scene-invalid")?;
            if !value.is_object()
                || !scene_ids.insert(
                    value
                        .get("id")
                        .and_then(|v| v.as_str())
                        .ok_or("update-scene-invalid")?
                        .to_owned(),
                )
            {
                return Err("update-scene-invalid".into());
            }
        }
        let _guard = self
            .mutation_guard(&manifest.id)
            .map_err(|e| e.to_string())?;
        let old = self
            .inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .records
            .get(&manifest.id)
            .cloned();
        self.validate_update_manifest(manifest)
            .map_err(|e| e.to_string())?;
        let release = remote_release
            .as_ref()
            .map(|r| r.record.release.clone())
            .or_else(|| manifest.release.clone());
        if let Some(remote) = &remote_release {
            if remote.record.plugin_id != manifest.id
                || remote.record.version != manifest.version
                || remote.record.sha256 != inspection.sha256
                || manifest
                    .release
                    .as_ref()
                    .is_some_and(|r| Some(r) != release.as_ref())
            {
                return Err("update-package-manifest-mismatch".into());
            }
        }
        let current = old.as_ref().map(|(state, _, _)| state);
        let requested = manifest.requested_permission_keys();
        let granted = current
            .map(|s| s.granted_permissions.clone())
            .unwrap_or_default();
        let added = requested
            .iter()
            .filter(|p| !granted.contains(p))
            .cloned()
            .collect::<Vec<_>>();
        let removed = granted
            .iter()
            .filter(|p| !requested.contains(p))
            .cloned()
            .collect::<Vec<_>>();
        let mut confirmations = Vec::new();
        if let Some(state) = current {
            let change = version_change(&state.active_version, &manifest.version);
            if change != "upgrade" {
                confirmations.push(change.into());
            }
            if state
                .release
                .as_ref()
                .map(|r| r.channel)
                .unwrap_or_default()
                != release.as_ref().map(|r| r.channel).unwrap_or_default()
            {
                confirmations.push("channel-change".into());
            }
            if remote_release.as_ref().is_some_and(|r| {
                state.source.starts_with("trusted:")
                    && state.source != format!("trusted:{}", r.source_id)
            }) {
                confirmations.push("trust-change".into());
            }
        }
        let session_changes = session_changes(old.as_ref().map(|(_, m, _)| m), manifest);
        if !session_changes.is_empty() {
            confirmations.push("session-change".into());
        }
        if !added.is_empty() {
            confirmations.push("permissions".into());
        }
        if remote_release.is_none() {
            confirmations.push("unverified-source".into());
        }
        let expires_at_ms = remote_release.as_ref().map(|r| r.expires_at_ms);
        let needs_renderer = manifest.entrypoints.component.is_none()
            || old
                .as_ref()
                .is_some_and(|(_, m, _)| m.entrypoints.component.is_none());
        let preview = UpdatePreview {
            provider_ids: manifest
                .provider_declarations()
                .iter()
                .map(|p| p.id.clone())
                .chain(old.as_ref().into_iter().flat_map(|(_, m, _)| {
                    m.provider_declarations().into_iter().map(|p| p.id.clone())
                }))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            expected_generation: current.map(|s| s.generation),
            plugin_id: manifest.id.clone(),
            name: manifest.name.clone(),
            current_version: current.map(|s| s.active_version.clone()),
            version: manifest.version.clone(),
            current_sha256: current.map(|s| s.package_sha256.clone()),
            sha256: inspection.sha256.clone(),
            release: release.clone(),
            permissions: requested,
            granted_permissions: granted,
            added_permissions: added,
            removed_permissions: removed,
            session_changes,
            confirmations,
            trusted_source: remote_release.map(|r| r.source_id),
            enabled: current.is_none_or(|s| s.enabled),
            needs_renderer,
            has_script: manifest.entrypoints.script.is_some(),
        };
        let unchanged = preview.current_sha256.as_deref() == Some(&preview.sha256);
        drop(_guard);
        let compiled = if unchanged {
            None
        } else {
            manifest
                .entrypoints
                .component
                .as_ref()
                .map(|entry| {
                    let bytes = inspection
                        .files
                        .iter()
                        .find(|f| &f.path == entry)
                        .ok_or("update-component-missing")?;
                    crate::plugin::component::ProviderComponent::compile(&bytes.bytes)
                        .map_err(|e| e.to_string())
                })
                .transpose()?
        };
        let unpacked_path = request.unpacked.then(|| path.display().to_string());
        let stage = directory.join("package");
        if !unchanged {
            extract_to(&inspection, &stage).map_err(|e| e.to_string())?;
        }
        self.fault_point("prepared")?;
        let prepared = Prepared {
            manifest: manifest.clone(),
            expected: state_fingerprint(current),
            expected_policy: self.policy_fingerprint(&manifest.id),
            content_sha256: crate::plugin::package::content_sha256(&inspection.files),
            directory: stage,
            style_scan: inspection.style_scan,
            script_scan: inspection.script_scan,
            release,
            release_id: request.release_id,
            expires_at_ms,
            compiled,
            unpacked_path,
        };
        let mut ops = self
            .updates
            .operations
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let op = ops
            .get_mut(operation_id)
            .ok_or("update-operation-missing")?;
        if cancel.is_cancelled() {
            return Err("update-cancelled".into());
        }
        op.status.plugin_id = Some(manifest.id.clone());
        op.status.preview = Some(preview);
        op.status.phase = if unchanged { "unchanged" } else { "prepared" }.into();
        op.prepared = (!unchanged).then_some(prepared);
        let _ = self.updates.events.send(op.status.clone());
        Ok(())
    }

    fn validate_update_manifest(&self, manifest: &PluginManifest) -> Result<(), HostError> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(reason) = compatibility_reason(manifest, &inner.records) {
            return Err(HostError::from(reason));
        }
        let mut hypothetical = inner.records.clone();
        if let Some((s, m, _)) = hypothetical.get_mut(&manifest.id) {
            *m = manifest.clone();
            s.active_version = manifest.version.clone();
        }
        if dependency_cycle(&manifest.id, manifest, &hypothetical) {
            return Err(HostError::from("plugin dependency cycle detected"));
        }
        let ids = manifest
            .provider_declarations()
            .iter()
            .map(|p| p.id.as_str())
            .chain(manifest.federations.iter().map(|p| p.id.as_str()))
            .collect::<HashSet<_>>();
        let owned = inner
            .records
            .get(&manifest.id)
            .map(|(_, old, _)| {
                old.provider_declarations()
                    .iter()
                    .map(|p| p.id.clone())
                    .chain(old.federations.iter().map(|p| p.id.clone()))
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default();
        if let Some(registry) = self
            .provider_runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .registry
            .clone()
        {
            if registry
                .descriptors()
                .iter()
                .any(|d| ids.contains(d.provider_id.as_str()) && !owned.contains(&d.provider_id))
            {
                return Err(HostError::from("update-provider-id-conflict"));
            }
        }
        for (id, (_, other, _)) in &hypothetical {
            if id == &manifest.id {
                continue;
            }
            if let Some(reason) = missing_dependency(other, &hypothetical) {
                return Err(HostError::from(reason));
            }
            if other
                .provider_declarations()
                .iter()
                .any(|p| ids.contains(p.id.as_str()))
                || other
                    .federations
                    .iter()
                    .any(|p| ids.contains(p.id.as_str()))
            {
                return Err(HostError::from("update-provider-id-conflict"));
            }
        }
        Ok(())
    }
}

fn state_fingerprint(state: Option<&PluginStateFile>) -> String {
    sha256_bytes(&serde_json::to_vec(&state).expect("plugin state serializes"))
}

fn source_digest(source: &remote::TrustedSource) -> String {
    sha256_bytes(&serde_json::to_vec(source).expect("trusted source serializes"))
}

fn session_changes(old: Option<&PluginManifest>, next: &PluginManifest) -> Vec<String> {
    let Some(old) = old else {
        return Vec::new();
    };
    let old_ids = old
        .provider_declarations()
        .into_iter()
        .map(|p| (p.id.as_str(), p.session_schema_version))
        .collect::<BTreeMap<_, _>>();
    let new_ids = next
        .provider_declarations()
        .into_iter()
        .map(|p| (p.id.as_str(), p.session_schema_version))
        .collect::<BTreeMap<_, _>>();
    old_ids
        .keys()
        .chain(new_ids.keys())
        .filter(|id| old_ids.get(*id) != new_ids.get(*id))
        .map(|id| (*id).to_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests;
