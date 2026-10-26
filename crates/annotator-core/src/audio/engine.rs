//! SPSC device boundary. Only the producer and one device callback use each buffer.
//! Atomic slots avoid unsafe shared memory; release/acquire indices publish whole frames.
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    Arc,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransportState {
    Stopped,
    Buffering,
    Playing,
    Paused,
    Ended,
    Error,
}
pub struct PlaybackState {
    pub first: u64,
    pub end: u64,
    pub position: u64,
    pub start: u64,
    pub state: TransportState,
}
impl PlaybackState {
    pub fn new(first: u64, end: u64, position: u64) -> Self {
        Self {
            first,
            end,
            position: position.clamp(first, end),
            start: position.clamp(first, end),
            state: TransportState::Stopped,
        }
    }
    pub fn play(&mut self) {
        if self.state == TransportState::Ended {
            self.position = self.first;
        }
        if matches!(
            self.state,
            TransportState::Stopped | TransportState::Ended | TransportState::Error
        ) {
            self.start = self.position;
        }
        self.state = TransportState::Playing;
    }
    pub fn pause(&mut self) {
        self.state = TransportState::Paused;
    }
    pub fn stop(&mut self) {
        self.position = self.start;
        self.state = TransportState::Stopped;
    }
    pub fn seek(&mut self, frame: u64) {
        self.position = frame.clamp(self.first, self.end);
        if self.state == TransportState::Ended {
            self.state = TransportState::Stopped;
        }
        if self.state == TransportState::Stopped {
            self.start = self.position;
        }
    }
    pub fn consumed(&mut self, frame: u64) {
        self.position = frame.clamp(self.first, self.end);
    }
    pub fn end(&mut self) {
        self.position = self.end;
        self.state = TransportState::Ended;
    }
}
struct Slot {
    left: AtomicU32,
    right: AtomicU32,
    source: AtomicU64,
}
pub struct OutputBuffer {
    slots: Box<[Slot]>,
    monitor_scalar: AtomicU32,
    read: AtomicUsize,
    write: AtomicUsize,
    epoch: Arc<AtomicU64>,
    generation: u64,
    playing: AtomicBool,
    eof: AtomicBool,
    position: AtomicU64,
    consumed: AtomicU64,
    underruns: AtomicU64,
    clock_valid: AtomicBool,
    scheduled_frames: AtomicU64,
    callback_nanos: AtomicU64,
    tail_nanos: AtomicU64,
    pending_tail_frames: AtomicU64,
    tail_non_silent: AtomicBool,
    ring_exhausted_nanos: AtomicU64,
    pub device_failed: AtomicBool,
}
impl OutputBuffer {
    pub fn new(capacity: usize, epoch: Arc<AtomicU64>, generation: u64, start: u64) -> Self {
        assert!(capacity > 0);
        Self {
            monitor_scalar: AtomicU32::new(1.0_f32.to_bits()),
            slots: (0..capacity)
                .map(|_| Slot {
                    left: AtomicU32::new(0),
                    right: AtomicU32::new(0),
                    source: AtomicU64::new(0),
                })
                .collect(),
            read: AtomicUsize::new(0),
            write: AtomicUsize::new(0),
            epoch,
            generation,
            playing: AtomicBool::new(false),
            eof: AtomicBool::new(false),
            position: AtomicU64::new(start),
            consumed: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            clock_valid: AtomicBool::new(false),
            scheduled_frames: AtomicU64::new(0),
            callback_nanos: AtomicU64::new(0),
            tail_nanos: AtomicU64::new(0),
            pending_tail_frames: AtomicU64::new(0),
            tail_non_silent: AtomicBool::new(false),
            ring_exhausted_nanos: AtomicU64::new(u64::MAX),
            device_failed: AtomicBool::new(false),
        }
    }
    pub fn set_monitor_gain_db(&self, db: f64) -> crate::error::Result<()> {
        if !db.is_finite() || !(-60.0..=24.0).contains(&db) {
            return Err(crate::error::AppError::invalid("Invalid monitor gain"));
        }
        self.monitor_scalar.store(
            (10.0_f64.powf(db / 20.0) as f32).to_bits(),
            Ordering::Release,
        );
        Ok(())
    }
    pub fn monitor_scalar(&self) -> f32 {
        f32::from_bits(self.monitor_scalar.load(Ordering::Acquire))
    }
    pub fn free(&self) -> usize {
        self.slots.len()
            - self
                .write
                .load(Ordering::Acquire)
                .wrapping_sub(self.read.load(Ordering::Acquire))
    }
    pub fn push(&self, frame: [f32; 2], source: u64) -> bool {
        let w = self.write.load(Ordering::Relaxed);
        if w.wrapping_sub(self.read.load(Ordering::Acquire)) == self.slots.len() {
            return false;
        }
        let s = &self.slots[w % self.slots.len()];
        s.left.store(clean(frame[0]).to_bits(), Ordering::Relaxed);
        s.right.store(clean(frame[1]).to_bits(), Ordering::Relaxed);
        s.source.store(source, Ordering::Relaxed);
        self.write.store(w.wrapping_add(1), Ordering::Release);
        true
    }
    /// Real-time callback: no locks, allocation, I/O, DSP, or event emission.
    pub fn consume(&self) -> [f32; 2] {
        self.consume_frame().unwrap_or([0.0; 2])
    }
    /// None is callback silence, distinct from a real source frame containing zeroes.
    pub fn consume_frame(&self) -> Option<[f32; 2]> {
        if !self.playing.load(Ordering::Acquire)
            || self.epoch.load(Ordering::Acquire) != self.generation
        {
            return None;
        }
        let r = self.read.load(Ordering::Relaxed);
        if r == self.write.load(Ordering::Acquire) {
            if !self.eof.load(Ordering::Acquire) {
                self.underruns.fetch_add(1, Ordering::Relaxed);
            }
            return None;
        }
        let s = &self.slots[r % self.slots.len()];
        let out = [
            f32::from_bits(s.left.load(Ordering::Relaxed)),
            f32::from_bits(s.right.load(Ordering::Relaxed)),
        ];
        self.position
            .store(s.source.load(Ordering::Relaxed), Ordering::Release);
        self.consumed.fetch_add(1, Ordering::Relaxed);
        self.read.store(r.wrapping_add(1), Ordering::Release);
        Some(out)
    }
    pub fn set_playing(&self, value: bool) {
        self.playing.store(value, Ordering::Release);
    }
    pub fn finish(&self) {
        self.eof.store(true, Ordering::Release);
    }
    pub fn ring_exhausted(&self) -> bool {
        self.eof.load(Ordering::Acquire)
            && self.read.load(Ordering::Acquire) == self.write.load(Ordering::Acquire)
    }
    /// A drained application ring is not a presented device buffer. The worker may
    /// release the stream only after a later callback proves the scheduled tail passed.
    pub fn ended(&self) -> bool {
        if !self.ring_exhausted() || self.device_failed.load(Ordering::Acquire) {
            return false;
        }
        let consumed = self.consumed.load(Ordering::Acquire);
        if consumed == 0 {
            return true;
        } // Seeking to EOF has no output obligation.
        self.clock_valid.load(Ordering::Acquire)
            && self.scheduled_frames.load(Ordering::Acquire) == consumed
            && self.pending_tail_frames.load(Ordering::Acquire) == 0
            && self.callback_nanos.load(Ordering::Acquire)
                >= self.tail_nanos.load(Ordering::Acquire)
    }
    pub fn presentation(&self) -> PresentationStatus {
        let drained = self.ended();
        let valid = self.clock_valid.load(Ordering::Acquire);
        let scheduled = self.scheduled_frames.load(Ordering::Acquire);
        let exhausted = self.ring_exhausted_nanos.load(Ordering::Acquire);
        PresentationStatus {
            ring_exhausted: self.ring_exhausted(),
            scheduled_frames: scheduled,
            callback_nanos: valid.then(|| self.callback_nanos.load(Ordering::Acquire)),
            tail_nanos: (scheduled > 0).then(|| self.tail_nanos.load(Ordering::Acquire)),
            ring_exhausted_nanos: (exhausted != u64::MAX).then_some(exhausted),
            pending_tail_frames: self.pending_tail_frames.load(Ordering::Acquire),
            tail_non_silent: self.tail_non_silent.load(Ordering::Acquire),
            drained,
        }
    }
    pub fn position(&self) -> u64 {
        self.position.load(Ordering::Acquire)
    }
    pub fn consumed(&self) -> u64 {
        self.consumed.load(Ordering::Relaxed)
    }
    pub fn underruns(&self) -> u64 {
        self.underruns.load(Ordering::Relaxed)
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationStatus {
    pub ring_exhausted: bool,
    pub scheduled_frames: u64,
    pub callback_nanos: Option<u64>,
    pub tail_nanos: Option<u64>,
    pub ring_exhausted_nanos: Option<u64>,
    pub pending_tail_frames: u64,
    pub tail_non_silent: bool,
    pub drained: bool,
}
#[derive(Clone, Copy)]
pub struct OutputTiming {
    pub callback_nanos: u64,
    pub playback_nanos: u64,
}
pub struct SubmittedTail {
    pub frame_end: usize,
    pub non_silent: bool,
}
/// Owned solely by the callback; constant space, no locks or allocation.
#[derive(Default)]
pub struct PresentationTracker {
    capacity: Option<usize>,
    pending_tail_frames: u64,
}
impl PresentationTracker {
    pub fn record(
        &mut self,
        out: &OutputBuffer,
        time: OutputTiming,
        frames: usize,
        rate: u32,
        tail: Option<SubmittedTail>,
    ) {
        let capacity = *self.capacity.get_or_insert(frames);
        if rate == 0
            || frames == 0
            || frames > capacity
            || time.playback_nanos < time.callback_nanos
            || (out.clock_valid.load(Ordering::Acquire)
                && time.callback_nanos < out.callback_nanos.load(Ordering::Acquire))
            || tail
                .as_ref()
                .is_some_and(|t| t.frame_end == 0 || t.frame_end > frames)
        {
            out.device_failed.store(true, Ordering::Release);
            return;
        }
        // Locked CPAL 0.15.3 WASAPI: the first callback has an empty client buffer
        // (no prefill), hence frames == GetBufferSize. Later callbacks expose
        // GetBufferSize - GetCurrentPadding, i.e. newly writable/retired frames.
        self.pending_tail_frames = self.pending_tail_frames.saturating_sub(frames as u64);
        if let Some(tail) = tail {
            let padding = capacity - frames;
            let duration =
                |n: usize| u64::try_from((n as u128 * 1_000_000_000).div_ceil(rate as u128)).ok();
            let deadline = duration(padding)
                .and_then(|d| time.callback_nanos.checked_add(d))
                .map(|padding_start| padding_start.max(time.playback_nanos))
                .and_then(|start| duration(tail.frame_end).and_then(|d| start.checked_add(d)));
            let Some(deadline) = deadline else {
                out.device_failed.store(true, Ordering::Release);
                return;
            };
            self.pending_tail_frames = (padding + tail.frame_end) as u64;
            // CPAL's playback prediction alone can underestimate WASAPI padding.
            // Require both the later timestamp boundary and observed queue retirement.
            out.tail_nanos.store(deadline, Ordering::Relaxed);
            out.tail_non_silent
                .store(tail.non_silent, Ordering::Relaxed);
            out.pending_tail_frames
                .store(self.pending_tail_frames, Ordering::Relaxed);
            // Release publishes the deadline only after *all* callback frame writes.
            out.scheduled_frames
                .store(out.consumed(), Ordering::Release);
        } else {
            out.pending_tail_frames
                .store(self.pending_tail_frames, Ordering::Release);
        }
        out.callback_nanos
            .store(time.callback_nanos, Ordering::Release);
        if out.ring_exhausted()
            && out.consumed() > 0
            && out.scheduled_frames.load(Ordering::Acquire) == out.consumed()
        {
            let _ = out.ring_exhausted_nanos.compare_exchange(
                u64::MAX,
                time.callback_nanos,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        out.clock_valid.store(true, Ordering::Release);
    }
}
fn clean(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}
