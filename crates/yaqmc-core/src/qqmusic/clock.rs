use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

pub(crate) struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64
    }
}

#[cfg(test)]
pub(crate) struct ManualClock {
    now_ms: std::sync::atomic::AtomicU64,
}

#[cfg(test)]
impl ManualClock {
    pub(crate) fn new(now_ms: u64) -> Self {
        Self {
            now_ms: std::sync::atomic::AtomicU64::new(now_ms),
        }
    }

    pub(crate) fn advance(&self, duration_ms: u64) {
        self.now_ms
            .fetch_add(duration_ms, std::sync::atomic::Ordering::AcqRel);
    }
}

#[cfg(test)]
impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.now_ms.load(std::sync::atomic::Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_clock_advances_deterministically() {
        let clock = ManualClock::new(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance(250);
        assert_eq!(clock.now_ms(), 1_250);
    }
}
