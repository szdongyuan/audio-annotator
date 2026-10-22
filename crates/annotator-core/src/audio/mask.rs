use super::stft_processor::FFT_SIZE;
use crate::model::Region;

fn rise(x: f64) -> f64 {
    0.5 - 0.5 * (std::f64::consts::PI * x.clamp(0.0, 1.0)).cos()
}

/// Transitions lie inside the region. DC/Nyquist have no exterior spectrum, so
/// a band touching the physical boundary retains that boundary bin completely.
pub fn frequency_weight(region: &Region, hz: f64, sample_rate: u32) -> f64 {
    if hz < region.low_hz || hz > region.high_hz {
        return 0.0;
    }
    let width = (2.0 * sample_rate as f64 / FFT_SIZE as f64)
        .max(20.0)
        .min((region.high_hz - region.low_hz) / 2.0);
    let low = if region.low_hz == 0.0 {
        1.0
    } else {
        rise((hz - region.low_hz) / width)
    };
    let high = if region.high_hz == sample_rate as f64 / 2.0 {
        1.0
    } else {
        rise((region.high_hz - hz) / width)
    };
    low.min(high)
}

pub fn time_weight(region: &Region, seconds: f64) -> f64 {
    if seconds < region.start_seconds || seconds > region.end_seconds {
        return 0.0;
    }
    let width = 0.01_f64.min((region.end_seconds - region.start_seconds) / 2.0);
    rise((seconds - region.start_seconds) / width).min(rise((region.end_seconds - seconds) / width))
}

/// Enabled, matching-channel edits are filtered by the processor before use.
pub fn suppression(regions: &[&Region], seconds: f64, hz: f64, sample_rate: u32) -> f64 {
    regions
        .iter()
        .map(|r| time_weight(r, seconds) * frequency_weight(r, hz, sample_rate))
        .fold(0.0, f64::max)
}
