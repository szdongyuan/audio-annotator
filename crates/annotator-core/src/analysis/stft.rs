use crate::{
    error::{AppError, Result},
    model::{validation::validate_analysis, AnalysisSettings, WindowFunction},
};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::{
    f64::consts::PI,
    sync::{Arc, Mutex, OnceLock},
};

// There are only 11 allowed FFT sizes. Plans are reused without retaining PCM.
static PLANNER: OnceLock<Mutex<FftPlanner<f64>>> = OnceLock::new();
pub fn frame_count(samples: u64, hop: u32) -> u64 {
    if samples == 0 || hop == 0 {
        0
    } else {
        (samples - 1) / u64::from(hop) + 1
    }
}
pub fn power_db(power: f64) -> f32 {
    (10. * power.max(1e-16).log10()) as f32
}
pub struct Spectrum {
    pub amplitude: Vec<f64>,
    pub power: Vec<f64>,
}
impl Spectrum {
    pub fn amplitude_db(&self) -> Vec<f32> {
        self.amplitude
            .iter()
            .map(|a| (20. * a.max(1e-8).log10()) as f32)
            .collect()
    }
}
pub struct Stft {
    window: Vec<f64>,
    sum: f64,
    fft: Arc<dyn Fft<f64>>,
    buffer: Vec<Complex<f64>>,
    scratch: Vec<Complex<f64>>,
}
impl Stft {
    pub fn new(settings: &AnalysisSettings) -> Result<Self> {
        validate_analysis(settings)?;
        // Periodic windows (denominator N), fixed by analysis algorithm v1.
        let window: Vec<_> = (0..settings.window_size)
            .map(|i| {
                let x = 2. * PI * f64::from(i) / f64::from(settings.window_size);
                match settings.window {
                    WindowFunction::Hann => 0.5 - 0.5 * x.cos(),
                    WindowFunction::Hamming => 0.54 - 0.46 * x.cos(),
                    WindowFunction::Blackman => 0.42 - 0.5 * x.cos() + 0.08 * (2. * x).cos(),
                    WindowFunction::Rectangular => 1.,
                }
            })
            .collect();
        let fft = PLANNER
            .get_or_init(|| Mutex::new(FftPlanner::new()))
            .lock()
            .map_err(|_| AppError::invalid("FFT 服务不可用"))?
            .plan_fft_forward(settings.fft_size as usize);
        Ok(Self {
            sum: window.iter().sum(),
            window,
            scratch: vec![Complex::default(); fft.get_inplace_scratch_len()],
            buffer: vec![Complex::default(); settings.fft_size as usize],
            fft,
        })
    }
    pub fn bin_hz(&self, bin: usize, sample_rate: u32) -> f64 {
        bin as f64 * f64::from(sample_rate) / self.buffer.len() as f64
    }
    /// A short final window is zero padded; normalization always uses the complete window.
    pub fn frame(&mut self, samples: &[f32]) -> Result<Spectrum> {
        if samples.len() > self.window.len() || samples.iter().any(|x| !x.is_finite()) {
            return Err(AppError::invalid("无效分析采样"));
        }
        self.buffer.fill(Complex::default());
        for (i, x) in samples.iter().enumerate() {
            self.buffer[i].re = f64::from(*x) * self.window[i];
        }
        self.fft
            .process_with_scratch(&mut self.buffer, &mut self.scratch);
        let mut amplitude = Vec::with_capacity(self.buffer.len() / 2 + 1);
        let mut power = Vec::with_capacity(amplitude.capacity());
        for (i, value) in self.buffer[..=self.buffer.len() / 2].iter().enumerate() {
            let a = value.norm() / self.sum;
            let factor = if i == 0 || i == self.buffer.len() / 2 {
                1.
            } else {
                2.
            };
            amplitude.push(a * factor);
            power.push(a * a * factor);
        }
        Ok(Spectrum { amplitude, power })
    }
}
