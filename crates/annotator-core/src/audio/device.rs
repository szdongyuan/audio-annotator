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
                    render(data, channels, rate, &buffer, info, &mut timing, |v| v)
                },
                error,
                None,
            ),
            SampleFormat::I16 => self.device.build_output_stream(
                &self.config.config(),
                move |data: &mut [i16], info| {
                    render(data, channels, rate, &buffer, info, &mut timing, |v| {
                        (v * 32767.0).round() as i16
                    })
                },
                error,
                None,
            ),
            SampleFormat::U16 => self.device.build_output_stream(
                &self.config.config(),
                move |data: &mut [u16], info| {
                    render(data, channels, rate, &buffer, info, &mut timing, |v| {
                        ((v + 1.0) * 32767.5).round() as u16
                    })
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
    let mut tail = None;
    let silence = convert(0.0);
    for (index, frame) in data.chunks_mut(channels).enumerate() {
        let sample = buffer.consume_frame();
        let [l, r] = sample.unwrap_or([0.0; 2]);
        for (i, v) in frame.iter_mut().enumerate() {
            *v = convert(if channels == 1 {
                (l + r) * 0.5
            } else {
                match i {
                    0 => l,
                    1 => r,
                    _ => 0.0,
                }
            });
        }
        if sample.is_some() {
            tail = Some(SubmittedTail {
                frame_end: index + 1,
                non_silent: frame.iter().any(|value| *value != silence),
            });
        }
    }
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
