use crate::error::{AppError, ErrorCode, Result};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
};

pub const PCM_CACHE_BYTES: usize = 128 * 1024 * 1024;
pub const BLOCK_FRAMES: usize = 4096;
const MAX_READ_BYTES: usize = 4 * 1024 * 1024;

/// The last owner removes only its own unique temporary PCM file.
#[derive(Debug)]
pub struct PcmFile {
    path: PathBuf,
    frames: u64,
    channels: usize,
}
impl PcmFile {
    pub(crate) fn new(path: PathBuf, frames: u64, channels: usize) -> Self {
        Self {
            path,
            frames,
            channels,
        }
    }
    pub fn frame_count(&self) -> u64 {
        self.frames
    }
    pub fn channel_count(&self) -> usize {
        self.channels
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for PcmFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
struct Block {
    values: Arc<Vec<f32>>,
    used: u64,
}
pub struct PcmCache {
    blocks: HashMap<(PathBuf, u64), Block>,
    budget: usize,
    bytes: usize,
    clock: u64,
}
impl Default for PcmCache {
    fn default() -> Self {
        Self::new(PCM_CACHE_BYTES)
    }
}
impl PcmCache {
    /// One analysis cache shared by both analysis workers; one playback cache owned
    /// by the serial output worker. Together they retain at most 128 MiB.
    pub fn for_analysis() -> Self {
        // Reserve the two analysis workers' retained channel blocks within the
        // existing 96 MiB analysis share (plus 32 MiB serial playback = 128 MiB).
        Self::new(96 * 1024 * 1024 - 2 * crate::analysis::source::PROCESSED_CACHE_BYTES)
    }
    pub fn for_playback() -> Self {
        Self::new(32 * 1024 * 1024)
    }
    pub fn capacity_bytes(&self) -> usize {
        self.budget
    }
    pub fn new(budget: usize) -> Self {
        Self {
            blocks: HashMap::new(),
            budget,
            bytes: 0,
            clock: 0,
        }
    }
    pub fn resident_bytes(&self) -> usize {
        self.bytes
    }
    pub fn clear(&mut self) {
        self.blocks.clear();
        self.bytes = 0;
    }
    pub fn read_frames(&mut self, pcm: &PcmFile, start: u64, count: usize) -> Result<Vec<f32>> {
        let end = start
            .checked_add(count as u64)
            .ok_or_else(|| AppError::invalid("PCM 帧范围溢出"))?;
        if end > pcm.frames {
            return Err(AppError::invalid("PCM 帧范围越界"));
        }
        let bytes = count
            .checked_mul(pcm.channels * 4)
            .ok_or_else(|| AppError::invalid("PCM 读取过大"))?;
        if bytes > MAX_READ_BYTES {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "请分块读取 PCM（单次上限 4 MiB）",
            ));
        }
        let mut result = Vec::with_capacity(count * pcm.channels);
        let mut cursor = start;
        while cursor < end {
            let index = cursor / BLOCK_FRAMES as u64;
            let key = (pcm.path.clone(), index);
            self.clock += 1;
            let values = if let Some(block) = self.blocks.get_mut(&key) {
                block.used = self.clock;
                block.values.clone()
            } else {
                let first = index * BLOCK_FRAMES as u64;
                let frames = (pcm.frames - first).min(BLOCK_FRAMES as u64) as usize;
                let mut bytes = vec![0_u8; frames * pcm.channels * 4];
                let mut file = File::open(&pcm.path).map_err(io_error)?;
                file.seek(SeekFrom::Start(first * pcm.channels as u64 * 4))
                    .map_err(io_error)?;
                file.read_exact(&mut bytes).map_err(io_error)?;
                let values = Arc::new(
                    bytes
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                        .collect::<Vec<_>>(),
                );
                if bytes.len() <= self.budget {
                    while self.bytes + bytes.len() > self.budget {
                        let oldest = self
                            .blocks
                            .iter()
                            .min_by_key(|(_, b)| b.used)
                            .map(|(k, _)| k.clone())
                            .unwrap();
                        self.bytes -= self.blocks.remove(&oldest).unwrap().values.len() * 4;
                    }
                    self.bytes += bytes.len();
                    self.blocks.insert(
                        key,
                        Block {
                            values: values.clone(),
                            used: self.clock,
                        },
                    );
                }
                values
            };
            let offset = (cursor % BLOCK_FRAMES as u64) as usize;
            let take = (end - cursor).min((values.len() / pcm.channels - offset) as u64) as usize;
            result
                .extend_from_slice(&values[offset * pcm.channels..(offset + take) * pcm.channels]);
            cursor += take as u64;
        }
        Ok(result)
    }
}
fn io_error(_: std::io::Error) -> AppError {
    AppError::new(ErrorCode::DecodeFailed, "PCM 缓存读取失败，请重新导入")
}
