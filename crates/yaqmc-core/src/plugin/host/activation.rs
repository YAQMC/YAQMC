//! Attribute interrupted startup to pending plugin activations, never to a whole process lifetime.
use super::*;

const INTERRUPTED_ACTIVATION_LIMIT: u32 = 3;
const LEGACY_UNCLEAN_REASON: &str = "disabled after an unclean shutdown during plugin activation";
const INTERRUPTED_ACTIVATION_REASON: &str = "plugin-activation-interrupted";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingActivation {
    plugin_id: String,
    content_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActivationFailures {
    content_sha256: String,
    count: u32,
}

pub(super) fn recover(
    root: &Path,
    previous: JournalFile,
    journal: &mut JournalFile,
    records: &mut BTreeMap<String, (PluginStateFile, PluginManifest, PathBuf)>,
    recovered_update: bool,
) -> Result<(), HostError> {
    let migrate_legacy = previous.activation_recovery_version == 0;
    journal.activation_failures = previous.activation_failures;
    journal.activation_failures.retain(|id, failures| {
        records.get(id).is_some_and(|(state, _, _)| {
            state.enabled && state.content_sha256 == failures.content_sha256
        })
    });
    let interrupted: HashSet<_> = if previous.clean_exit || recovered_update {
        HashSet::new()
    } else {
        previous
            .pending_activations
            .values()
            .map(|a| (a.plugin_id.clone(), a.content_sha256.clone()))
            .collect()
    };
    for (id, hash) in interrupted {
        let Some((state, manifest, dir)) = records.get_mut(&id) else {
            continue;
        };
        if !state.enabled || state.activation_suspended || state.content_sha256 != hash {
            continue;
        }
        let failures =
            journal
                .activation_failures
                .entry(id.clone())
                .or_insert(ActivationFailures {
                    content_sha256: hash,
                    count: 0,
                });
        failures.count = failures.count.saturating_add(1);
        if failures.count >= INTERRUPTED_ACTIVATION_LIMIT {
            state.activation_suspended = true;
            state.status = PluginStatus::Failed;
            state.status_reason = Some(INTERRUPTED_ACTIVATION_REASON.into());
            persist_state(root, state, manifest, dir.clone())?;
            tracing::warn!(target: "plugin.runtime", plugin_id = %id, "plugin startup suspended after repeated interrupted activations; enabled preference preserved");
        }
    }
    // Legacy recovery overwrote the user's enable setting. Restore only records
    // bearing that exact old reason, after package integrity has been checked.
    // A persisted manual/global safe-mode choice is deliberately left untouched.
    for (state, manifest, dir) in records.values_mut() {
        if migrate_legacy
            && state.status == PluginStatus::Failed
            && state.status_reason.as_deref() == Some(LEGACY_UNCLEAN_REASON)
        {
            state.enabled = true;
            state.activation_suspended = false;
            state.status = PluginStatus::Active;
            state.status_reason = None;
            persist_state(root, state, manifest, dir.clone())?;
        }
    }
    Ok(())
}

pub(super) fn start_locked(
    root: &Path,
    inner: &mut HostInner,
    plugin_id: &str,
    attempt: &str,
) -> Result<(), HostError> {
    let (state, _, _) = inner
        .records
        .get(plugin_id)
        .ok_or_else(|| HostError::from("the plugin is not installed"))?;
    inner.journal.pending_activations.insert(
        attempt.to_owned(),
        PendingActivation {
            plugin_id: plugin_id.to_owned(),
            content_sha256: state.content_sha256.clone(),
        },
    );
    write_json(&root.join("journal.json"), &inner.journal)
}

pub(super) fn cancel_locked(
    root: &Path,
    inner: &mut HostInner,
    plugin_id: &str,
) -> Result<(), HostError> {
    inner
        .journal
        .pending_activations
        .retain(|_, activation| activation.plugin_id != plugin_id);
    inner.journal.activation_failures.remove(plugin_id);
    write_json(&root.join("journal.json"), &inner.journal)
}

impl ExtensionHost {
    /// Only the trusted renderer acknowledges Worker activation; the guest SDK
    /// has no method that can clear another runtime's startup marker.
    pub fn runtime_ready(&self, token: &str) -> Result<(), HostError> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let runtime = inner
            .runtimes
            .get(token)
            .ok_or_else(|| HostError::from("unknown plugin runtime"))?;
        let id = runtime.plugin_id.clone();
        inner
            .journal
            .pending_activations
            .retain(|_, activation| activation.plugin_id != id);
        inner.journal.activation_failures.remove(&id);
        write_json(&self.root.join("journal.json"), &inner.journal)
    }

    pub(super) fn begin_component_activation(
        &self,
        plugin_id: &str,
    ) -> Result<Option<String>, HostError> {
        // Component update validation has its own recoverable transaction.
        if self.update_phase(plugin_id).is_some() {
            return Ok(None);
        }
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let Some((state, manifest, _)) = inner.records.get(plugin_id) else {
            return Ok(None);
        };
        if inner.host.safe_mode || !state.effective_enabled() || manifest.api_version != 3 {
            return Ok(None);
        }
        let attempt = format!("component-{:032x}", rand::random::<u128>());
        start_locked(&self.root, &mut inner, plugin_id, &attempt)?;
        Ok(Some(attempt))
    }

    pub(super) fn finish_component_activation(&self, attempt: &str) -> Result<(), HostError> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(activation) = inner.journal.pending_activations.remove(attempt) {
            inner
                .journal
                .activation_failures
                .remove(&activation.plugin_id);
        }
        write_json(&self.root.join("journal.json"), &inner.journal)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{component_inspection, style_inspection};
    use super::*;
    use crate::plugin::package::PackageFile;

    fn install_script(host: &ExtensionHost, id: &str) {
        let mut inspection = style_inspection(id);
        inspection.manifest.entrypoints.styles.clear();
        inspection.manifest.entrypoints.script = Some("dist/main.js".into());
        inspection.files = vec![
            PackageFile {
                path: "manifest.json".into(),
                bytes: serde_json::to_vec(&inspection.manifest).unwrap(),
            },
            PackageFile {
                path: "dist/main.js".into(),
                bytes: b"definePlugin({ activate() {} });".to_vec(),
            },
        ];
        host.install_inspection(inspection, true, &[], "test")
            .unwrap();
    }
    fn boot(root: &Path) -> ExtensionHost {
        ExtensionHost::open(root.to_path_buf()).unwrap()
    }

    #[test]
    fn legacy_reason_is_not_a_repeated_enable_bypass_after_migration() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        install_script(&host, "dev.example.worker");
        host.mark_failed("dev.example.worker", LEGACY_UNCLEAN_REASON)
            .unwrap();
        drop(host);
        assert!(
            !boot(root.path())
                .record("dev.example.worker")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn interrupted_old_package_hash_does_not_suspend_current_content() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        install_script(&host, "dev.example.worker");
        {
            let mut inner = host.inner.lock().unwrap();
            inner.journal.pending_activations.insert(
                "old".into(),
                PendingActivation {
                    plugin_id: "dev.example.worker".into(),
                    content_sha256: "old-package".into(),
                },
            );
            inner.journal.activation_failures.insert(
                "dev.example.worker".into(),
                ActivationFailures {
                    content_sha256: "old-package".into(),
                    count: 2,
                },
            );
            write_json(&root.path().join("journal.json"), &inner.journal).unwrap();
        }
        drop(host);
        let host = boot(root.path());
        assert!(host.record("dev.example.worker").unwrap().enabled);
        assert!(host
            .inner
            .lock()
            .unwrap()
            .journal
            .activation_failures
            .is_empty());
    }

    #[test]
    fn ready_workers_survive_repeated_process_kills_without_clean_shutdown() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        install_script(&host, "dev.example.worker");
        drop(host);
        for _ in 0..5 {
            let host = boot(root.path());
            assert!(!host.safe_mode());
            assert!(host.list()[0].enabled);
            let runtime = host.start_runtime("dev.example.worker").unwrap();
            assert_eq!(
                host.inner.lock().unwrap().journal.pending_activations.len(),
                1
            );
            host.runtime_ready(&runtime.token).unwrap();
            assert!(host
                .inner
                .lock()
                .unwrap()
                .journal
                .pending_activations
                .is_empty());
            // Drop without mark_clean_exit: Android process reclamation / desktop kill.
        }
    }

    #[test]
    fn three_interrupted_attempts_suspend_only_the_same_plugin_and_keep_user_intent() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        install_script(&host, "dev.example.bad");
        install_script(&host, "dev.example.good");
        host.install_inspection(style_inspection("dev.example.style"), true, &[], "test")
            .unwrap();
        drop(host);
        for _ in 0..3 {
            let host = boot(root.path());
            let good = host.start_runtime("dev.example.good").unwrap();
            host.runtime_ready(&good.token).unwrap();
            host.start_runtime("dev.example.bad").unwrap();
        }
        let host = boot(root.path());
        assert!(!host.safe_mode());
        assert!(host.record("dev.example.good").unwrap().enabled);
        assert!(host.record("dev.example.style").unwrap().enabled);
        let bad = host.record("dev.example.bad").unwrap();
        assert!(!bad.enabled);
        assert_eq!(bad.status, PluginStatus::Failed);
        assert!(
            host.inner.lock().unwrap().records["dev.example.bad"]
                .0
                .enabled
        );
        assert!(host.start_runtime("dev.example.bad").is_err());
        assert!(host
            .active_resources()
            .scripts
            .iter()
            .all(|s| s.plugin_id != "dev.example.bad"));
        host.set_enabled("dev.example.bad", true).unwrap();
        let retried = host.start_runtime("dev.example.bad").unwrap();
        host.runtime_ready(&retried.token).unwrap();
        drop(host);
        assert!(boot(root.path()).record("dev.example.bad").unwrap().enabled);
    }

    #[test]
    fn cancelled_or_cleanly_stopped_activations_do_not_count_as_crashes() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        install_script(&host, "dev.example.worker");
        drop(host);
        for cancellation in ["stop", "clean", "safe-mode", "uninstall"] {
            let host = boot(root.path());
            let runtime = host.start_runtime("dev.example.worker").unwrap();
            match cancellation {
                "clean" => host.mark_clean_exit(),
                "safe-mode" => {
                    host.set_safe_mode(true).unwrap();
                    host.set_safe_mode(false).unwrap();
                }
                "uninstall" => {
                    host.uninstall("dev.example.worker", false).unwrap();
                    install_script(&host, "dev.example.worker");
                }
                _ => host.stop_runtime(&runtime.token),
            }
            assert!(host
                .inner
                .lock()
                .unwrap()
                .journal
                .pending_activations
                .is_empty());
        }
        let host = boot(root.path());
        assert!(host.record("dev.example.worker").unwrap().enabled);
        assert!(host
            .inner
            .lock()
            .unwrap()
            .journal
            .activation_failures
            .is_empty());
    }

    #[test]
    fn successful_retry_resets_failures_and_stale_tokens_cannot_acknowledge_new_activations() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        install_script(&host, "dev.example.worker");
        let previous = host.start_runtime("dev.example.worker").unwrap().token;
        drop(host);
        let host = boot(root.path());
        let current = host.start_runtime("dev.example.worker").unwrap();
        assert!(host.runtime_ready(&previous).is_err());
        assert_eq!(
            host.inner.lock().unwrap().journal.pending_activations.len(),
            1
        );
        host.runtime_ready(&current.token).unwrap();
        drop(host);
        for _ in 0..2 {
            let host = boot(root.path());
            host.start_runtime("dev.example.worker").unwrap();
        }
        assert!(
            boot(root.path())
                .record("dev.example.worker")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn legacy_auto_disabled_records_restore_but_manual_safe_mode_and_disables_remain() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        for id in [
            "dev.example.auto",
            "dev.example.manual",
            "dev.example.failed",
        ] {
            host.install_inspection(style_inspection(id), true, &[], "test")
                .unwrap();
        }
        host.mark_failed("dev.example.auto", LEGACY_UNCLEAN_REASON)
            .unwrap();
        host.mark_failed("dev.example.failed", "actual plugin error")
            .unwrap();
        host.set_enabled("dev.example.manual", false).unwrap();
        host.set_safe_mode(true).unwrap();
        drop(host);
        fs::write(
            root.path().join("journal.json"),
            br#"{"bootId":"old","activationStarted":true,"cleanExit":false}"#,
        )
        .unwrap();
        let host = boot(root.path());
        assert!(host.safe_mode());
        assert!(
            host.inner.lock().unwrap().records["dev.example.auto"]
                .0
                .enabled
        );
        host.set_safe_mode(false).unwrap();
        assert!(host.record("dev.example.auto").unwrap().enabled);
        assert!(!host.record("dev.example.manual").unwrap().enabled);
        assert!(!host.record("dev.example.failed").unwrap().enabled);
    }

    #[test]
    fn component_activation_success_clears_its_marker_and_does_not_arm_the_process_lifetime() {
        let root = tempfile::tempdir().unwrap();
        let host = boot(root.path());
        host.install_inspection(
            component_inspection("dev.example.component", "dev.example.provider"),
            true,
            &["provider.catalog".to_owned()],
            "test",
        )
        .unwrap();
        let attempt = host
            .begin_component_activation("dev.example.component")
            .unwrap()
            .unwrap();
        host.finish_component_activation(&attempt).unwrap();
        drop(host);
        let host = boot(root.path());
        assert!(host.record("dev.example.component").unwrap().enabled);
        assert!(!host.safe_mode());
        assert!(host
            .inner
            .lock()
            .unwrap()
            .journal
            .activation_failures
            .is_empty());
    }
}
