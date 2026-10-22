use crate::error::{AppError, Result};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, FileTimes, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::Arc,
    time::SystemTime,
};
pub const TILE_CACHE_BYTES: usize = 128 * 1024 * 1024;
pub const DISK_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
struct Entry {
    bytes: Arc<Vec<u8>>,
    used: u64,
}
/// Root is a dedicated disposable cache directory. Only regular <sha256>.tile files
/// are touched; project media, directories and links are never eviction candidates.
pub struct TileCache {
    root: PathBuf,
    memory: HashMap<String, Entry>,
    budget: usize,
    disk_budget: u64,
    bytes: usize,
    clock: u64,
}
impl TileCache {
    fn touch(path: &std::path::Path) {
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file()) {
            let _ = OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|f| f.set_times(FileTimes::new().set_modified(SystemTime::now())));
        }
    }
    pub fn new(root: PathBuf, budget: usize, disk_budget: u64) -> Result<Self> {
        fs::create_dir_all(&root).map_err(io_error)?;
        let cache = Self {
            root,
            memory: HashMap::new(),
            budget,
            disk_budget,
            bytes: 0,
            clock: 0,
        };
        cache.trim_disk()?;
        Ok(cache)
    }
    pub fn resident_bytes(&self) -> usize {
        self.bytes
    }
    pub fn clear_memory(&mut self) {
        self.memory.clear();
        self.bytes = 0;
    }
    fn valid(key: &str) -> bool {
        key.len() == 64
            && key
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }
    fn path(&self, key: &str) -> Result<PathBuf> {
        if !Self::valid(key) {
            return Err(AppError::invalid("无效缓存键"));
        }
        Ok(self.root.join(format!("{key}.tile")))
    }
    fn remember(&mut self, key: &str, bytes: Arc<Vec<u8>>) {
        if bytes.len() > self.budget {
            return;
        }
        if let Some(old) = self.memory.remove(key) {
            self.bytes -= old.bytes.len();
        }
        while self.bytes + bytes.len() > self.budget {
            let oldest = self
                .memory
                .iter()
                .min_by_key(|(_, e)| e.used)
                .unwrap()
                .0
                .clone();
            self.bytes -= self.memory.remove(&oldest).unwrap().bytes.len();
        }
        self.clock += 1;
        self.bytes += bytes.len();
        self.memory.insert(
            key.into(),
            Entry {
                bytes,
                used: self.clock,
            },
        );
    }
    pub fn get(&mut self, key: &str) -> Result<Option<Arc<Vec<u8>>>> {
        let path = self.path(key)?;
        self.clock += 1;
        if let Some(entry) = self.memory.get_mut(key) {
            entry.used = self.clock;
            Self::touch(&path);
            return Ok(Some(entry.bytes.clone()));
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_error(e)),
        };
        if !metadata.file_type().is_file() {
            return Ok(None);
        }
        if metadata.len() < 32 || metadata.len() > super::tiles::MAX_RESPONSE_BYTES as u64 + 32 {
            let _ = fs::remove_file(path);
            return Ok(None);
        }
        let mut raw = Vec::new();
        File::open(&path)
            .map_err(io_error)?
            .take(super::tiles::MAX_RESPONSE_BYTES as u64 + 33)
            .read_to_end(&mut raw)
            .map_err(io_error)?;
        if raw.len() < 32
            || raw.len() > super::tiles::MAX_RESPONSE_BYTES + 32
            || Sha256::digest(&raw[32..])[..] != raw[..32]
        {
            let _ = fs::remove_file(path);
            return Ok(None);
        }
        let bytes = Arc::new(raw[32..].to_vec());
        Self::touch(&path);
        self.remember(key, bytes.clone());
        Ok(Some(bytes))
    }
    pub fn put(&mut self, key: &str, bytes: Vec<u8>) -> Result<()> {
        let path = self.path(key)?;
        if bytes.len() > super::tiles::MAX_RESPONSE_BYTES {
            return Err(AppError::invalid("缓存 tile 过大"));
        }
        if bytes.len() as u64 + 32 <= self.disk_budget {
            let temp = self.root.join(format!("{}.tmp", uuid::Uuid::new_v4()));
            let result = (|| {
                let mut out = File::create(&temp)?;
                out.write_all(&Sha256::digest(&bytes))?;
                out.write_all(&bytes)?;
                out.flush()?;
                drop(out);
                if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) {
                    fs::remove_file(&path)?;
                }
                fs::rename(&temp, &path)
            })();
            if let Err(e) = result {
                let _ = fs::remove_file(temp);
                return Err(io_error(e));
            }
            self.trim_disk()?;
        }
        self.remember(key, Arc::new(bytes));
        Ok(())
    }
    fn files(&self) -> Result<Vec<(PathBuf, u64, SystemTime)>> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            let Some(key) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if path.extension().is_none_or(|s| s != "tile")
                || !Self::valid(key)
                || !entry.file_type().map_err(io_error)?.is_file()
            {
                continue;
            }
            let m = entry.metadata().map_err(io_error)?;
            files.push((
                path,
                m.len(),
                m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            ));
        }
        Ok(files)
    }
    pub fn disk_bytes(&self) -> Result<u64> {
        Ok(self.files()?.iter().map(|(_, n, _)| n).sum())
    }
    fn trim_disk(&self) -> Result<()> {
        let mut files = self.files()?;
        let mut total: u64 = files.iter().map(|(_, n, _)| n).sum();
        files.sort_by_key(|(_, _, time)| *time);
        for (path, n, _) in files {
            if total <= self.disk_budget {
                break;
            }
            fs::remove_file(path).map_err(io_error)?;
            total -= n;
        }
        Ok(())
    }
}
fn io_error(_: std::io::Error) -> AppError {
    AppError::invalid("分析缓存不可用，可清除缓存后重试")
}
