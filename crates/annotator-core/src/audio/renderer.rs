//! Bounded background production; the output device never calls this module.
use super::{
    mixer::mix_stereo, resample::BlockResampler, DspProcessor, PlaybackMode, SourceInfo,
    DSP_VERSION, MAX_BLOCK_FRAMES,
};
use crate::{
    error::{AppError, Result},
    model::{PlaybackMix, SpectralEdit},
};
pub struct AudioChunk {
    pub samples: Vec<f32>,
    pub positions: Vec<u64>,
}
pub struct RenderOptions {
    pub mix: PlaybackMix,
    pub volume: f32,
    pub device_rate: u32,
    pub start: u64,
    pub looping: bool,
}
pub struct Renderer {
    dsp: DspProcessor,
    mix: PlaybackMix,
    volume: f32,
    device_rate: u32,
    looping: bool,
    resampler: BlockResampler,
    cursor: u64,
    cycle_start: u64,
    produced: u64,
    finished: bool,
}
impl Renderer {
    pub fn new(
        info: SourceInfo,
        mode: PlaybackMode,
        edits: &[SpectralEdit],
        options: RenderOptions,
    ) -> Result<Self> {
        let RenderOptions {
            mix,
            volume,
            device_rate,
            start,
            looping,
        } = options;
        // A selection is already mono from its original region.channelIndex.
        // Mixing that output must not reinterpret that stable source index as index zero.
        let mix = if matches!(mode, PlaybackMode::Selection { .. }) {
            PlaybackMix::default()
        } else {
            mix
        };
        let dsp = DspProcessor::new(info, DSP_VERSION, mode, edits)?;
        if (dsp.frame_count() as u128 * device_rate as u128 + dsp.sample_rate() as u128 / 2)
            / (dsp.sample_rate() as u128)
            == 0
        {
            return Err(AppError::invalid(
                "选区小于一个输出设备采样帧，请扩大时间范围",
            ));
        }
        let start = start.clamp(
            dsp.source_start_frame(),
            dsp.source_start_frame() + dsp.frame_count(),
        );
        let start = if looping && start == dsp.source_start_frame() + dsp.frame_count() {
            dsp.source_start_frame()
        } else {
            start
        };
        let cursor = start - dsp.source_start_frame();
        let resampler = BlockResampler::new(
            dsp.sample_rate(),
            device_rate,
            2,
            dsp.frame_count() - cursor,
        )?;
        Ok(Self {
            dsp,
            mix,
            volume,
            device_rate,
            looping,
            resampler,
            cursor,
            cycle_start: start,
            produced: 0,
            finished: false,
        })
    }
    pub fn bounds(&self) -> (u64, u64) {
        (
            self.dsp.source_start_frame(),
            self.dsp.source_start_frame() + self.dsp.frame_count(),
        )
    }
    pub fn next(
        &mut self,
        mut read: impl FnMut(u64, usize) -> Result<Vec<f32>>,
    ) -> Result<Option<AudioChunk>> {
        if self.finished {
            if !self.looping {
                return Ok(None);
            }
            self.cursor = 0;
            self.cycle_start = self.dsp.source_start_frame();
            self.produced = 0;
            self.finished = false;
            self.resampler = BlockResampler::new(
                self.dsp.sample_rate(),
                self.device_rate,
                2,
                self.dsp.frame_count(),
            )?;
        }
        loop {
            let samples = if self.cursor < self.dsp.frame_count() {
                let count =
                    (self.dsp.frame_count() - self.cursor).min(MAX_BLOCK_FRAMES as u64) as usize;
                let samples = self.dsp.read_frames(self.cursor, count, &mut read)?;
                self.cursor += count as u64;
                self.resampler.push(&mix_stereo(
                    &samples,
                    self.dsp.channel_count(),
                    &self.mix,
                    self.volume,
                )?)?
            } else {
                self.finished = true;
                self.resampler.finish()?
            };
            let end = self.bounds().1;
            let count = samples.len() / 2;
            let expected = ((end - self.cycle_start) as u128 * self.device_rate as u128
                + self.dsp.sample_rate() as u128 / 2)
                / self.dsp.sample_rate() as u128;
            let positions = (1..=count)
                .map(|i| {
                    if (self.produced + i as u64) as u128 >= expected {
                        end
                    } else {
                        (self.cycle_start
                            + ((self.produced + i as u64) as u128 * self.dsp.sample_rate() as u128
                                / self.device_rate as u128) as u64)
                            .min(end)
                    }
                })
                .collect::<Vec<_>>();
            self.produced += count as u64;
            if !samples.is_empty() {
                return Ok(Some(AudioChunk { samples, positions }));
            }
            if self.finished {
                return if self.looping {
                    self.next(read)
                } else {
                    Ok(None)
                };
            }
        }
    }
}
