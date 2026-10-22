//! Preserve layout provenance: decoder fallback masks are not WAV speaker metadata.
use super::identity::check_cancel;
use crate::error::{AppError, ErrorCode, Result};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::AtomicBool,
};
use symphonia::core::audio::Channels;

pub(super) struct WaveLayout {
    pub channel_count: u16,
    pub explicit_mask: Option<Channels>,
}
fn invalid() -> AppError {
    AppError::new(ErrorCode::DecodeFailed, "WAV 格式块或通道掩码无效")
}
fn read_at<const N: usize>(file: &mut File, offset: u64) -> Result<[u8; N]> {
    let mut bytes = [0; N];
    file.seek(SeekFrom::Start(offset)).map_err(|_| invalid())?;
    file.read_exact(&mut bytes).map_err(|_| invalid())?;
    Ok(bytes)
}

/// Inspect actual RIFF/WAVE bytes, reading at most 40 bytes per chunk and skipping
/// payloads with seeks. None means another container with format-defined layouts.
pub(super) fn inspect(
    path: &Path,
    byte_length: u64,
    cancel: &AtomicBool,
) -> Result<Option<WaveLayout>> {
    if byte_length < 12 {
        return Ok(None);
    }
    let mut file = File::open(path).map_err(|_| invalid())?;
    let header = read_at::<12>(&mut file, 0)?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Ok(None);
    }
    let end = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64 + 8;
    if end < 12 || end > byte_length {
        return Err(invalid());
    }
    let mut offset = 12;
    let mut layout = None;
    for _ in 0..4096 {
        check_cancel(cancel)?;
        if end - offset < 8 {
            return Err(invalid());
        }
        let chunk = read_at::<8>(&mut file, offset)?;
        let size = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as u64;
        let body = offset + 8;
        let next = body + size + (size & 1);
        if next > end {
            return Err(invalid());
        }
        match &chunk[..4] {
            b"fmt " => {
                // Duplicate format chunks make speaker provenance ambiguous.
                if layout.is_some() || size < 16 {
                    return Err(invalid());
                }
                let base = read_at::<16>(&mut file, body)?;
                let format = u16::from_le_bytes(base[..2].try_into().unwrap());
                let channel_count = u16::from_le_bytes(base[2..4].try_into().unwrap());
                if !(1..=6).contains(&channel_count) {
                    return Err(AppError::new(
                        ErrorCode::UnsupportedChannels,
                        "仅支持 1–6 个通道",
                    ));
                }
                let explicit_mask = if format == 0xfffe {
                    if size < 40 {
                        return Err(invalid());
                    }
                    let ext = read_at::<40>(&mut file, body)?;
                    if u16::from_le_bytes(ext[16..18].try_into().unwrap()) != 22 {
                        return Err(invalid());
                    }
                    let mask = u32::from_le_bytes(ext[20..24].try_into().unwrap());
                    if mask == 0 {
                        None
                    } else {
                        // WAVEFORMATEXTENSIBLE defines the first 18 speaker bits.
                        // Reject inconsistent/reserved masks before the decoder repairs them.
                        if mask & !0x0003_ffff != 0 || mask.count_ones() != channel_count as u32 {
                            return Err(invalid());
                        }
                        Some(Channels::from_bits(mask).ok_or_else(invalid)?)
                    }
                } else {
                    None
                };
                layout = Some(WaveLayout {
                    channel_count,
                    explicit_mask,
                });
            }
            b"data" => return layout.map(Some).ok_or_else(invalid),
            _ => (),
        }
        offset = next;
    }
    Err(AppError::new(
        ErrorCode::ResourceLimit,
        "WAV 格式块数量过多",
    ))
}
