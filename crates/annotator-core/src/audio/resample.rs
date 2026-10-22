use super::{stft_processor::validate_samples, MAX_BLOCK_FRAMES};
use crate::error::{AppError, ErrorCode, Result};
use rubato::{FftFixedInOut, Resampler};

/// Stateful worker-thread resampling with bounded input blocks and retained
/// sub-block context. Feed exactly `input_frames`, then call finish once to pad
/// and drain the filter tail. Initial delay is discarded; output length is the
/// nearest integer to input_frames*out_rate/in_rate (ties upward). To seek,
/// construct a fresh instance with the remaining source range; never reuse old
/// filter state. Device callbacks must only consume the resulting queued PCM.
pub struct BlockResampler {
    inner: Option<FftFixedInOut<f64>>,
    channels: usize,
    expected_input: u64,
    received: u64,
    expected_output: u64,
    produced: u64,
    delay: u64,
    raw_frames: u64,
    pending: Vec<f32>,
    finished: bool,
}

impl BlockResampler {
    pub fn new(
        input_rate: u32,
        output_rate: u32,
        channels: usize,
        input_frames: u64,
    ) -> Result<Self> {
        if input_rate == 0 || output_rate == 0 || !(1..=6).contains(&channels) {
            return Err(AppError::invalid("Invalid resampling format"));
        }
        let expected_output = (input_frames as u128 * output_rate as u128 + input_rate as u128 / 2)
            / input_rate as u128;
        let expected_output = u64::try_from(expected_output)
            .map_err(|_| AppError::invalid("Resampled duration overflow"))?;
        let inner = if input_rate == output_rate {
            None
        } else {
            let (mut a, mut b) = (input_rate, output_rate);
            while b != 0 {
                (a, b) = (b, a % b);
            }
            let (unit_in, unit_out) = (input_rate as u64 / a as u64, output_rate as u64 / a as u64);
            let mut multiple = 1024_u64.div_ceil(unit_in);
            // Rubato 0.16's FFT filter delay is half the output chunk, but
            // output_delay() returns an integer. An odd output chunk leaves a
            // half-sample phase error after trimming. Make both chunks even.
            if (multiple * unit_in) % 2 != 0 || (multiple * unit_out) % 2 != 0 {
                multiple *= 2;
            }
            // Guard BEFORE constructing Rubato: a pathological coprime rate
            // pair or huge ratio would otherwise allocate enormous FFT buffers.
            if multiple * unit_in > 32768 || multiple * unit_out > 32768 {
                return Err(AppError::new(
                    ErrorCode::ResourceLimit,
                    "This sample-rate pair exceeds the bounded resampling FFT budget",
                ));
            }
            Some(
                FftFixedInOut::new(
                    input_rate as usize,
                    output_rate as usize,
                    (multiple * unit_in) as usize,
                    channels,
                )
                .map_err(resample_error)?,
            )
        };
        let delay = inner.as_ref().map_or(0, |r| r.output_delay() as u64);
        Ok(Self {
            inner,
            channels,
            expected_input: input_frames,
            received: 0,
            expected_output,
            produced: 0,
            delay,
            raw_frames: 0,
            pending: Vec::new(),
            finished: false,
        })
    }
    pub fn output_frame_count(&self) -> u64 {
        self.expected_output
    }
    pub fn input_frames_received(&self) -> u64 {
        self.received
    }

    pub fn push(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if self.finished {
            return Err(AppError::invalid("Resampler is already finished"));
        }
        if !input.len().is_multiple_of(self.channels) {
            return Err(AppError::invalid("Incomplete interleaved audio frame"));
        }
        let frames = input.len() / self.channels;
        if frames > MAX_BLOCK_FRAMES {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "Resampling input blocks are limited to 4096 frames",
            ));
        }
        validate_samples(input, input.len())?;
        if self
            .received
            .checked_add(frames as u64)
            .is_none_or(|n| n > self.expected_input)
        {
            return Err(AppError::invalid("Too many resampling input frames"));
        }
        self.received += frames as u64;
        if self.inner.is_none() {
            self.produced += frames as u64;
            return Ok(input.iter().map(|v| v.clamp(-1.0, 1.0)).collect());
        }
        self.pending.extend_from_slice(input);
        let chunk = self.inner.as_ref().unwrap().input_frames_next() * self.channels;
        let mut out = Vec::new();
        while self.pending.len() >= chunk {
            out.extend(self.process_chunk()?);
        }
        Ok(out)
    }

    pub fn finish(&mut self) -> Result<Vec<f32>> {
        if self.finished || self.received != self.expected_input {
            return Err(AppError::invalid(
                "Resampling requires exactly the declared source frame count and one finish",
            ));
        }
        let mut out = Vec::new();
        while self.produced < self.expected_output {
            let chunk = self.inner.as_ref().unwrap().input_frames_next() * self.channels;
            self.pending.resize(chunk, 0.0);
            out.extend(self.process_chunk()?);
        }
        self.pending.clear();
        self.finished = true;
        Ok(out)
    }

    fn process_chunk(&mut self) -> Result<Vec<f32>> {
        let r = self.inner.as_mut().unwrap();
        let frames = r.input_frames_next();
        let mut planar = vec![vec![0.0; frames]; self.channels];
        for (i, frame) in self.pending[..frames * self.channels]
            .chunks_exact(self.channels)
            .enumerate()
        {
            for (c, v) in frame.iter().enumerate() {
                planar[c][i] = *v as f64;
            }
        }
        let output = r.process(&planar, None).map_err(resample_error)?;
        self.pending.drain(..frames * self.channels);
        let mut interleaved = Vec::new();
        for i in 0..output[0].len() {
            if self.raw_frames >= self.delay && self.produced < self.expected_output {
                for channel in &output {
                    if !channel[i].is_finite() {
                        return Err(AppError::invalid("Non-finite resampler output"));
                    }
                    // Sinc/FFT ringing can overshoot even when mixed input was bounded.
                    interleaved.push(channel[i].clamp(-1.0, 1.0) as f32);
                }
                self.produced += 1;
            }
            self.raw_frames = self
                .raw_frames
                .checked_add(1)
                .ok_or_else(|| AppError::invalid("Resampling position overflow"))?;
        }
        Ok(interleaved)
    }
}
fn resample_error(e: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorCode::DeviceFailed,
        format!("Audio resampling failed: {e}"),
    )
}
