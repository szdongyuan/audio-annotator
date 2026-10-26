use super::mask;
use crate::{
    error::{AppError, ErrorCode, Result},
    model::{EditOperation, Region, SpectralEdit},
};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const DSP_VERSION: u32 = 2;
pub const FFT_SIZE: usize = 2048;
pub const HOP_SIZE: usize = 512;
pub const MAX_BLOCK_FRAMES: usize = 4096;

#[derive(Clone, Debug)]
pub struct SourceInfo {
    pub media_id: String,
    pub sample_rate: u32,
    pub frame_count: u64,
    pub channel_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectionSource {
    Original,
    Processed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum PlaybackMode {
    Original,
    Processed,
    Selection {
        region: Region,
        #[serde(rename = "selectionSource")]
        source: SelectionSource,
    },
}

/// Random-access, bounded OLA renderer. Each read includes the globally aligned
/// windows intersecting its output. This repeats a small halo at block boundaries,
/// but needs no full-file buffer or warm-up from time zero after a seek. The source
/// callback can directly call `PcmCache::read_frames`; FFT reads need at most 2048
/// frames and original-mode reads at most 4096 frames.
/// Call on a background worker, never on an audio device callback.
pub struct DspProcessor {
    info: SourceInfo,
    mode: PlaybackMode,
    edits: Vec<SpectralEdit>,
    first: u64,
    end: u64,
    window: Vec<f64>,
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
}

impl DspProcessor {
    pub fn new(
        info: SourceInfo,
        version: u32,
        mode: PlaybackMode,
        edits: &[SpectralEdit],
    ) -> Result<Self> {
        if version != DSP_VERSION {
            return Err(version_error());
        }
        if info.media_id.is_empty()
            || info.sample_rate == 0
            || !(1..=6).contains(&info.channel_count)
            || info.frame_count == 0
            || info.frame_count > (i64::MAX - 2 * FFT_SIZE as i64) as u64
        {
            return Err(AppError::invalid("Invalid DSP source metadata"));
        }
        let mut matching = Vec::new();
        for edit in edits.iter().filter(|e| e.region.media_id == info.media_id) {
            if edit.processing_version != DSP_VERSION {
                return Err(version_error());
            }
            validate_region(&edit.region, &info)?;
            edit.operation.validate()?;
            if edit.enabled {
                matching.push(edit.clone());
            }
        }
        let (first, end) = if let PlaybackMode::Selection { region, .. } = &mode {
            validate_region(region, &info)?;
            // Samples whose timestamps lie in [start,end); round upward at both edges.
            let first = (region.start_seconds * info.sample_rate as f64).ceil() as u64;
            let end = ((region.end_seconds * info.sample_rate as f64).ceil() as u64)
                .min(info.frame_count);
            if first >= end {
                return Err(AppError::invalid("Selection contains no sample frames"));
            }
            (first, end)
        } else {
            (0, info.frame_count)
        };
        let mut planner = FftPlanner::new();
        Ok(Self {
            info,
            mode,
            edits: matching,
            first,
            end,
            window: (0..FFT_SIZE)
                .map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / FFT_SIZE as f64).cos())
                .collect(),
            forward: planner.plan_fft_forward(FFT_SIZE),
            inverse: planner.plan_fft_inverse(FFT_SIZE),
        })
    }
    pub fn frame_count(&self) -> u64 {
        self.end - self.first
    }
    pub fn channel_count(&self) -> usize {
        if matches!(self.mode, PlaybackMode::Selection { .. }) {
            1
        } else {
            self.info.channel_count
        }
    }
    pub fn sample_rate(&self) -> u32 {
        self.info.sample_rate
    }
    /// Output frame zero maps to this original-media position, including selection cropping.
    pub fn source_start_frame(&self) -> u64 {
        self.first
    }

