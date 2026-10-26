use super::engine::{OutputBuffer, OutputTiming, PresentationTracker, SubmittedTail};
use crate::error::{AppError, ErrorCode, Result};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat,
};
use serde::Serialize;
use std::sync::{atomic::Ordering, Arc};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}
pub fn device_error(e: impl std::fmt::Display) -> AppError {
    let mut error = AppError::new(
        ErrorCode::DeviceFailed,
        format!("音频输出失败，请重选设备或重试：{e}"),
    );
    error.retryable = true;
    error
}
pub fn list_devices() -> Result<Vec<OutputDevice>> {
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.name().ok());
    Ok(host
        .output_devices()
        .map_err(device_error)?
        .enumerate()
        .map(|(i, d)| {
            let name = d.name().unwrap_or_else(|_| "未知输出设备".into());
            OutputDevice {
                id: format!("{i}:{name}"),
                is_default: default.as_ref() == Some(&name),
                name,
            }
        })
        .collect())
}
pub struct Device {
    device: cpal::Device,
    config: cpal::SupportedStreamConfig,
    pub name: String,
}
impl Device {
    pub fn select(id: Option<&str>) -> Result<Self> {
        let host = cpal::default_host();
        let device = if let Some(id) = id.filter(|s| !s.is_empty()) {
            host.output_devices()
                .map_err(device_error)?
                .enumerate()
                .find_map(|(i, d)| {
                    (format!("{i}:{}", d.name().unwrap_or_default()) == id).then_some(d)
                })
        } else {
            host.default_output_device()
        }
        .ok_or_else(|| device_error("没有可用的输出设备"))?;
        let name = device.name().map_err(device_error)?;
        let config = device.default_output_config().map_err(device_error)?;
        if !matches!(
            config.sample_format(),
            SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16
        ) {
            return Err(device_error("设备格式不支持 F32 / I16 / U16"));
        }
        Ok(Self {
            device,
            config,
            name,
        })
    }
    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate().0
    }
    pub fn channels(&self) -> u16 {
        self.config.channels()
    }
    pub fn start(&self, buffer: Arc<OutputBuffer>) -> Result<cpal::Stream> {
        let channels = usize::from(self.config.channels());
        let rate = self.sample_rate();
        let mut timing = CallbackTiming::default();
        let errors = buffer.clone();
        let error = move |_| {
            errors.device_failed.store(true, Ordering::Release);
        };
        let stream = match self.config.sample_format() {
            SampleFormat::F32 => self.device.build_output_stream(
                &self.config.config(),
                move |data: &mut [f32], info| {
                    render(data, channels, rate, &buffer, info, &mut timing, output_f32)
                },
                error,
                None,
            ),
            SampleFormat::I16 => self.device.build_output_stream(
                &self.config.config(),
                move |data: &mut [i16], info| {
                    render(data, channels, rate, &buffer, info, &mut timing, output_i16)
                },
                error,
                None,
            ),
            SampleFormat::U16 => self.device.build_output_stream(
                &self.config.config(),
                move |data: &mut [u16], info| {
                    render(data, channels, rate, &buffer, info, &mut timing, output_u16)
                },
                error,
                None,
            ),
            _ => return Err(device_error("不支持的输出格式")),
        }
        .map_err(device_error)?;
        stream.play().map_err(device_error)?;
        Ok(stream)
    }
}
#[derive(Default)]
struct CallbackTiming {
    origin: Option<cpal::StreamInstant>,
    presentation: PresentationTracker,
    monitor: MonitorRamp,
}
fn render<T: Copy + PartialEq>(
    data: &mut [T],
    channels: usize,
    rate: u32,
    buffer: &OutputBuffer,
    info: &cpal::OutputCallbackInfo,
    timing: &mut CallbackTiming,
    convert: impl Fn(f32) -> T,
) {
    let timestamp = info.timestamp();
    let origin = timing.origin.get_or_insert(timestamp.callback);
    let nanos = |instant: cpal::StreamInstant| {
        instant
            .duration_since(origin)
            .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
    };
    let (Some(callback_nanos), Some(playback_nanos)) =
        (nanos(timestamp.callback), nanos(timestamp.playback))
    else {
        data.fill(convert(0.0));
        buffer.device_failed.store(true, Ordering::Release);
        return;
    };
    let frames = data.len() / channels;
    let tail = render_samples(data, channels, rate, buffer, &mut timing.monitor, &convert);
    timing.presentation.record(
        buffer,
        OutputTiming {
            callback_nanos,
            playback_nanos,
        },
        frames,
        rate,
        tail,
    );
}

