//! Playback session identity, snapshot revisions, and latest-wins seek intents.
//!
//! A session starts when the authoritative current queue entry is loaded. Async
//! completions from an older session must not mutate the current track, lyrics,
//! position, or source. Within a session, seek intents are identified by a
//! monotonic revision so an older seek cannot restore an earlier position.

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

/// Latest-wins seek slot shared by the player service.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeekIntent {
    pub session_id: u64,
    pub revision: u64,
    pub position_ms: u64,
}

#[derive(Debug)]
pub struct SeekMailbox {
    revision: AtomicU64,
    slot: Mutex<Option<SeekIntent>>,
}

impl Default for SeekMailbox {
    fn default() -> Self {
        Self {
            revision: AtomicU64::new(0),
            slot: Mutex::new(None),
        }
    }
}

impl SeekMailbox {
    pub fn publish(&self, session_id: u64, position_ms: u64) -> SeekIntent {
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        let intent = SeekIntent {
            session_id,
            revision,
            position_ms,
        };
        *self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(intent);
        intent
    }

    pub fn current_revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    pub fn latest(&self) -> Option<SeekIntent> {
        *self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn is_current(&self, intent: SeekIntent, session_id: u64) -> bool {
        intent.session_id == session_id && intent.revision == self.current_revision()
    }

    pub fn invalidate(&self) {
        *self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.revision.fetch_add(1, Ordering::AcqRel);
    }
}

pub fn snapshot_is_stale(
    incoming_session: u64,
    incoming_revision: u64,
    accepted_session: u64,
    accepted_revision: u64,
) -> bool {
    incoming_session < accepted_session
        || (incoming_session == accepted_session && incoming_revision < accepted_revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_seek_intent_wins() {
        let mailbox = SeekMailbox::default();
        let first = mailbox.publish(7, 1_000);
        let second = mailbox.publish(7, 12_000);
        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 2);
        assert_eq!(mailbox.latest(), Some(second));
        assert!(!mailbox.is_current(first, 7));
        assert!(mailbox.is_current(second, 7));
    }

    #[test]
    fn session_change_invalidates_older_seeks() {
        let mailbox = SeekMailbox::default();
        let intent = mailbox.publish(3, 4_000);
        mailbox.invalidate();
        assert!(!mailbox.is_current(intent, 3));
        assert!(!mailbox.is_current(intent, 4));
    }

    #[test]
    fn older_snapshot_revisions_are_stale() {
        assert!(snapshot_is_stale(1, 10, 2, 1));
        assert!(snapshot_is_stale(2, 3, 2, 4));
        assert!(!snapshot_is_stale(2, 4, 2, 4));
        assert!(!snapshot_is_stale(3, 0, 2, 99));
    }
}
