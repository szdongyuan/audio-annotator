use super::*;
use crate::media::identity::check_cancel;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::AtomicBool,
};

/// An owned temporary original-byte copy. Hold this lease through pending catalog
/// publication/retry/release, not merely decoding. Never persist its path as a sourceRef.
#[derive(Debug)]
pub struct StagedAudio {
    directory: PathBuf,
    path: PathBuf,
    marker: PathBuf,
    pub sha256: String,
}
impl StagedAudio {
    pub fn path(&self) -> &Path {
        &self.path
    }
    fn create(parent: &Path, extension: &str) -> Result<Self> {
        let parent = parent.canonicalize().map_err(io)?;
        safe_ancestors(&parent)?;
        let token = uuid::Uuid::new_v4();
        let directory = parent.join(format!(".source-import-{token}"));
        fs::create_dir(&directory).map_err(io)?;
        let marker = directory.join(format!(".owner-{token}"));
        if let Err(error) = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
        {
            let _ = fs::remove_dir(&directory);
            return Err(io(error));
        }
        Ok(Self {
            path: directory.join(format!("audio.{extension}")),
            directory,
            marker,
            sha256: String::new(),
        })
    }
}
impl Drop for StagedAudio {
    fn drop(&mut self) {
        // Never recurse: even an unrelated file appearing in our directory survives.
        if safe_ancestors(&self.directory).is_ok()
            && self
                .directory
                .canonicalize()
                .is_ok_and(|p| p == self.directory)
            && fs::symlink_metadata(&self.marker)
                .is_ok_and(|m| m.is_file() && !reparse(&m) && m.len() == 0)
        {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_file(&self.marker);
            let _ = fs::remove_dir(&self.directory);
        }
    }
}
pub(super) fn safe_ancestors(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        if reparse(&fs::symlink_metadata(ancestor).map_err(io)?) {
            return Err(AppError::invalid("源路径包含链接或重解析点，请重新扫描"));
        }
    }
    Ok(())
}
fn changed(stamp: &SourceStamp, path: &Path) -> Result<()> {
    stamp
        .verify(path)
        .map_err(|_| AppError::new(ErrorCode::IdentityMismatch, "导入源已改变，请重新扫描"))
}
impl ScanResult {
    pub fn stage(
        &self,
        index: usize,
        parent: &Path,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64),
    ) -> Result<StagedAudio> {
        check_cancel(cancel)?;
        let candidate = self
            .candidates
            .get(index)
            .ok_or_else(|| AppError::invalid("候选音频索引越界"))?;
        let entry = &self.entries[index];
        let source = &self.sources[candidate.source_index];
        let record = entry
            .path
            .rsplit_once('/')
            .and_then(|(p, _)| p.rsplit_once('/'))
            .map(|(p, _)| p)
            .unwrap_or("")
            .to_lowercase();
        let manifest = if candidate.logical_position.is_some() {
            source.manifests.get(&record)
        } else {
            None
        };
        safe_ancestors(&source.path)?;
        if let Some((path, stamp)) = manifest {
            safe_ancestors(path)?;
            changed(stamp, path)?;
        }
        let extension = entry.path.rsplit_once('.').unwrap().1.to_ascii_lowercase();
        let mut lease = StagedAudio::create(parent, &extension)?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&lease.path)
            .map_err(io)?;
        lease.sha256 = match source.kind {
            SourceKind::Folder => {
                let path = source.path.join(&entry.path);
                safe_ancestors(&path)?;
                let stamp = entry.stamp.as_ref().unwrap();
                changed(stamp, &path)?;
                let hash = copy(
                    File::open(&path).map_err(io)?,
                    &mut output,
                    entry.size,
                    self.limits,
                    cancel,
                    &mut progress,
                )?;
                safe_ancestors(&path)?;
                changed(stamp, &path)?;
                hash
            }
            SourceKind::Zip => {
                let stamp = source.stamp.as_ref().unwrap();
                changed(stamp, &source.path)?;
                let mut archive = zip::ZipArchive::new(File::open(&source.path).map_err(io)?)
                    .map_err(zip_error)?;
                let file = archive
                    .by_index(entry.zip_index.unwrap())
                    .map_err(zip_error)?;
                if file.name() != entry.path
                    || file.size() != entry.size
                    || !file.is_file()
                    || file.is_symlink()
                    || file.encrypted()
                {
                    return Err(invalid("ZIP 条目已改变，请重新扫描"));
                }
                let hash = copy(
                    file,
                    &mut output,
                    entry.size,
                    self.limits,
                    cancel,
                    &mut progress,
                )?;
                safe_ancestors(&source.path)?;
                changed(stamp, &source.path)?;
                hash
            }
        };
        check_cancel(cancel)?;
        if let Some((path, stamp)) = manifest {
            safe_ancestors(path)?;
            changed(stamp, path)?;
        }
        output.sync_all().map_err(io)?;
        drop(output);
        Ok(lease)
    }
}
fn copy(
    mut input: impl Read,
    output: &mut File,
    expected: u64,
    limits: Limits,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(u64),
) -> Result<String> {
    let mut buffer = [0; 65536];
    let mut count = 0u64;
    let mut hash = Sha256::new();
    loop {
        check_cancel(cancel)?;
        let n = input
            .read(&mut buffer)
            .map_err(|e| invalid(format!("音频读取或 ZIP CRC 校验失败：{e}")))?;
        if n == 0 {
            break;
        }
        count = count
            .checked_add(n as u64)
            .filter(|n| *n <= limits.audio_bytes && *n <= limits.selected_bytes)
            .ok_or_else(limit)?;
        if count > expected {
            return Err(invalid("音频实际长度超过声明长度"));
        }
        output.write_all(&buffer[..n]).map_err(io)?;
        hash.update(&buffer[..n]);
        progress(count);
    }
    check_cancel(cancel)?;
    if count != expected {
        return Err(invalid("音频实际长度与声明长度不符"));
    }
    Ok(format!("{:x}", hash.finalize()))
}
