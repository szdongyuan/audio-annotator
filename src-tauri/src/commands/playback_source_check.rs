use annotator_core::error::Result;
use std::time::{Duration, Instant};

/// Source metadata is on NAS; never stat it once per 4096-frame PCM block.
/// Verify on first use, then at the same 250 ms cadence while producing/paused.
pub(super) struct SourceCheck(Option<Instant>);
impl SourceCheck {
    pub(super) fn new() -> Self {
        Self(None)
    }
    pub(super) fn verify(
        &mut self,
        now: Instant,
        verify: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        if self
            .0
            .is_none_or(|last| now.saturating_duration_since(last) >= Duration::from_millis(250))
        {
            verify()?;
            self.0 = Some(now);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_initially_then_on_cadence_and_propagates_missing_or_changed_source() {
        let mut check = SourceCheck::new();
        let now = Instant::now();
        let mut calls = 0;
        for ms in 0..1000 {
            check
                .verify(now + Duration::from_millis(ms), || {
                    calls += 1;
                    Ok(())
                })
                .unwrap();
        }
        assert_eq!(calls, 4);
        let changed = || Err(annotator_core::error::AppError::invalid("changed"));
        assert!(check.verify(now + Duration::from_secs(1), changed).is_err());
        // Failed checks do not become a successful cache entry.
        assert!(check.verify(now + Duration::from_secs(1), changed).is_err());
    }
}
