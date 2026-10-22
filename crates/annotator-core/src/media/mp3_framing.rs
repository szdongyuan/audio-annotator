//! Symphonia reports both clean MP3 EOF and an incomplete last frame as UnexpectedEof.
//! Check Layer III packet boundaries without decoding or trusting duration estimates.
use super::identity::check_cancel;
use crate::error::{AppError, ErrorCode, Result};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::AtomicBool,
};

fn corrupt() -> AppError {
    AppError::new(ErrorCode::DecodeFailed, "MP3 帧或标签被截断 / 损坏")
}
fn read_at<const N: usize>(file: &mut File, offset: u64) -> Result<[u8; N]> {
    let mut bytes = [0_u8; N];
    file.seek(SeekFrom::Start(offset)).map_err(|_| corrupt())?;
    file.read_exact(&mut bytes).map_err(|_| corrupt())?;
    Ok(bytes)
}
pub(super) fn validate(path: &Path, length: u64, cancel: &AtomicBool) -> Result<()> {
    let mut file = File::open(path).map_err(|_| corrupt())?;
    let mut end = length;
    // ID3v1 and APEv2 are trailing metadata, not MPEG packets.
    if end >= 128 && &read_at::<3>(&mut file, end - 128)? == b"TAG" {
        end -= 128;
    }
    if end >= 32 {
        let footer = read_at::<32>(&mut file, end - 32)?;
        if &footer[..8] == b"APETAGEX" {
            let size = u32::from_le_bytes(footer[12..16].try_into().unwrap()) as u64;
            if size < 32 || size > end {
                return Err(corrupt());
            }
            end -= size;
            if end >= 32 && &read_at::<8>(&mut file, end - 32)? == b"APETAGEX" {
                end -= 32;
            }
        }
    }
    let mut offset = 0;
    while offset < end {
        check_cancel(cancel)?;
        if end - offset < 4 {
            return Err(corrupt());
        }
        let header = read_at::<4>(&mut file, offset)?;
        if &header[..3] == b"ID3" {
            if end - offset < 10 {
                return Err(corrupt());
            }
            let tag = read_at::<10>(&mut file, offset)?;
            if tag[6..10].iter().any(|byte| byte & 0x80 != 0) {
                return Err(corrupt());
            }
            let size = tag[6..10]
                .iter()
                .fold(0_u64, |n, byte| (n << 7) | *byte as u64);
            let footer = if tag[3] == 4 && tag[5] & 0x10 != 0 {
                10
            } else {
                0
            };
            offset += 10 + size + footer;
            if offset > end {
                return Err(corrupt());
            }
            continue;
        }
        let version = (header[1] >> 3) & 3;
        let layer = (header[1] >> 1) & 3;
        let bitrate = (header[2] >> 4) as usize;
        let rate = ((header[2] >> 2) & 3) as usize;
        if header[0] != 0xff
            || header[1] & 0xe0 != 0xe0
            || version == 1
            || layer != 1
            || bitrate == 0
            || bitrate == 15
            || rate == 3
        {
            return Err(corrupt());
        }
        let rates = [44100_u64, 48000, 32000];
        let sample_rate = rates[rate]
            / match version {
                3 => 1,
                2 => 2,
                _ => 4,
            };
        let bitrates = if version == 3 {
            [
                0_u64, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
            ]
        } else {
            [
                0_u64, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
            ]
        };
        let factor = if version == 3 { 144 } else { 72 };
        let bytes = factor * bitrates[bitrate] * 1000 / sample_rate + ((header[2] >> 1) & 1) as u64;
        if bytes < 4 || bytes > end - offset {
            return Err(corrupt());
        }
        offset += bytes;
    }
    Ok(())
}
