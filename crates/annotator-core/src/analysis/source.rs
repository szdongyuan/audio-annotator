//! Source-rate, unmixed analysis input. Processing uses the playback DSP, never
//! a selection/output renderer. Every job retains at most nine mono blocks:
//! enough for a 32768-frame window crossing a block boundary.
use crate::{
    audio::{DspProcessor, PlaybackMode, SourceInfo, MAX_BLOCK_FRAMES},
    error::{AppError, Result},
    media::identity::check_cancel,
    model::{EditOperation, SpectralEdit},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, sync::atomic::AtomicBool};

pub const PROCESSED_CACHE_BYTES: usize = 9 * MAX_BLOCK_FRAMES * 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisSource {
    Original,
    Processed,
}

/// Shared with analysisSource.ts: sorted channel/version/IEEE754-bit operation
/// records, with zero normalized. Masks deduplicate; repeated gains accumulate.
/// Only enabled edits for this file contribute; IDs/order/notes do not.
pub fn canonical_edits(media_id: &str, edits: &[SpectralEdit]) -> String {
    let mut records: Vec<_> = edits
        .iter()
        .filter(|e| e.enabled && e.region.media_id == media_id)
        .map(|e| {
            let r = &e.region;
            let bits = |v: f64| format!("{:016x}", if v == 0. { 0 } else { v.to_bits() });
            format!(
                "{}|{}|{}|{}|{}|{}|{}",
                r.channel_index,
                e.processing_version,
                bits(r.start_seconds),
                bits(r.end_seconds),
                bits(r.low_hz),
                bits(r.high_hz),
                match e.operation {
                    EditOperation::Mask => "mask".into(),
                    EditOperation::Gain { gain_db } => format!("gain:{}", bits(gain_db)),
                }
            )
        })
        .collect();
    records.sort();
    records.dedup_by(|a, b| a == b && a.ends_with("|mask"));
    format!("analysis-edits-v2|{}", records.join(";"))
}
pub fn edit_signature(media_id: &str, edits: &[SpectralEdit]) -> String {
    format!("{:x}", Sha256::digest(canonical_edits(media_id, edits)))
}
impl AnalysisSource {
    pub fn signature(self, media_id: &str, edits: &[SpectralEdit]) -> String {
        match self {
            Self::Original => String::new(),
            Self::Processed => edit_signature(media_id, edits),
        }
    }
}

pub struct SourceReader {
    dsp: DspProcessor,
    channel: usize,
    blocks: VecDeque<(u64, Vec<f32>)>,
}
impl SourceReader {
    pub fn new(
        info: SourceInfo,
        source: AnalysisSource,
        version: u32,
        edits: &[SpectralEdit],
        channel: u8,
    ) -> Result<Self> {
        if usize::from(channel) >= info.channel_count {
            return Err(AppError::invalid("分析通道越界"));
        }
        let mode = match source {
            AnalysisSource::Original => PlaybackMode::Original,
            AnalysisSource::Processed => PlaybackMode::Processed,
        };
        Ok(Self {
            dsp: DspProcessor::new(info, version, mode, edits)?,
            channel: usize::from(channel),
            blocks: VecDeque::new(),
        })
    }
    pub fn resident_bytes(&self) -> usize {
        self.blocks.iter().map(|(_, b)| b.len() * 4).sum()
    }
    pub fn read_channel(
        &mut self,
        start: u64,
        count: usize,
        cancel: &AtomicBool,
        mut read: impl FnMut(u64, usize) -> Result<Vec<f32>>,
    ) -> Result<Vec<f32>> {
        check_cancel(cancel)?;
        if count > 32768
            || start
                .checked_add(count as u64)
                .is_none_or(|end| end > self.dsp.frame_count())
        {
            return Err(AppError::invalid("分析 PCM 窗口越界"));
        }
        let end = start + count as u64;
        let mut cursor = start;
        let mut result = Vec::with_capacity(count);
        while cursor < end {
            check_cancel(cancel)?;
            let first = cursor / MAX_BLOCK_FRAMES as u64 * MAX_BLOCK_FRAMES as u64;
            let block = if let Some(index) = self.blocks.iter().position(|(s, _)| *s == first) {
                self.blocks.remove(index).unwrap()
            } else {
                // Evict before allocating the next retained block, not after.
                if self.blocks.len() == 9 {
                    self.blocks.pop_front();
                }
                let n = (self.dsp.frame_count() - first).min(MAX_BLOCK_FRAMES as u64) as usize;
                let channels = self.dsp.channel_count();
                let interleaved = self.dsp.read_frames(first, n, |s, n| {
                    check_cancel(cancel)?;
                    read(s, n)
                })?;
                check_cancel(cancel)?;
                (
                    first,
                    interleaved
                        .chunks_exact(channels)
                        .map(|frame| frame[self.channel])
                        .collect(),
                )
            };
            let offset = (cursor - first) as usize;
            let take = (end - cursor).min((block.1.len() - offset) as u64) as usize;
            result.extend_from_slice(&block.1[offset..offset + take]);
            self.blocks.push_back(block);
            cursor += take as u64;
        }
        check_cancel(cancel)?;
        Ok(result)
    }
}
