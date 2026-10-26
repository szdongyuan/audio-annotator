use super::{stft_processor::validate_samples, MAX_BLOCK_FRAMES};
use crate::{
    error::{AppError, ErrorCode, Result},
    model::PlaybackMix,
};

/// Interleaved source to interleaved stereo. Solo first restricts the audible
/// set, then mute removes channels. A *soloed* stereo channel is centered;
/// muting one side without solo preserves the remaining side's pan.
pub fn mix_stereo(
    input: &[f32],
    channels: usize,
    mix: &PlaybackMix,
    volume: f32,
) -> Result<Vec<f32>> {
    if !(1..=6).contains(&channels)
        || !input.len().is_multiple_of(channels)
        || !volume.is_finite()
        || !(0.0..=1.0).contains(&volume)
    {
        return Err(AppError::invalid("Invalid audio mix parameters"));
    }
    if input.len() / channels > MAX_BLOCK_FRAMES {
        return Err(AppError::new(
            ErrorCode::ResourceLimit,
            "Mix blocks are limited to 4096 frames",
        ));
    }
    validate_samples(input, input.len())?;
    for selection in [&mix.solo_channels, &mix.muted_channels] {
        let mut seen = [false; 6];
        for &channel in selection {
            if channel as usize >= channels || seen[channel as usize] {
                return Err(AppError::invalid("Invalid or duplicate mix channel"));
            }
            seen[channel as usize] = true;
        }
    }
    let audible: Vec<_> = (0..channels)
        .filter(|i| {
            (mix.solo_channels.is_empty() || mix.solo_channels.contains(&(*i as u8)))
                && !mix.muted_channels.contains(&(*i as u8))
        })
        .collect();
    let stereo = channels == 2 && mix.solo_channels.len() != 1;
    let mut output = Vec::with_capacity(input.len() / channels * 2);
    for frame in input.chunks_exact(channels) {
        let (left, right) = if stereo {
            (
                if audible.contains(&0) {
                    frame[0] as f64
                } else {
                    0.0
                },
                if audible.contains(&1) {
                    frame[1] as f64
                } else {
                    0.0
                },
            )
        } else {
            let value = if audible.is_empty() {
                0.0
            } else {
                audible.iter().map(|&c| frame[c] as f64).sum::<f64>() / audible.len() as f64
            };
            (value, value)
        };
        output.extend([
            (left * volume as f64) as f32,
            (right * volume as f64) as f32,
        ]);
    }
    Ok(output)
}