    pub fn read_frames<F>(&mut self, start: u64, count: usize, mut read: F) -> Result<Vec<f32>>
    where
        F: FnMut(u64, usize) -> Result<Vec<f32>>,
    {
        if count > MAX_BLOCK_FRAMES {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "DSP blocks are limited to 4096 frames",
            ));
        }
        if start
            .checked_add(count as u64)
            .is_none_or(|e| e > self.frame_count())
        {
            return Err(AppError::invalid("DSP frame range out of bounds"));
        }
        if count == 0 {
            return Ok(Vec::new());
        }
        let begin = (self.first + start) as i64;
        let end = begin + count as i64;
        if matches!(self.mode, PlaybackMode::Original) {
            let input = read(begin as u64, count)?;
            validate_samples(&input, count * self.info.channel_count)?;
            return Ok(input);
        }
        let channels = self.channel_count();
        let mut sum = vec![0.0; count * channels];
        let mut weights = vec![0.0; count];
        let mut spectrum = vec![Complex::new(0.0, 0.0); FFT_SIZE];
        let mut scratch = vec![
            Complex::new(0.0, 0.0);
            self.forward
                .get_inplace_scratch_len()
                .max(self.inverse.get_inplace_scratch_len())
        ];
        // Virtual zero padding begins at -N and extends through length+N. Only
        // windows intersecting the exact original output crop contribute.
        let mut frame =
            ((begin - FFT_SIZE as i64).div_euclid(HOP_SIZE as i64) + 1) * HOP_SIZE as i64;
        while frame < end {
            let a = frame.max(0) as u64;
            let b = (frame + FFT_SIZE as i64)
                .max(0)
                .min(self.info.frame_count as i64) as u64;
            let input = if b > a {
                read(a, (b - a) as usize)?
            } else {
                Vec::new()
            };
            validate_samples(&input, (b - a) as usize * self.info.channel_count)?;
            let from = begin.max(frame);
            let to = end.min(frame + FFT_SIZE as i64);
            for pos in from..to {
                weights[(pos - begin) as usize] += self.window[(pos - frame) as usize].powi(2);
            }
            for out_channel in 0..channels {
                let source_channel = match &self.mode {
                    PlaybackMode::Selection { region, .. } => region.channel_index as usize,
                    _ => out_channel,
                };
                spectrum.fill(Complex::new(0.0, 0.0));
                for pos in a..b {
                    let local = (pos as i64 - frame) as usize;
                    spectrum[local].re =
                        input[(pos - a) as usize * self.info.channel_count + source_channel] as f64
                            * self.window[local];
                }
                self.forward
                    .process_with_scratch(&mut spectrum, &mut scratch);
                let applies = matches!(
                    self.mode,
                    PlaybackMode::Processed
                        | PlaybackMode::Selection {
                            source: SelectionSource::Processed,
                            ..
                        }
                );
                let edits: Vec<_> = self
                    .edits
                    .iter()
                    .filter(|e| e.region.channel_index as usize == source_channel)
                    .collect();
                let time = (frame + FFT_SIZE as i64 / 2) as f64 / self.info.sample_rate as f64;
                for bin in 0..=FFT_SIZE / 2 {
                    let hz = bin as f64 * self.info.sample_rate as f64 / FFT_SIZE as f64;
                    let mut gain = if applies {
                        {
                            let mut suppression = 0.0_f64;
                            let mut db = 0.0_f64;
                            for edit in &edits {
                                let weight = mask::time_weight(&edit.region, time)
                                    * mask::frequency_weight(
                                        &edit.region,
                                        hz,
                                        self.info.sample_rate,
                                    );
                                match edit.operation {
                                    EditOperation::Mask => suppression = suppression.max(weight),
                                    EditOperation::Gain { gain_db } => db += weight * gain_db,
                                }
                            }
                            (1.0 - suppression) * 10.0_f64.powf(db.clamp(-120.0, 48.0) / 20.0)
                        }
                    } else {
                        1.0
                    };
                    if let PlaybackMode::Selection { region, .. } = &self.mode {
                        gain *= mask::frequency_weight(region, hz, self.info.sample_rate);
                    }
                    spectrum[bin] *= gain;
                    if bin > 0 && bin < FFT_SIZE / 2 {
                        spectrum[FFT_SIZE - bin] = spectrum[bin].conj();
                    } else {
                        spectrum[bin].im = 0.0;
                    }
                }
                self.inverse
                    .process_with_scratch(&mut spectrum, &mut scratch);
                for pos in from..to {
                    let local = (pos - frame) as usize;
                    sum[(pos - begin) as usize * channels + out_channel] +=
                        spectrum[local].re * self.window[local] / FFT_SIZE as f64;
                }
            }
            frame += HOP_SIZE as i64;
        }
        let mut output = Vec::with_capacity(sum.len());
        for (i, frame) in sum.chunks_exact(channels).enumerate() {
            let fade = if let PlaybackMode::Selection { region, .. } = &self.mode {
                mask::time_weight(
                    region,
                    (begin as f64 + i as f64) / self.info.sample_rate as f64,
                )
            } else {
                1.0
            };
            for v in frame {
                output.push((v / weights[i] * fade) as f32);
            }
        }
        validate_samples(&output, count * channels)?;
        Ok(output)
    }
}
fn version_error() -> AppError {
    AppError::new(
        ErrorCode::UnsupportedVersion,
        "Unsupported DSP processing version; update the application",
    )
}
fn validate_region(r: &Region, s: &SourceInfo) -> Result<()> {
    if r.media_id != s.media_id
        || r.channel_index as usize >= s.channel_count
        || [r.start_seconds, r.end_seconds, r.low_hz, r.high_hz]
            .iter()
            .any(|v| !v.is_finite())
        || r.start_seconds < 0.0
        || r.start_seconds >= r.end_seconds
        || r.end_seconds > s.frame_count as f64 / s.sample_rate as f64
        || r.low_hz < 0.0
        || r.low_hz >= r.high_hz
        || r.high_hz > s.sample_rate as f64 / 2.0
    {
        return Err(AppError::invalid("DSP region outside source bounds"));
    }
    Ok(())
}
pub(super) fn validate_samples(input: &[f32], expected: usize) -> Result<()> {
    if input.len() != expected || input.iter().any(|v| !v.is_finite()) {
        return Err(AppError::invalid("Invalid or non-finite audio samples"));
    }
    Ok(())
}
