//! Player event fan-out: §3.2 channel map, lagged-resync, SMTC feed, queue persist.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use yaqmc_protocol::{
    CHANNEL_ACCOUNT_CHANGED, CHANNEL_API_EVENT, CHANNEL_HOST_COMMAND, CHANNEL_LYRICS_DOCUMENT,
    CHANNEL_LYRICS_PROJECTION, CHANNEL_PLAYER_SNAPSHOT,
};

use crate::player::{ApiEvent, PlayerService};
use crate::storage::StorageService;
use crate::system_media::SystemMediaIntegration;
use crate::CoreHandle;
use crate::HostCommand;

const PLAYER_SNAPSHOT_EVENT_TYPES: &[&str] = &[
    "queue.changed",
    "player.track",
    "player.playback",
    "player.position",
    "player.seeked",
    "player.volume",
    "player.mode",
    "player.error",
];

const LYRICS_PROJECTION_EVENT_TYPES: &[&str] = &[
    "player.position",
    "player.seeked",
    "player.track",
    "player.playback",
    "player.error",
    "lyrics.changed",
    "lyrics.line",
    "lyrics.word",
];

const QUEUE_PERSIST_EVENT_TYPES: &[&str] = &[
    "queue.changed",
    "player.track",
    "player.playback",
    "player.volume",
    "player.mode",
    "player.error",
];

const LAGGED_RESYNC_CHANNELS: &[&str] = &[
    CHANNEL_PLAYER_SNAPSHOT,
    CHANNEL_LYRICS_PROJECTION,
    CHANNEL_LYRICS_DOCUMENT,
];

/// Host-facing sink for sequenced protocol `event` frames.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, seq: u64, channel: &str, payload: &Value);
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FanoutActions {
    pub channels: Vec<&'static str>,
    pub update_system_media: bool,
    pub persist_queue: bool,
    pub system_media_seeked: bool,
}

pub fn actions_for_player_event(event_type: &str) -> FanoutActions {
    let mut channels = vec![CHANNEL_API_EVENT];
    let snapshot = PLAYER_SNAPSHOT_EVENT_TYPES.contains(&event_type);
    if snapshot {
        channels.push(CHANNEL_PLAYER_SNAPSHOT);
    }
    if LYRICS_PROJECTION_EVENT_TYPES.contains(&event_type) {
        channels.push(CHANNEL_LYRICS_PROJECTION);
    }
    if event_type == "lyrics.changed" {
        channels.push(CHANNEL_LYRICS_DOCUMENT);
    }
    FanoutActions {
        channels,
        update_system_media: snapshot,
        persist_queue: QUEUE_PERSIST_EVENT_TYPES.contains(&event_type),
        system_media_seeked: event_type == "player.seeked",
    }
}

pub fn lagged_resync_channels() -> &'static [&'static str] {
    LAGGED_RESYNC_CHANNELS
}

pub fn host_command_event(command: HostCommand) -> (&'static str, Value) {
    let payload = match command {
        HostCommand::RaiseMainWindow => json!({ "command": "raise" }),
        HostCommand::Quit => json!({ "command": "quit" }),
        HostCommand::SurfaceAutoHide(hidden) => json!({ "surfaceAutoHide": hidden }),
    };
    (CHANNEL_HOST_COMMAND, payload)
}

struct SequencedSink {
    seq: AtomicU64,
    inner: Arc<dyn EventSink>,
}

impl SequencedSink {
    fn new(inner: Arc<dyn EventSink>) -> Self {
        Self {
            seq: AtomicU64::new(0),
            inner,
        }
    }

    fn emit_channel(&self, channel: &str, payload: Value) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.inner.emit(seq, channel, &payload);
    }
}

fn json_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or_else(|_| json!({}))
}

async fn emit_mapped_event(
    player: &PlayerService,
    storage: &StorageService,
    system_media: &SystemMediaIntegration,
    sink: &SequencedSink,
    event: ApiEvent,
) {
    let actions = actions_for_player_event(&event.event_type);
    for channel in &actions.channels {
        let payload = match *channel {
            CHANNEL_API_EVENT => json_value(&event),
            CHANNEL_PLAYER_SNAPSHOT => event.data.clone(),
            CHANNEL_LYRICS_PROJECTION => json_value(&player.lyric_surface_projection().await),
            CHANNEL_LYRICS_DOCUMENT => json_value(&player.lyrics().await),
            _ => continue,
        };
        sink.emit_channel(channel, payload);
    }
    if actions.update_system_media {
        let snapshot = player.snapshot().await;
        system_media.update(&snapshot, actions.system_media_seeked);
    }
    if actions.persist_queue {
        let snapshot = player.snapshot().await;
        if let Err(error) = storage.save_queue(&snapshot) {
            tracing::warn!(target: "storage", error = %error, "queue persistence failed");
        }
    }
}

