use super::stft::power_db;
use crate::error::{AppError, Result};
pub fn hz_to_mel(hz: f64) -> f64 {
    2595. * (1. + hz / 700.).log10()
}
pub fn mel_to_hz(mel: f64) -> f64 {
    700. * (10_f64.powf(mel / 2595.) - 1.)
}
pub struct MelBank {
    weights: Vec<Vec<(usize, f64)>>,
    boundaries: Vec<[f64; 3]>,
    bins: usize,
}
impl MelBank {
    pub fn new(sample_rate: u32, fft_size: u32, bands: u32) -> Result<Self> {
        if sample_rate == 0
            || !(64..=65536).contains(&fft_size)
            || !fft_size.is_power_of_two()
            || !(32..=512).contains(&bands)
        {
            return Err(AppError::invalid("无效梅尔参数"));
        }
        let top = hz_to_mel(f64::from(sample_rate) / 2.);
        let points: Vec<_> = (0..bands + 2)
            .map(|i| mel_to_hz(top * f64::from(i) / f64::from(bands + 1)))
            .collect();
        let boundaries: Vec<_> = (0..bands as usize)
            .map(|i| [points[i], points[i + 1], points[i + 2]])
            .collect();
        let weights = boundaries
            .iter()
            .map(|[left, center, right]| {
                let mut weights: Vec<_> = (0..=fft_size as usize / 2)
                    .filter_map(|i| {
                        let f = i as f64 * f64::from(sample_rate) / f64::from(fft_size);
                        let w = ((f - left) / (center - left))
                            .min((right - f) / (right - center))
                            .max(0.);
                        (w > 0.).then_some((i, w))
                    })
                    .collect();
                let sum: f64 = weights.iter().map(|(_, w)| *w).sum();
                for (_, w) in &mut weights {
                    *w /= sum;
                }
                weights
            })
            .collect();
        Ok(Self {
            weights,
            boundaries,
            bins: fft_size as usize / 2 + 1,
        })
    }
    pub fn boundaries(&self) -> &[[f64; 3]] {
        &self.boundaries
    }
    pub fn apply(&self, power: &[f64]) -> Result<Vec<f64>> {
        if power.len() != self.bins || power.iter().any(|x| !x.is_finite() || *x < 0.) {
            return Err(AppError::invalid("无效梅尔功率"));
        }
        Ok(self
            .weights
            .iter()
            .map(|weights| weights.iter().map(|(i, w)| power[*i] * w).sum())
            .collect())
    }
    pub fn db(&self, power: &[f64]) -> Result<Vec<f32>> {
        Ok(self.apply(power)?.into_iter().map(power_db).collect())
    }
}