fn render_samples<T: Copy + PartialEq>(
    data: &mut [T],
    channels: usize,
    rate: u32,
    buffer: &OutputBuffer,
    monitor: &mut MonitorRamp,
    convert: impl Fn(f32) -> T,
) -> Option<SubmittedTail> {
    let mut tail = None;
    let silence = convert(0.0);
    for (index, frame) in data.chunks_mut(channels).enumerate() {
        let sample = buffer.consume_frame();
        let [l, r] = sample.unwrap_or([0.0; 2]);
        let scalar = monitor.next(buffer.monitor_scalar(), rate);
        let (l, r) = (l as f64 * scalar as f64, r as f64 * scalar as f64);
        for (i, v) in frame.iter_mut().enumerate() {
            *v = convert(
                (if channels == 1 {
                    (l + r) * 0.5
                } else {
                    match i {
                        0 => l,
                        1 => r,
                        _ => 0.0,
                    }
                })
                .clamp(-(f32::MAX as f64), f32::MAX as f64) as f32,
            );
        }
        if sample.is_some() {
            tail = Some(SubmittedTail {
                frame_end: index + 1,
                non_silent: frame.iter().any(|value| *value != silence),
            });
        }
    }
    tail
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_conversion_clips_only_after_monitor_and_never_wraps() {
        for input in [
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::MAX,
            -f32::MAX,
            2.0,
            -2.0,
            0.0,
        ] {
            let f = output_f32(input);
            assert!(f.is_finite() && (-1.0..=1.0).contains(&f));
            assert_eq!(output_i16(input), (f * 32767.0).round() as i16);
            assert_eq!(output_u16(input), ((f + 1.0) * 32767.5).round() as u16);
        }
        assert_eq!(output_f32(0.0), 0.0);
        assert_eq!(output_i16(0.0), 0);
        assert_eq!(output_u16(0.0), 32768);
    }
    #[test]
    fn callback_ramp_preserves_balance_and_advances_once_per_device_frame() {
        use std::sync::atomic::AtomicU64;
        for channels in [1, 2, 6] {
            let buffer = OutputBuffer::new(481, Arc::new(AtomicU64::new(1)), 1, 0);
            for i in 0..481 {
                buffer.push([0.4, -0.1], i);
            }
            buffer.set_playing(true);
            let mut monitor = MonitorRamp::default();
            let mut prime = vec![0.0; channels];
            render_samples(
                &mut prime,
                channels,
                48000,
                &buffer,
                &mut monitor,
                output_f32,
            );
            buffer.set_monitor_gain_db(-40.0).unwrap();
            let mut output = vec![0.0; 480 * channels];
            let tail = render_samples(
                &mut output,
                channels,
                48000,
                &buffer,
                &mut monitor,
                output_f32,
            )
            .unwrap();
            for frame in output.chunks_exact(channels) {
                if channels > 1 {
                    assert!((frame[0] + 4.0 * frame[1]).abs() < 1e-7);
                    assert!(frame[2..].iter().all(|v| *v == 0.0));
                }
            }
            let last = output[output.len() - channels];
            let expected = if channels == 1 { 0.0015 } else { 0.004 };
            assert!((last - expected).abs() < 1e-7);
            assert!(output[0] > expected);
            assert_eq!(tail.frame_end, 480);
            assert_eq!(buffer.consumed(), 481);
        }
    }
    #[test]
    fn monitor_ramps_per_frame_with_shared_channels_and_ten_ms_bound() {
        let mut ramp = MonitorRamp::default();
        assert_eq!(ramp.next(1.0, 48000), 1.0);
        let mut previous = 1.0;
        for _ in 0..480 {
            let scalar = ramp.next(0.01, 48000);
            assert!(scalar <= previous && scalar >= 0.01);
            assert!((scalar - previous).abs() <= 0.003);
            let stereo = [2.0 * scalar, -0.5 * scalar];
            assert!((stereo[0] + 4.0 * stereo[1]).abs() < 1e-6);
            previous = scalar;
        }
        assert_eq!(previous, 0.01);
        assert_eq!(ramp.next(0.01, 48000), 0.01);
        assert_eq!(
            MonitorRamp::default().next(10.0_f32.powf(-24.0 / 20.0), 48000),
            10.0_f32.powf(-24.0 / 20.0)
        );
    }
}

pub fn output_f32(value: f32) -> f32 {
    if value.is_nan() {
        0.0
    } else {
        value.clamp(-1.0, 1.0)
    }
}
pub fn output_i16(value: f32) -> i16 {
    (output_f32(value) * 32767.0).round() as i16
}
pub fn output_u16(value: f32) -> u16 {
    ((output_f32(value) + 1.0) * 32767.5).round() as u16
}
#[derive(Default)]
struct MonitorRamp {
    value: Option<f32>,
    target: f32,
    remaining: u32,
}
impl MonitorRamp {
    fn next(&mut self, target: f32, rate: u32) -> f32 {
        let Some(value) = self.value else {
            self.value = Some(target);
            self.target = target;
            return target;
        };
        if self.target != target {
            self.target = target;
            self.remaining = (rate / 100).max(1);
        }
        let next = if self.remaining > 0 {
            let v = value + (target - value) / self.remaining as f32;
            self.remaining -= 1;
            v
        } else {
            target
        };
        self.value = Some(next);
        next
    }
}