async fn resync_after_lag(
    player: &PlayerService,
    system_media: &SystemMediaIntegration,
    sink: &SequencedSink,
    skipped: u64,
) {
    tracing::warn!(
        target: "player.session",
        skipped,
        "player event subscriber lagged; resyncing authoritative snapshot"
    );
    let snapshot = player.snapshot().await;
    sink.emit_channel(CHANNEL_PLAYER_SNAPSHOT, json_value(&snapshot));
    let projection = player.lyric_surface_projection().await;
    sink.emit_channel(CHANNEL_LYRICS_PROJECTION, json_value(&projection));
    let document = player.lyrics().await;
    sink.emit_channel(CHANNEL_LYRICS_DOCUMENT, json_value(&document));
    system_media.update(&snapshot, false);
}

/// Subscribe to the closed `HostCommand` bus and emit `host://command` frames.
pub fn spawn_host_command_fanout(
    runtime: &tokio::runtime::Handle,
    mut commands: tokio::sync::broadcast::Receiver<HostCommand>,
    sink: Arc<dyn EventSink>,
) {
    let sink = SequencedSink::new(sink);
    runtime.spawn(async move {
        loop {
            match commands.recv().await {
                Ok(command) => {
                    let (channel, payload) = host_command_event(command);
                    sink.emit_channel(channel, payload);
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        target: "host.command",
                        skipped,
                        "host command subscriber lagged; dropping stale command"
                    );
                }
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Restore provider accounts without blocking the request loop, then notify
/// renderers so an initial guest snapshot cannot remain stale after startup.
pub fn spawn_account_restore_fanout(
    runtime: &tokio::runtime::Handle,
    core: Arc<CoreHandle>,
    sink: Arc<dyn EventSink>,
) {
    let sink = SequencedSink::new(sink);
    runtime.spawn(async move {
        #[cfg(feature = "plugins")]
        core.plugins().restore_provider_accounts().await;

        // Reduced hosts (notably Android) do not compile the extension host. Its
        // compatibility stub cannot restore the in-tree provider, so restore the
        // registry directly instead of leaving a persisted account at revision 0.
        #[cfg(not(feature = "plugins"))]
        {
            let providers = core.providers();
            for provider_id in providers.provider_ids() {
                if let Ok(account) = providers.require_account_provider(provider_id.as_str()) {
                    account.provider_account().restore_session().await;
                }
            }
        }

        let providers = core.providers();
        let provider_ids = providers.provider_ids().collect::<Vec<_>>();
        let mut signed_in = false;
        for provider_id in provider_ids {
            let Ok(account) = providers.require_account_provider(provider_id.as_str()) else {
                continue;
            };
            if account
                .provider_account()
                .account_snapshot()
                .await
                .state_name()
                == "authenticated"
            {
                signed_in = true;
                break;
            }
        }
        sink.emit_channel(CHANNEL_ACCOUNT_CHANGED, json!({ "signedIn": signed_in }));
    });
}

/// Subscribe to `PlayerService` and emit protocol events with the §3.2 map.
///
/// SMTC feed and queue persistence stay in this task. The host sink is responsible
/// for delivering frames over the stdio transport.
pub fn spawn_player_fanout(
    runtime: &tokio::runtime::Handle,
    player: Arc<PlayerService>,
    storage: Arc<StorageService>,
    system_media: Arc<SystemMediaIntegration>,
    sink: Arc<dyn EventSink>,
) {
    let mut receiver = player.subscribe();
    let sink = SequencedSink::new(sink);
    runtime.spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    emit_mapped_event(&player, &storage, &system_media, &sink, event).await;
                }
                Err(RecvError::Lagged(skipped)) => {
                    resync_after_lag(&player, &system_media, &sink, skipped).await;
                }
                Err(RecvError::Closed) => break,
            }
        }
    });
}
