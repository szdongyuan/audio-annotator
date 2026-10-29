use crate::error::{AppError, ErrorCode, Result};
use std::{
    collections::{HashMap, HashSet},
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
    owners: HashMap<String, HashSet<PathBuf>>,
    retired: HashSet<String>,
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
            owners: HashMap::new(),
            retired: HashSet::new(),
        }
    }
    pub fn resident_bytes(&self) -> usize {
        self.bytes
    }
    pub fn clear(&mut self) {
        self.blocks.clear();
        self.bytes = 0;
        self.owners.clear();
        self.retired.clear();
    }
    pub fn remove_path(&mut self, path: &Path) {
        self.blocks.retain(|(p, _), block| {
            if p == path {
                self.bytes -= block.values.len() * 4;
                false
            } else {
                true
            }
        });
        self.forget_path(path);
    }
    fn forget_path(&mut self, path: &Path) {
        self.owners.retain(|_, paths| {
            paths.remove(path);
            !paths.is_empty()
        });
    }
    pub fn retire_media(&mut self, ids: &[String]) {
        for id in ids {
            self.retired.insert(id.clone());
            if let Some(paths) = self.owners.remove(id) {
                for path in paths {
                    if !self.owners.values().any(|paths| paths.contains(&path)) {
                        self.remove_path(&path);
                    }
                }
            }
        }
    }
    pub fn read_media_frames(
        &mut self,
        media_id: &str,
        pcm: &PcmFile,
        start: u64,
        count: usize,
    ) -> Result<Vec<f32>> {
        if self.retired.contains(media_id) {
            return Err(AppError::new(ErrorCode::Cancelled, "Media PCM retired"));
        }
        self.owners
            .entry(media_id.into())
            .or_default()
            .insert(pcm.path.clone());
        let result = self.read_frames(pcm, start, count);
        if !self.blocks.keys().any(|(path, _)| path == pcm.path()) {
            self.forget_path(pcm.path());
        }
        result
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
                        // The incoming block immediately replaces this path's
                        // last block. Preserve all shared owners across that
                        // replacement; forget only fully displaced paths.
                        if oldest.0.as_path() != pcm.path()
                            && !self.blocks.keys().any(|(path, _)| path == &oldest.0)
                        {
                            self.forget_path(&oldest.0);
                        }
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

#[cfg(test)]
mod retirement_tests {
    use super::*;
    fn pcm_blocks(blocks: usize, value: f32) -> PcmFile {
        let path = std::env::temp_dir().join(format!("eviction-pcm-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, value.to_le_bytes().repeat(blocks * BLOCK_FRAMES)).unwrap();
        PcmFile::new(path, (blocks * BLOCK_FRAMES) as u64, 1)
    }
    #[test]
    fn interleaved_block_replacement_keeps_a_retirable_and_b_cached() {
        let a = pcm_blocks(2, 0.);
        let b = pcm_blocks(1, 1.);
        let block_bytes = BLOCK_FRAMES * 4;
        let mut cache = PcmCache::new(2 * block_bytes);
        cache.read_media_frames("a", &a, 0, 1).unwrap();
        cache.read_media_frames("b", &b, 0, 1).unwrap();
        cache
            .read_media_frames("a", &a, BLOCK_FRAMES as u64, 1)
            .unwrap();
        assert_eq!(cache.resident_bytes(), 2 * block_bytes);
        cache.retire_media(&["a".into()]);
        assert_eq!(
            cache.resident_bytes(),
            block_bytes,
            "only B's block remains"
        );
        std::fs::remove_file(b.path()).unwrap();
        assert_eq!(cache.read_media_frames("b", &b, 0, 1).unwrap(), vec![1.]);
        cache.retire_media(&["b".into()]);
        assert_eq!(cache.resident_bytes(), 0);
    }
    #[test]
    fn same_path_block_replacement_preserves_all_shared_owners() {
        let pcm = pcm_blocks(2, 1.);
        let block_bytes = BLOCK_FRAMES * 4;
        let mut cache = PcmCache::new(block_bytes);
        cache.read_media_frames("a", &pcm, 0, 1).unwrap();
        cache.read_media_frames("b", &pcm, 0, 1).unwrap();
        cache
            .read_media_frames("a", &pcm, BLOCK_FRAMES as u64, 1)
            .unwrap();
        assert_eq!(
            cache.owners.len(),
            2,
            "replacement retains both path owners"
        );
        cache.retire_media(&["a".into()]);
        assert_eq!(cache.resident_bytes(), block_bytes);
        std::fs::remove_file(pcm.path()).unwrap();
        assert_eq!(
            cache
                .read_media_frames("b", &pcm, BLOCK_FRAMES as u64, 1)
                .unwrap(),
            vec![1.]
        );
        cache.retire_media(&["b".into()]);
        assert_eq!(cache.resident_bytes(), 0);
    }
    #[test]
    fn full_path_eviction_forgets_only_the_displaced_paths_owners() {
        let a = pcm_blocks(1, 0.);
        let b = pcm_blocks(1, 1.);
        let c = pcm_blocks(1, 2.);
        let mut cache = PcmCache::new(BLOCK_FRAMES * 4);
        cache.read_media_frames("a", &a, 0, 1).unwrap();
        cache.read_media_frames("a-shared", &a, 0, 1).unwrap();
        cache.read_media_frames("b", &b, 0, 1).unwrap();
        cache.read_media_frames("c", &c, 0, 1).unwrap();
        assert_eq!(cache.owners.len(), 1);
        assert!(cache.owners["c"].contains(c.path()));
        cache.retire_media(&["a".into(), "a-shared".into(), "b".into()]);
        assert_eq!(cache.resident_bytes(), BLOCK_FRAMES * 4);
        cache.retire_media(&["c".into()]);
        assert_eq!(cache.resident_bytes(), 0);
    }
    #[test]
    fn releasing_one_pcm_path_keeps_identical_survivor_blocks() {
        let root = std::env::temp_dir().join(format!("pcm-retire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let a = PcmFile::new(root.join("a"), 1, 1);
        let b = PcmFile::new(root.join("b"), 1, 1);
        std::fs::write(a.path(), 1f32.to_le_bytes()).unwrap();
        std::fs::write(b.path(), 1f32.to_le_bytes()).unwrap();
        let mut cache = PcmCache::new(1024);
        cache.read_frames(&a, 0, 1).unwrap();
        cache.read_frames(&b, 0, 1).unwrap();
        assert_eq!(cache.resident_bytes(), 8);
        cache.remove_path(a.path());
        assert_eq!(cache.resident_bytes(), 4);
        std::fs::remove_file(b.path()).unwrap();
        assert_eq!(cache.read_frames(&b, 0, 1).unwrap(), vec![1.]);
        drop(a);
        drop(b);
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn retired_owner_cannot_recache_and_shared_survivor_keeps_the_same_pcm_path() {
        let path = std::env::temp_dir().join(format!("shared-pcm-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, 1f32.to_le_bytes()).unwrap();
        let pcm = PcmFile::new(path, 1, 1);
        let mut cache = PcmCache::new(1024);
        cache.read_media_frames("a", &pcm, 0, 1).unwrap();
        cache.read_media_frames("b", &pcm, 0, 1).unwrap();
        cache.retire_media(&["a".into()]);
        assert_eq!(cache.resident_bytes(), 4);
        assert_eq!(
            cache.read_media_frames("a", &pcm, 0, 1).unwrap_err().code,
            ErrorCode::Cancelled
        );
        std::fs::remove_file(pcm.path()).unwrap();
        assert_eq!(cache.read_media_frames("b", &pcm, 0, 1).unwrap(), vec![1.]);
        cache.retire_media(&["b".into()]);
        assert_eq!(cache.resident_bytes(), 0);
    }
}
