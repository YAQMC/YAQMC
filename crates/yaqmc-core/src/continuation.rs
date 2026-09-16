//! Core-owned recommendation continuation sessions.
//!
//! Renderer code starts or ends a session, but queue observation, prefetch,
//! deduplication, retry, and stale-response rejection remain authoritative here.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use yaqmc_provider_api::{
    ProviderCommandError, ProviderProfileKey, ProviderRegistry, RecommendationBatch,
    RecommendationKind, RecommendationRequest, RecommendationSeed, Song, DEFAULT_PROFILE_ID,
};

use crate::player::{PlayTracksRequest, PlaybackState, PlayerService, RepeatMode};

const DEFAULT_BATCH_SIZE: u32 = 5;
const PREFETCH_REMAINING: usize = 2;
const MAX_SEEN_TRACKS: usize = 500;
const MAX_EMPTY_BATCHES: u8 = 3;
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(8),
];

fn continuation_provider_error(error: ProviderCommandError) -> ContinuationError {
    ContinuationError::ProviderCommand(error)
}

fn session_profile(provider_id: &str, profile_id: &str) -> ProviderProfileKey {
    ProviderProfileKey::new(provider_id, profile_id)
        .expect("active continuation sessions always carry a validated profile key")
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContinuationKind {
    Guess,
    Radar,
}

impl From<ContinuationKind> for RecommendationKind {
    fn from(value: ContinuationKind) -> Self {
        match value {
            ContinuationKind::Guess => Self::Guess,
            ContinuationKind::Radar => Self::Radar,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationStartRequest {
    pub provider_id: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    pub kind: ContinuationKind,
    pub tracks: Vec<Song>,
    #[serde(default)]
    pub start_at_id: Option<String>,
    #[serde(default)]
    pub seed_track_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContinuationRequestState {
    #[default]
    Idle,
    Fetching,
    Retrying,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContinuationTerminalReason {
    Explicit,
    QueueReplaced,
    ProviderChanged,
    AccountChanged,
    Stopped,
    ProviderEnded,
    EmptyBatches,
    SeenLimit,
    ProviderError,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationSnapshot {
    pub active: bool,
    pub session_id: Option<u64>,
    pub provider_id: Option<String>,
    pub profile_id: Option<String>,
    pub kind: Option<ContinuationKind>,
    pub account_generation: Option<u64>,
    pub cursor: Option<String>,
    pub seen_count: usize,
    pub consecutive_empty_batches: u8,
    pub request_state: ContinuationRequestState,
    pub terminal_reason: Option<ContinuationTerminalReason>,
    pub last_error_code: Option<String>,
    pub notification_revision: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ContinuationError {
    #[error("music provider is unavailable")]
    ProviderUnavailable,
    #[error("the provider account changed while the continuation was starting")]
    AccountChanged,
    #[error("the playback queue changed while the continuation was starting")]
    QueueReplaced,
    #[error("continuation tracks must all belong to the selected provider")]
    InvalidTrackProvider,
    #[error("invalid provider profile: {0}")]
    InvalidProviderProfile(yaqmc_provider_api::ProviderProfileKeyError),
    #[error("provider command failed: {}", .0.message)]
    ProviderCommand(ProviderCommandError),
    #[error("radar continuation requires a numeric seed track")]
    InvalidRadarSeed,
    #[error("continuation exceeds the {MAX_SEEN_TRACKS}-track session limit")]
    SeenLimit,
    #[error("{0}")]
    Player(String),
}

#[async_trait]
pub trait ContinuationProviderSource: Send + Sync {
    fn account_generation(
        &self,
        profile: &ProviderProfileKey,
    ) -> Result<Option<u64>, ProviderCommandError>;
    async fn next(
        &self,
        profile: &ProviderProfileKey,
        request: RecommendationRequest,
    ) -> Result<RecommendationBatch, ProviderCommandError>;
    async fn remember_songs(
        &self,
        profile: &ProviderProfileKey,
        songs: &[Song],
    ) -> Result<(), ProviderCommandError>;
}

#[async_trait]
impl ContinuationProviderSource for ProviderRegistry {
    fn account_generation(
        &self,
        profile: &ProviderProfileKey,
    ) -> Result<Option<u64>, ProviderCommandError> {
        ProviderRegistry::account_generation_for_profile(self, profile)
    }

    async fn next(
        &self,
        profile: &ProviderProfileKey,
        request: RecommendationRequest,
    ) -> Result<RecommendationBatch, ProviderCommandError> {
        self.recommendation_next_for_profile(profile, request).await
    }

    async fn remember_songs(
        &self,
        profile: &ProviderProfileKey,
        songs: &[Song],
    ) -> Result<(), ProviderCommandError> {
        ProviderRegistry::remember_songs_for_profile(self, profile, songs).await
    }
}

struct ActiveSession {
    id: u64,
    provider_id: String,
    profile_id: String,
    kind: ContinuationKind,
    account_generation: u64,
    cursor: String,
    seeds: Vec<RecommendationSeed>,
    seen: HashSet<String>,
    recommendation_entries: HashSet<String>,
    consecutive_empty_batches: u8,
    request_state: ContinuationRequestState,
    request_generation: u64,
}

#[derive(Default)]
struct ServiceState {
    active: Option<ActiveSession>,
    projection: ContinuationSnapshot,
}

#[derive(Clone)]
struct FetchToken {
    session_id: u64,
    request_generation: u64,
    provider_id: String,
    profile_id: String,
    account_generation: u64,
    request: RecommendationRequest,
}

pub struct ContinuationService {
    player: Arc<PlayerService>,
    providers: Arc<dyn ContinuationProviderSource>,
    state: Mutex<ServiceState>,
    session_sequence: AtomicU64,
}

impl ContinuationService {
    pub fn new(player: Arc<PlayerService>, providers: Arc<ProviderRegistry>) -> Arc<Self> {
        Self::with_source(player, providers)
    }

    pub fn with_source(
        player: Arc<PlayerService>,
        providers: Arc<dyn ContinuationProviderSource>,
    ) -> Arc<Self> {
        Arc::new(Self {
            player,
            providers,
            state: Mutex::new(ServiceState::default()),
            session_sequence: AtomicU64::new(0),
        })
    }

    pub fn start_monitor(self: &Arc<Self>, runtime: &tokio::runtime::Handle) {
        let mut events = self.player.subscribe();
        let service = Arc::clone(self);
        runtime.spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event)
                        if matches!(
                            event.event_type.as_str(),
                            "queue.changed" | "player.track" | "player.playback" | "player.mode"
                        ) =>
                    {
                        service.observe_player().await;
                    }
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }

    pub async fn snapshot(&self) -> ContinuationSnapshot {
        self.state.lock().await.projection.clone()
    }

    pub async fn start(
        self: &Arc<Self>,
        request: ContinuationStartRequest,
    ) -> Result<ContinuationSnapshot, ContinuationError> {
        let provider_id = request.provider_id.trim().to_owned();
        let profile_id = request
            .profile_id
            .unwrap_or_else(|| DEFAULT_PROFILE_ID.to_owned());
        let profile = ProviderProfileKey::new(&provider_id, &profile_id)
            .map_err(ContinuationError::InvalidProviderProfile)?;
        let account_generation = self
            .providers
            .account_generation(&profile)
            .map_err(continuation_provider_error)?
            .ok_or(ContinuationError::ProviderUnavailable)?;
        if request.tracks.len() > MAX_SEEN_TRACKS {
            return Err(ContinuationError::SeenLimit);
        }
        let initial_cursor = request.tracks.len();
        let mut seen = HashSet::with_capacity(request.tracks.len());
        let mut expected_queue = Vec::with_capacity(request.tracks.len());
        for track in &request.tracks {
            let Some(key) = track_key(&profile.provider_id, &profile.profile_id, track) else {
                return Err(ContinuationError::InvalidTrackProvider);
            };
            seen.insert(key.clone());
            if track.availability.is_available() {
                expected_queue.push(key);
            }
        }
        let seeds = request
            .seed_track_ids
            .iter()
            .filter_map(|id| {
                request.tracks.iter().find(|track| {
                    track.id == *id
                        || track
                            .provider
                            .as_ref()
                            .is_some_and(|reference| reference.track_id == *id)
                })
            })
            .filter_map(|track| track.provider.as_ref())
            .filter(|reference| {
                reference.provider_id == profile.provider_id
                    && reference.profile_id == profile.profile_id
            })
            .map(|reference| RecommendationSeed {
                track_id: reference.track_id.clone(),
                numeric_id: reference.numeric_id,
            })
            .collect::<Vec<_>>();
        if request.kind == ContinuationKind::Radar
            && !seeds.iter().any(|seed| seed.numeric_id.is_some())
        {
            return Err(ContinuationError::InvalidRadarSeed);
        }

        self.providers
            .remember_songs(&profile, &request.tracks)
            .await
            .map_err(continuation_provider_error)?;
        if self
            .providers
            .account_generation(&profile)
            .map_err(continuation_provider_error)?
            != Some(account_generation)
        {
            return Err(ContinuationError::AccountChanged);
        }

        self.end(ContinuationTerminalReason::Explicit).await;
        let started_snapshot = self
            .player
            .play_tracks_with_context(
                PlayTracksRequest {
                    tracks: request.tracks,
                    start_at_id: request.start_at_id,
                    shuffle: Some(false),
                },
                match request.kind {
                    ContinuationKind::Guess => "recommendation-guess",
                    ContinuationKind::Radar => "recommendation-radar",
                },
            )
            .await
            .map_err(|error| ContinuationError::Player(error.to_string()))?;
        let player_snapshot = self.player.snapshot().await;
        let actual_queue = player_snapshot
            .queue
            .iter()
            .filter_map(|track| track_key(&profile.provider_id, &profile.profile_id, track))
            .collect::<Vec<_>>();
        let started_entry_ids = started_snapshot
            .queue_entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        let current_entry_ids = player_snapshot
            .queue_entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>();
        if actual_queue != expected_queue || current_entry_ids != started_entry_ids {
            return Err(ContinuationError::QueueReplaced);
        }
        let session_id = self.session_sequence.fetch_add(1, Ordering::AcqRel) + 1;
        let cursor = match request.kind {
            ContinuationKind::Guess => initial_cursor.to_string(),
            ContinuationKind::Radar => "2".to_owned(),
        };
        let active = ActiveSession {
            id: session_id,
            provider_id: profile.provider_id,
            profile_id: profile.profile_id,
            kind: request.kind,
            account_generation,
            cursor,
            seeds,
            seen,
            recommendation_entries: player_snapshot
                .queue_entries
                .iter()
                .map(|entry| entry.id.clone())
                .collect(),
            consecutive_empty_batches: 0,
            request_state: ContinuationRequestState::Idle,
            request_generation: 0,
        };
        let projection = {
            let mut state = self.state.lock().await;
            state.active = Some(active);
            state.projection = projection_for(
                state.active.as_ref(),
                state.projection.notification_revision,
            );
            state.projection.clone()
        };
        self.publish(&projection);
        self.observe_player().await;
        Ok(projection)
    }

    pub async fn end(&self, reason: ContinuationTerminalReason) -> ContinuationSnapshot {
        let projection = {
            let mut state = self.state.lock().await;
            if state.active.is_none() {
                return state.projection.clone();
            }
            finish_locked(&mut state, reason, None, false)
        };
        self.publish(&projection);
        projection
    }

    /// End the active continuation only when it belongs to `profile`.
    ///
    /// Provider account/profile lifecycle operations use this scoped variant
    /// so that a change for one profile cannot terminate another profile's
    /// continuation session. A non-matching profile is a true no-op: it does
    /// not mutate state or publish a duplicate notification.
    pub async fn end_for_profile(
        &self,
        profile: &ProviderProfileKey,
        reason: ContinuationTerminalReason,
    ) -> ContinuationSnapshot {
        let projection = {
            let mut state = self.state.lock().await;
            if !state.active.as_ref().is_some_and(|active| {
                active.provider_id == profile.provider_id && active.profile_id == profile.profile_id
            }) {
                return state.projection.clone();
            }
            finish_locked(&mut state, reason, None, false)
        };
        self.publish(&projection);
        projection
    }

    /// Revalidate the account generation for the exact provider/profile that
    /// performed an account operation.  A provider-level check is not enough:
    /// another local profile of the same provider may have its own account
    /// generation and continuation session.
    pub async fn validate_account_generation_for_profile(
        &self,
        profile: &ProviderProfileKey,
    ) -> ContinuationSnapshot {
        let projection = {
            let mut state = self.state.lock().await;
            let Some(active) = state.active.as_ref() else {
                return state.projection.clone();
            };
            if active.provider_id != profile.provider_id
                || active.profile_id != profile.profile_id
                || self.providers.account_generation(profile).ok().flatten()
                    == Some(active.account_generation)
            {
                return state.projection.clone();
            }
            finish_locked(
                &mut state,
                ContinuationTerminalReason::AccountChanged,
                None,
                false,
            )
        };
        self.publish(&projection);
        projection
    }

    async fn observe_player(self: &Arc<Self>) {
        let snapshot = self.player.snapshot().await;
        let mut terminal = None;
        let token = {
            let mut state = self.state.lock().await;
            let Some(active) = state.active.as_mut() else {
                return;
            };
            if snapshot.playback_state == PlaybackState::Stopped {
                terminal = Some(finish_locked(
                    &mut state,
                    ContinuationTerminalReason::Stopped,
                    None,
                    false,
                ));
                None
            } else if self
                .providers
                .account_generation(&session_profile(&active.provider_id, &active.profile_id))
                .ok()
                .flatten()
                != Some(active.account_generation)
            {
                terminal = Some(finish_locked(
                    &mut state,
                    ContinuationTerminalReason::AccountChanged,
                    None,
                    false,
                ));
                None
            } else if active.seen.len() >= MAX_SEEN_TRACKS {
                terminal = Some(finish_locked(
                    &mut state,
                    ContinuationTerminalReason::SeenLimit,
                    None,
                    false,
                ));
                None
            } else {
                let queue_ids = snapshot
                    .queue_entries
                    .iter()
                    .map(|entry| entry.id.as_str())
                    .collect::<HashSet<_>>();
                if !active
                    .recommendation_entries
                    .iter()
                    .any(|entry| queue_ids.contains(entry.as_str()))
                {
                    terminal = Some(finish_locked(
                        &mut state,
                        ContinuationTerminalReason::QueueReplaced,
                        None,
                        false,
                    ));
                    None
                } else if snapshot.repeat == RepeatMode::One
                    || active.request_state != ContinuationRequestState::Idle
                {
                    None
                } else {
                    let playable_entries = snapshot
                        .queue_entries
                        .iter()
                        .filter(|entry| {
                            active.recommendation_entries.contains(&entry.id)
                                && entry.track.availability.is_available()
                        })
                        .map(|entry| entry.id.as_str())
                        .collect::<HashSet<_>>();
                    let remaining = snapshot
                        .upcoming_queue_entry_ids
                        .iter()
                        .filter(|entry| playable_entries.contains(entry.as_str()))
                        .count();
                    if remaining > PREFETCH_REMAINING {
                        None
                    } else {
                        active.request_generation = active.request_generation.saturating_add(1);
                        active.request_state = ContinuationRequestState::Fetching;
                        let token = FetchToken {
                            session_id: active.id,
                            request_generation: active.request_generation,
                            provider_id: active.provider_id.clone(),
                            profile_id: active.profile_id.clone(),
                            account_generation: active.account_generation,
                            request: RecommendationRequest {
                                kind: active.kind.into(),
                                limit: DEFAULT_BATCH_SIZE,
                                cursor: Some(active.cursor.clone()),
                                seeds: active.seeds.clone(),
                            },
                        };
                        state.projection = projection_for(
                            state.active.as_ref(),
                            state.projection.notification_revision,
                        );
                        Some((token, state.projection.clone()))
                    }
                }
            }
        };
        if let Some(projection) = terminal {
            self.publish(&projection);
            return;
        }
        if let Some((token, projection)) = token {
            self.publish(&projection);
            let service = Arc::clone(self);
            tokio::spawn(async move { service.fetch(token).await });
        }
    }

    async fn fetch(self: Arc<Self>, mut token: FetchToken) {
        'requests: loop {
            for (attempt, retry_delay) in RETRY_DELAYS
                .iter()
                .copied()
                .map(Some)
                .chain(std::iter::once(None))
                .enumerate()
            {
                if !self.token_is_current(&token).await {
                    return;
                }
                let profile = session_profile(&token.provider_id, &token.profile_id);
                if self.providers.account_generation(&profile).ok().flatten()
                    != Some(token.account_generation)
                {
                    self.finish_token(
                        &token,
                        ContinuationTerminalReason::AccountChanged,
                        None,
                        false,
                    )
                    .await;
                    return;
                }
                match self.providers.next(&profile, token.request.clone()).await {
                    Ok(batch) => {
                        if let Some(next_token) = self.apply_batch(&token, batch).await {
                            token = next_token;
                            continue 'requests;
                        }
                        return;
                    }
                    Err(error)
                        if retryable_recommendation_error(&error) && retry_delay.is_some() =>
                    {
                        if !self
                            .set_request_state(&token, ContinuationRequestState::Retrying)
                            .await
                        {
                            return;
                        }
                        let jitter_ms = (token
                            .session_id
                            .wrapping_mul(67)
                            .wrapping_add((attempt as u64 + 1).wrapping_mul(97)))
                            % 251;
                        tokio::time::sleep(
                            retry_delay.expect("retry guard requires a delay")
                                + Duration::from_millis(jitter_ms),
                        )
                        .await;
                        if !self
                            .set_request_state(&token, ContinuationRequestState::Fetching)
                            .await
                        {
                            return;
                        }
                    }
                    Err(error) => {
                        self.finish_token(
                            &token,
                            ContinuationTerminalReason::ProviderError,
                            Some(error.code),
                            true,
                        )
                        .await;
                        return;
                    }
                }
            }
            return;
        }
    }

    async fn apply_batch(
        &self,
        token: &FetchToken,
        batch: RecommendationBatch,
    ) -> Option<FetchToken> {
        let mut state = self.state.lock().await;
        let notification_revision = state.projection.notification_revision;
        let active = state.active.as_mut().filter(|active| {
            active.id == token.session_id
                && active.request_generation == token.request_generation
                && active.provider_id == token.provider_id
                && active.profile_id == token.profile_id
                && active.account_generation == token.account_generation
        })?;
        let profile = session_profile(&active.provider_id, &active.profile_id);
        if self.providers.account_generation(&profile).ok().flatten()
            != Some(active.account_generation)
        {
            let projection = finish_locked(
                &mut state,
                ContinuationTerminalReason::AccountChanged,
                None,
                false,
            );
            drop(state);
            self.publish(&projection);
            return None;
        }
        let provider_ended = batch.ended;
        active.cursor = batch.next_cursor.unwrap_or_else(|| active.cursor.clone());

        let mut batch_keys = HashSet::new();
        let mut unique = batch
            .songs
            .into_iter()
            .filter(|track| track.availability.is_available())
            .filter_map(|track| {
                track_key(&active.provider_id, &active.profile_id, &track).map(|key| (key, track))
            })
            .filter(|(key, _)| !active.seen.contains(key) && batch_keys.insert(key.clone()))
            .collect::<Vec<_>>();
        if unique.is_empty() {
            if provider_ended {
                let projection = finish_locked(
                    &mut state,
                    ContinuationTerminalReason::ProviderEnded,
                    None,
                    false,
                );
                drop(state);
                self.publish(&projection);
                return None;
            }
            active.consecutive_empty_batches = active.consecutive_empty_batches.saturating_add(1);
            active.request_state = ContinuationRequestState::Idle;
            if active.consecutive_empty_batches >= MAX_EMPTY_BATCHES {
                let projection = finish_locked(
                    &mut state,
                    ContinuationTerminalReason::EmptyBatches,
                    None,
                    false,
                );
                drop(state);
                self.publish(&projection);
                return None;
            }
            active.request_generation = active.request_generation.saturating_add(1);
            active.request_state = ContinuationRequestState::Fetching;
            let next_token = FetchToken {
                session_id: active.id,
                request_generation: active.request_generation,
                provider_id: active.provider_id.clone(),
                profile_id: active.profile_id.clone(),
                account_generation: active.account_generation,
                request: RecommendationRequest {
                    kind: active.kind.into(),
                    limit: DEFAULT_BATCH_SIZE,
                    cursor: Some(active.cursor.clone()),
                    seeds: active.seeds.clone(),
                },
            };
            state.projection = projection_for(state.active.as_ref(), notification_revision);
            let projection = state.projection.clone();
            drop(state);
            self.publish(&projection);
            return Some(next_token);
        }
        let remaining_capacity = MAX_SEEN_TRACKS.saturating_sub(active.seen.len());
        unique.truncate(remaining_capacity);
        if unique.is_empty() {
            let projection = finish_locked(
                &mut state,
                ContinuationTerminalReason::SeenLimit,
                None,
                false,
            );
            drop(state);
            self.publish(&projection);
            return None;
        }
        let anchors = active
            .recommendation_entries
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        let tracks = unique
            .iter()
            .map(|(_, track)| track.clone())
            .collect::<Vec<_>>();
        if let Err(error) = self.providers.remember_songs(&profile, &tracks).await {
            let projection = finish_locked(
                &mut state,
                ContinuationTerminalReason::ProviderError,
                Some(error.code),
                true,
            );
            drop(state);
            self.publish(&projection);
            return None;
        }
        if self.providers.account_generation(&profile).ok().flatten()
            != Some(active.account_generation)
        {
            let projection = finish_locked(
                &mut state,
                ContinuationTerminalReason::AccountChanged,
                None,
                false,
            );
            drop(state);
            self.publish(&projection);
            return None;
        }
        let Some(player_snapshot) = self
            .player
            .append_tracks_if_queue_contains(&anchors, tracks)
            .await
        else {
            let projection = finish_locked(
                &mut state,
                ContinuationTerminalReason::QueueReplaced,
                None,
                false,
            );
            drop(state);
            self.publish(&projection);
            return None;
        };
        let appended = player_snapshot
            .queue_entries
            .len()
            .saturating_sub(unique.len());
        active.recommendation_entries.extend(
            player_snapshot.queue_entries[appended..]
                .iter()
                .map(|entry| entry.id.clone()),
        );
        active.seen.extend(unique.into_iter().map(|(key, _)| key));
        active.consecutive_empty_batches = 0;
        active.request_state = ContinuationRequestState::Idle;
        if provider_ended || active.seen.len() >= MAX_SEEN_TRACKS {
            let projection = finish_locked(
                &mut state,
                if provider_ended {
                    ContinuationTerminalReason::ProviderEnded
                } else {
                    ContinuationTerminalReason::SeenLimit
                },
                None,
                false,
            );
            drop(state);
            self.publish(&projection);
            return None;
        }
        state.projection = projection_for(state.active.as_ref(), notification_revision);
        let projection = state.projection.clone();
        drop(state);
        self.publish(&projection);
        None
    }

    async fn token_is_current(&self, token: &FetchToken) -> bool {
        self.state
            .lock()
            .await
            .active
            .as_ref()
            .is_some_and(|active| {
                active.id == token.session_id
                    && active.request_generation == token.request_generation
                    && active.provider_id == token.provider_id
                    && active.profile_id == token.profile_id
                    && active.account_generation == token.account_generation
            })
    }

    async fn set_request_state(
        &self,
        token: &FetchToken,
        request_state: ContinuationRequestState,
    ) -> bool {
        let projection = {
            let mut state = self.state.lock().await;
            let notification_revision = state.projection.notification_revision;
            let Some(active) = state.active.as_mut().filter(|active| {
                active.id == token.session_id
                    && active.request_generation == token.request_generation
                    && active.provider_id == token.provider_id
                    && active.profile_id == token.profile_id
                    && active.account_generation == token.account_generation
            }) else {
                return false;
            };
            active.request_state = request_state;
            state.projection = projection_for(state.active.as_ref(), notification_revision);
            state.projection.clone()
        };
        self.publish(&projection);
        true
    }

    async fn finish_token(
        &self,
        token: &FetchToken,
        reason: ContinuationTerminalReason,
        error_code: Option<String>,
        notify: bool,
    ) {
        let projection = {
            let mut state = self.state.lock().await;
            if !state.active.as_ref().is_some_and(|active| {
                active.id == token.session_id
                    && active.request_generation == token.request_generation
                    && active.provider_id == token.provider_id
                    && active.profile_id == token.profile_id
                    && active.account_generation == token.account_generation
            }) {
                return;
            }
            finish_locked(&mut state, reason, error_code, notify)
        };
        self.publish(&projection);
    }

    fn publish(&self, snapshot: &ContinuationSnapshot) {
        self.player
            .publish_api_event("continuation.changed", snapshot);
    }
}

fn projection_for(
    active: Option<&ActiveSession>,
    notification_revision: u64,
) -> ContinuationSnapshot {
    match active {
        Some(active) => ContinuationSnapshot {
            active: true,
            session_id: Some(active.id),
            provider_id: Some(active.provider_id.clone()),
            profile_id: Some(active.profile_id.clone()),
            kind: Some(active.kind),
            account_generation: Some(active.account_generation),
            cursor: Some(active.cursor.clone()),
            seen_count: active.seen.len(),
            consecutive_empty_batches: active.consecutive_empty_batches,
            request_state: active.request_state,
            terminal_reason: None,
            last_error_code: None,
            notification_revision,
        },
        None => ContinuationSnapshot {
            notification_revision,
            ..ContinuationSnapshot::default()
        },
    }
}

fn finish_locked(
    state: &mut ServiceState,
    reason: ContinuationTerminalReason,
    error_code: Option<String>,
    notify: bool,
) -> ContinuationSnapshot {
    let active = state.active.take();
    let notification_revision = state
        .projection
        .notification_revision
        .saturating_add(u64::from(notify));
    state.projection = ContinuationSnapshot {
        active: false,
        session_id: active.as_ref().map(|session| session.id),
        provider_id: active.as_ref().map(|session| session.provider_id.clone()),
        profile_id: active.as_ref().map(|session| session.profile_id.clone()),
        kind: active.as_ref().map(|session| session.kind),
        account_generation: active.as_ref().map(|session| session.account_generation),
        cursor: active.as_ref().map(|session| session.cursor.clone()),
        seen_count: active.as_ref().map_or(0, |session| session.seen.len()),
        consecutive_empty_batches: active
            .as_ref()
            .map_or(0, |session| session.consecutive_empty_batches),
        request_state: ContinuationRequestState::Idle,
        terminal_reason: Some(reason),
        last_error_code: error_code,
        notification_revision,
    };
    state.projection.clone()
}

fn track_key(provider_id: &str, profile_id: &str, track: &Song) -> Option<String> {
    match track.provider.as_ref() {
        Some(reference) if reference.provider_id != provider_id => None,
        Some(reference) if reference.profile_id != profile_id => None,
        Some(reference) if !reference.track_id.trim().is_empty() => Some(format!(
            "{}\0{}\0{}",
            provider_id,
            profile_id,
            reference.track_id.trim()
        )),
        _ if profile_id == DEFAULT_PROFILE_ID && !track.id.trim().is_empty() => Some(format!(
            "{}\0{}\0{}",
            provider_id,
            profile_id,
            track.id.trim()
        )),
        _ => None,
    }
}

fn retryable_recommendation_error(error: &ProviderCommandError) -> bool {
    error.retryable
        && matches!(
            error.code.as_str(),
            "offline" | "timeout" | "rate-limited" | "unavailable" | "provider-failure"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{PlaybackSourceError, PlaybackSourceResolver};
    use crate::player::{AlbumSummary, ArtistSummary, Artwork, AudioQuality, SongAvailability};
    use std::collections::VecDeque;
    use tokio::sync::Notify;

    struct FakeSource {
        generation: AtomicU64,
        batches: Mutex<VecDeque<Result<RecommendationBatch, ProviderCommandError>>>,
        requests: Mutex<Vec<RecommendationRequest>>,
        calls: AtomicU64,
        gate: Notify,
    }

    struct DeferredSource {
        generation: AtomicU64,
        started: Notify,
        release: Notify,
        batch: Mutex<Option<RecommendationBatch>>,
    }

    struct DelayedStartResolver {
        started: Arc<Notify>,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl PlaybackSourceResolver for DelayedStartResolver {
        async fn resolve(
            &self,
            song: &Song,
        ) -> Result<crate::media::ResolvedPlaybackSource, PlaybackSourceError> {
            if song.id == "slow" {
                self.started.notify_one();
                self.release.notified().await;
            }
            crate::media::TestPlaybackSourceResolver.resolve(song).await
        }
    }

    impl DeferredSource {
        fn new(batch: RecommendationBatch) -> Arc<Self> {
            Arc::new(Self {
                generation: AtomicU64::new(1),
                started: Notify::new(),
                release: Notify::new(),
                batch: Mutex::new(Some(batch)),
            })
        }
    }

    #[async_trait]
    impl ContinuationProviderSource for DeferredSource {
        fn account_generation(
            &self,
            profile: &ProviderProfileKey,
        ) -> Result<Option<u64>, ProviderCommandError> {
            Ok((profile.provider_id == "fake").then(|| self.generation.load(Ordering::Acquire)))
        }

        async fn next(
            &self,
            _profile: &ProviderProfileKey,
            _request: RecommendationRequest,
        ) -> Result<RecommendationBatch, ProviderCommandError> {
            self.started.notify_one();
            self.release.notified().await;
            Ok(self
                .batch
                .lock()
                .await
                .take()
                .unwrap_or(RecommendationBatch {
                    songs: Vec::new(),
                    next_cursor: None,
                    ended: true,
                }))
        }

        async fn remember_songs(
            &self,
            _profile: &ProviderProfileKey,
            _songs: &[Song],
        ) -> Result<(), ProviderCommandError> {
            Ok(())
        }
    }

    impl FakeSource {
        fn new(batches: impl IntoIterator<Item = RecommendationBatch>) -> Arc<Self> {
            Self::from_results(batches.into_iter().map(Ok))
        }

        fn from_results(
            batches: impl IntoIterator<Item = Result<RecommendationBatch, ProviderCommandError>>,
        ) -> Arc<Self> {
            Arc::new(Self {
                generation: AtomicU64::new(1),
                batches: Mutex::new(batches.into_iter().collect()),
                requests: Mutex::new(Vec::new()),
                calls: AtomicU64::new(0),
                gate: Notify::new(),
            })
        }
    }

    #[async_trait]
    impl ContinuationProviderSource for FakeSource {
        fn account_generation(
            &self,
            profile: &ProviderProfileKey,
        ) -> Result<Option<u64>, ProviderCommandError> {
            Ok((profile.provider_id == "fake").then(|| self.generation.load(Ordering::Acquire)))
        }

        async fn next(
            &self,
            _profile: &ProviderProfileKey,
            request: RecommendationRequest,
        ) -> Result<RecommendationBatch, ProviderCommandError> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            self.requests.lock().await.push(request);
            self.gate.notify_waiters();
            self.batches.lock().await.pop_front().unwrap_or_else(|| {
                Ok(RecommendationBatch {
                    songs: Vec::new(),
                    next_cursor: None,
                    ended: true,
                })
            })
        }

        async fn remember_songs(
            &self,
            _profile: &ProviderProfileKey,
            _songs: &[Song],
        ) -> Result<(), ProviderCommandError> {
            Ok(())
        }
    }

    fn song(id: &str, numeric_id: u64) -> Song {
        Song {
            id: id.to_owned(),
            title: id.to_owned(),
            artists: vec![ArtistSummary {
                id: "artist".to_owned(),
                name: "Artist".to_owned(),
            }],
            album: AlbumSummary {
                id: "album".to_owned(),
                title: "Album".to_owned(),
            },
            artwork: Artwork {
                src: "/cover.svg".to_owned(),
                alt: "Cover".to_owned(),
                dominant_color: "#000".to_owned(),
                variants: Vec::new(),
            },
            duration_ms: 10_000,
            track_number: 1,
            is_favorite: false,
            quality: AudioQuality::High,
            availability: SongAvailability::Available,
            audio_formats: Vec::new(),
            playback_capability: None,
            provider: Some(yaqmc_provider_api::ProviderTrackReference {
                provider_id: "fake".to_owned(),
                profile_id: DEFAULT_PROFILE_ID.to_owned(),
                track_id: id.to_owned(),
                numeric_id: Some(numeric_id),
                album_id: None,
                media_id: None,
            }),
        }
    }

    fn song_with_profile(id: &str, numeric_id: u64, profile_id: &str) -> Song {
        let mut track = song(id, numeric_id);
        track
            .provider
            .as_mut()
            .expect("test song has a provider reference")
            .profile_id = profile_id.to_owned();
        track
    }

    fn batch(ids: &[&str]) -> RecommendationBatch {
        RecommendationBatch {
            songs: ids
                .iter()
                .enumerate()
                .map(|(index, id)| song(id, index as u64 + 100))
                .collect(),
            next_cursor: Some("next".to_owned()),
            ended: false,
        }
    }

    async fn wait_for_calls(source: &FakeSource, expected: u64) {
        for _ in 0..100 {
            if source.calls.load(Ordering::Acquire) >= expected {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("recommendation call did not arrive");
    }

    #[tokio::test]
    async fn prefetches_at_two_remaining_and_deduplicates_atomically() {
        let source = FakeSource::new([batch(&["three", "four", "five", "six"])]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1), song("two", 2), song("three", 3)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        wait_for_calls(&source, 1).await;
        for _ in 0..100 {
            if player.snapshot().await.queue.len() == 6 {
                break;
            }
            tokio::task::yield_now().await;
        }
        let snapshot = player.snapshot().await;
        assert_eq!(
            snapshot
                .queue
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two", "three", "four", "five", "six"]
        );
        assert_eq!(service.snapshot().await.seen_count, 6);
    }

    #[tokio::test]
    async fn three_empty_deduplicated_batches_end_the_session() {
        let source = FakeSource::new([batch(&["one"]), batch(&["one"]), batch(&["one"])]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player, source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        wait_for_calls(&source, 3).await;
        for _ in 0..100 {
            if !service.snapshot().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }
        let snapshot = service.snapshot().await;
        assert!(!snapshot.active);
        assert_eq!(
            snapshot.terminal_reason,
            Some(ContinuationTerminalReason::EmptyBatches)
        );
    }

    #[tokio::test]
    async fn account_generation_change_rejects_the_session() {
        let source = FakeSource::new([batch(&["next"])]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player, source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![
                    song("one", 1),
                    song("two", 2),
                    song("three", 3),
                    song("four", 4),
                ],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        source.generation.store(2, Ordering::Release);
        service.observe_player().await;
        let snapshot = service.snapshot().await;
        assert!(!snapshot.active);
        assert_eq!(
            snapshot.terminal_reason,
            Some(ContinuationTerminalReason::AccountChanged)
        );
    }

    #[tokio::test]
    async fn queue_replacement_discards_a_late_provider_response() {
        let source = DeferredSource::new(batch(&["late"]));
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1), song("two", 2), song("three", 3)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        source.started.notified().await;
        player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("replacement", 9)],
                start_at_id: None,
                shuffle: Some(false),
            })
            .await
            .expect("queue replacement plays");
        source.release.notify_one();
        for _ in 0..100 {
            if !service.snapshot().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            player
                .snapshot()
                .await
                .queue
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            vec!["replacement"]
        );
        assert_eq!(
            service.snapshot().await.terminal_reason,
            Some(ContinuationTerminalReason::QueueReplaced)
        );
    }

    #[tokio::test]
    async fn concurrent_queue_replacement_prevents_a_stale_session_from_starting() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let player = Arc::new(PlayerService::with_runtime(
            Arc::new(crate::audio::TestAudioEngine::default()),
            Arc::new(DelayedStartResolver {
                started: Arc::clone(&started),
                release: Arc::clone(&release),
            }),
            Arc::new(crate::media::PassthroughMediaPreparer),
        ));
        let service = ContinuationService::with_source(Arc::clone(&player), FakeSource::new([]));
        let pending = {
            let service = Arc::clone(&service);
            tokio::spawn(async move {
                service
                    .start(ContinuationStartRequest {
                        provider_id: "fake".to_owned(),
                        profile_id: None,
                        kind: ContinuationKind::Guess,
                        tracks: vec![song("slow", 1)],
                        start_at_id: None,
                        seed_track_ids: Vec::new(),
                    })
                    .await
            })
        };
        started.notified().await;
        player
            .play_tracks(PlayTracksRequest {
                tracks: vec![song("replacement", 2)],
                start_at_id: None,
                shuffle: Some(false),
            })
            .await
            .expect("replacement queue plays");
        release.notify_one();

        assert!(matches!(
            pending.await.expect("start task joins"),
            Err(ContinuationError::QueueReplaced)
        ));
        assert!(!service.snapshot().await.active);
        assert_eq!(
            player
                .snapshot()
                .await
                .queue
                .first()
                .map(|track| track.id.as_str()),
            Some("replacement")
        );
    }

    #[tokio::test]
    async fn late_batch_after_eos_resumes_through_the_native_next_transition() {
        let source = DeferredSource::new(batch(&["two"]));
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        source.started.notified().await;
        player.next().await.expect("single-track queue reaches EOS");
        assert_eq!(player.snapshot().await.playback_state, PlaybackState::Ended);
        source.release.notify_one();
        for _ in 0..100 {
            let snapshot = player.snapshot().await;
            if snapshot.current_index == Some(1)
                && snapshot.playback_state == PlaybackState::Playing
            {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("late continuation batch did not resume playback");
    }

    #[tokio::test]
    async fn repeat_one_suppresses_prefetch_until_the_mode_changes() {
        let source = FakeSource::new([batch(&["two"])]);
        let player = Arc::new(PlayerService::new());
        player.set_repeat(RepeatMode::One).await;
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(source.calls.load(Ordering::Acquire), 0);
        player.set_repeat(RepeatMode::Off).await;
        service.observe_player().await;
        wait_for_calls(&source, 1).await;
    }

    #[tokio::test]
    async fn provider_final_batch_is_appended_before_the_session_ends() {
        let source = FakeSource::new([RecommendationBatch {
            songs: vec![song("final", 2)],
            next_cursor: None,
            ended: true,
        }]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        wait_for_calls(&source, 1).await;
        for _ in 0..100 {
            if !service.snapshot().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            player
                .snapshot()
                .await
                .queue
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "final"]
        );
        assert_eq!(
            service.snapshot().await.terminal_reason,
            Some(ContinuationTerminalReason::ProviderEnded)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retryable_failure_waits_then_recovers_without_mutating_the_queue_early() {
        let source = FakeSource::from_results([
            Err(ProviderCommandError {
                code: "timeout".to_owned(),
                message: "temporary timeout".to_owned(),
                retryable: true,
            }),
            Ok(batch(&["two"])),
        ]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        wait_for_calls(&source, 1).await;
        assert_eq!(player.snapshot().await.queue.len(), 1);
        assert_eq!(
            service.snapshot().await.request_state,
            ContinuationRequestState::Retrying
        );

        tokio::time::advance(Duration::from_secs(2)).await;
        wait_for_calls(&source, 2).await;
        for _ in 0..100 {
            if player.snapshot().await.queue.len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(player.snapshot().await.queue.len(), 2);
        assert!(service.snapshot().await.active);
    }

    #[tokio::test]
    async fn non_terminal_player_controls_and_queue_edits_preserve_the_session() {
        let source = FakeSource::new([]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![
                    song("one", 1),
                    song("two", 2),
                    song("three", 3),
                    song("four", 4),
                    song("five", 5),
                ],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");

        player.pause().await.expect("pause");
        player.seek(250).await.expect("seek");
        player.set_repeat(RepeatMode::All).await;
        player.set_shuffle(true).await;
        player.add_to_queue(song("manual", 99)).await;
        let last_entry = player
            .snapshot()
            .await
            .queue_entries
            .last()
            .expect("manual queue entry")
            .id
            .clone();
        player
            .reorder_queue_entry(&last_entry, 1)
            .await
            .expect("reorder");
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }

        assert!(service.snapshot().await.active);
        assert_eq!(source.calls.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn reaching_the_seen_track_cap_appends_the_last_allowed_song_then_ends() {
        let initial = (0..499)
            .map(|index| song(&format!("track-{index}"), index as u64 + 1))
            .collect::<Vec<_>>();
        let source = FakeSource::new([batch(&["track-499", "track-500"])]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: initial,
                start_at_id: Some("track-497".to_owned()),
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        wait_for_calls(&source, 1).await;
        for _ in 0..100 {
            if !service.snapshot().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(player.snapshot().await.queue.len(), MAX_SEEN_TRACKS);
        assert_eq!(
            player
                .snapshot()
                .await
                .queue
                .last()
                .map(|track| track.id.as_str()),
            Some("track-499")
        );
        assert_eq!(
            service.snapshot().await.terminal_reason,
            Some(ContinuationTerminalReason::SeenLimit)
        );
    }

    #[tokio::test]
    async fn guess_cursor_counts_the_provider_batch_while_the_player_filters_unavailable_tracks() {
        let source = FakeSource::new([batch(&["four", "five", "six"])]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source.clone());
        let mut unavailable = song("two", 2);
        unavailable.availability = SongAvailability::Unavailable {
            reason: "copyright".to_owned(),
        };
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1), unavailable, song("three", 3)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        wait_for_calls(&source, 1).await;
        for _ in 0..100 {
            if player.snapshot().await.queue.len() == 5 {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(source.requests.lock().await[0].cursor.as_deref(), Some("3"));
        assert_eq!(
            player
                .snapshot()
                .await
                .queue
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "three", "four", "five", "six"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn exhausted_retry_budget_stops_once_and_emits_one_notification_revision() {
        let errors = (0..4).map(|_| {
            Err(ProviderCommandError {
                code: "rate-limited".to_owned(),
                message: "try later".to_owned(),
                retryable: true,
            })
        });
        let source = FakeSource::from_results(errors);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player, source.clone());
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        wait_for_calls(&source, 1).await;
        for expected in 2..=4 {
            tokio::time::advance(Duration::from_secs(10)).await;
            wait_for_calls(&source, expected).await;
        }
        for _ in 0..100 {
            if !service.snapshot().await.active {
                break;
            }
            tokio::task::yield_now().await;
        }

        let snapshot = service.snapshot().await;
        assert!(!snapshot.active);
        assert_eq!(
            snapshot.terminal_reason,
            Some(ContinuationTerminalReason::ProviderError)
        );
        assert_eq!(snapshot.last_error_code.as_deref(), Some("rate-limited"));
        assert_eq!(snapshot.notification_revision, 1);
    }

    #[tokio::test]
    async fn legacy_start_defaults_to_default_profile_and_snapshot_serializes_it() {
        let source = FakeSource::new([]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player, source);
        let snapshot = service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("legacy session starts");

        assert_eq!(snapshot.profile_id.as_deref(), Some(DEFAULT_PROFILE_ID));
        assert_eq!(
            serde_json::to_value(snapshot).expect("snapshot serializes")["profileId"],
            DEFAULT_PROFILE_ID
        );
    }

    #[tokio::test]
    async fn end_for_profile_is_a_noop_without_an_active_session() {
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), FakeSource::new([]));
        let mut events = player.subscribe();
        let before = service.snapshot().await;
        let profile = ProviderProfileKey::new("fake", DEFAULT_PROFILE_ID).expect("valid profile");

        let after = service
            .end_for_profile(&profile, ContinuationTerminalReason::AccountChanged)
            .await;

        assert_eq!(after.active, before.active);
        assert_eq!(after.notification_revision, before.notification_revision);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn end_for_profile_ignores_a_foreign_provider() {
        let source = FakeSource::new([]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source);
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![
                    song("one", 1),
                    song("two", 2),
                    song("three", 3),
                    song("four", 4),
                    song("five", 5),
                ],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        let mut events = player.subscribe();
        let before = service.snapshot().await;
        let foreign = ProviderProfileKey::new("other", DEFAULT_PROFILE_ID).expect("valid profile");

        let after = service
            .end_for_profile(&foreign, ContinuationTerminalReason::AccountChanged)
            .await;

        assert_eq!(after.session_id, before.session_id);
        assert_eq!(after.provider_id.as_deref(), Some("fake"));
        assert!(after.active);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn end_for_profile_ignores_a_different_profile_for_the_same_provider() {
        let source = FakeSource::new([]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source);
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: Some("alternate".to_owned()),
                kind: ContinuationKind::Guess,
                tracks: vec![
                    song_with_profile("one", 1, "alternate"),
                    song_with_profile("two", 2, "alternate"),
                    song_with_profile("three", 3, "alternate"),
                    song_with_profile("four", 4, "alternate"),
                    song_with_profile("five", 5, "alternate"),
                ],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        let mut events = player.subscribe();
        let before = service.snapshot().await;
        let default_profile =
            ProviderProfileKey::new("fake", DEFAULT_PROFILE_ID).expect("valid profile");

        let after = service
            .end_for_profile(&default_profile, ContinuationTerminalReason::AccountChanged)
            .await;

        assert_eq!(after.session_id, before.session_id);
        assert_eq!(after.profile_id.as_deref(), Some("alternate"));
        assert!(after.active);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn end_for_profile_ends_exact_match_and_publishes_only_once() {
        let source = FakeSource::new([]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player.clone(), source);
        service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: Some("alternate".to_owned()),
                kind: ContinuationKind::Guess,
                tracks: vec![
                    song_with_profile("one", 1, "alternate"),
                    song_with_profile("two", 2, "alternate"),
                    song_with_profile("three", 3, "alternate"),
                    song_with_profile("four", 4, "alternate"),
                    song_with_profile("five", 5, "alternate"),
                ],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        let mut events = player.subscribe();
        let profile = ProviderProfileKey::new("fake", "alternate").expect("valid profile");

        let (first, second) = tokio::join!(
            service.end_for_profile(&profile, ContinuationTerminalReason::AccountChanged),
            service.end_for_profile(&profile, ContinuationTerminalReason::AccountChanged),
        );
        assert!(!first.active);
        assert!(!second.active);
        assert_eq!(first.session_id, second.session_id);
        let ended = first;
        assert_eq!(
            ended.terminal_reason,
            Some(ContinuationTerminalReason::AccountChanged)
        );
        let event = events
            .recv()
            .await
            .expect("exact match publishes one event");
        assert_eq!(event.event_type, "continuation.changed");
        assert!(events.try_recv().is_err());

        let no_op = service
            .end_for_profile(&profile, ContinuationTerminalReason::AccountChanged)
            .await;
        assert_eq!(no_op.session_id, ended.session_id);
        assert_eq!(no_op.terminal_reason, ended.terminal_reason);
        assert_eq!(no_op.notification_revision, ended.notification_revision);
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn fake_source_can_declare_and_route_an_alternate_profile() {
        let source = FakeSource::new([]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player, source);
        let snapshot = service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: Some("alternate".to_owned()),
                kind: ContinuationKind::Guess,
                tracks: vec![song_with_profile("alternate-track", 1, "alternate")],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("fake source accepts its declared alternate profile");

        assert_eq!(snapshot.profile_id.as_deref(), Some("alternate"));
    }

    #[test]
    fn same_provider_track_in_different_profiles_has_distinct_identity() {
        let default_track = song("same", 1);
        let alternate_track = song_with_profile("same", 1, "alternate");
        assert_ne!(
            track_key("fake", DEFAULT_PROFILE_ID, &default_track),
            track_key("fake", "alternate", &alternate_track)
        );
    }

    #[test]
    fn legacy_song_without_provider_reference_only_matches_default_profile() {
        let mut legacy = song("legacy", 1);
        legacy.provider = None;
        assert!(track_key("fake", DEFAULT_PROFILE_ID, &legacy).is_some());
        assert!(track_key("fake", "alternate", &legacy).is_none());
    }

    #[tokio::test]
    async fn stale_fetch_token_is_rejected_when_profile_or_generation_changes() {
        let source = FakeSource::new([batch(&["four"])]);
        let player = Arc::new(PlayerService::new());
        let service = ContinuationService::with_source(player, source);
        let snapshot = service
            .start(ContinuationStartRequest {
                provider_id: "fake".to_owned(),
                profile_id: None,
                kind: ContinuationKind::Guess,
                tracks: vec![song("one", 1), song("two", 2), song("three", 3)],
                start_at_id: None,
                seed_track_ids: Vec::new(),
            })
            .await
            .expect("session starts");
        let token = FetchToken {
            session_id: snapshot.session_id.expect("session ID"),
            request_generation: 1,
            provider_id: "fake".to_owned(),
            profile_id: DEFAULT_PROFILE_ID.to_owned(),
            account_generation: 1,
            request: RecommendationRequest {
                kind: RecommendationKind::Guess,
                limit: DEFAULT_BATCH_SIZE,
                cursor: Some("3".to_owned()),
                seeds: Vec::new(),
            },
        };
        assert!(service.token_is_current(&token).await);

        service
            .state
            .lock()
            .await
            .active
            .as_mut()
            .unwrap()
            .profile_id = "alternate".to_owned();
        assert!(!service.token_is_current(&token).await);
        service
            .state
            .lock()
            .await
            .active
            .as_mut()
            .unwrap()
            .profile_id = DEFAULT_PROFILE_ID.to_owned();
        service
            .state
            .lock()
            .await
            .active
            .as_mut()
            .unwrap()
            .account_generation = 2;
        assert!(!service.token_is_current(&token).await);
    }

    #[test]
    fn retry_policy_excludes_auth_schema_entitlement_and_unsupported_errors() {
        for code in [
            "authentication-expired",
            "authorization-rejected",
            "schema-changed",
            "entitlement-unavailable",
            "unsupported-operation",
        ] {
            assert!(!retryable_recommendation_error(&ProviderCommandError {
                code: code.to_owned(),
                message: String::new(),
                retryable: true,
            }));
        }
        assert!(retryable_recommendation_error(&ProviderCommandError {
            code: "timeout".to_owned(),
            message: String::new(),
            retryable: true,
        }));
    }

    #[test]
    fn continuation_provider_error_preserves_the_full_provider_error() {
        let original = ProviderCommandError {
            code: "timeout".to_owned(),
            message: "temporary recommendation backend outage".to_owned(),
            retryable: true,
        };

        let ContinuationError::ProviderCommand(mapped) = continuation_provider_error(original)
        else {
            panic!("provider errors must remain structured");
        };
        assert_eq!(mapped.code, "timeout");
        assert_eq!(mapped.message, "temporary recommendation backend outage");
        assert!(mapped.retryable);
    }
}
