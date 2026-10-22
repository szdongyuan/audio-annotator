use super::{io, limit, zip_error, Limits, Manifest};
use crate::{
    error::{AppError, ErrorCode, Result},
    media::identity::{check_cancel, fingerprint, SourceStamp},
    model::ProjectDocument,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

pub(crate) fn encode(doc: &ProjectDocument, bundle: bool, limits: Limits) -> Result<Vec<u8>> {
    let manifest = Manifest::capture(doc, bundle)?;
    // Serialize through a bounded writer, not an unbounded allocation for huge notes.
    struct Bounded {
        bytes: Vec<u8>,
        max: u64,
    }
    impl Write for Bounded {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            if self.bytes.len() as u64 + b.len() as u64 > self.max {
                return Err(std::io::Error::other("manifest limit"));
            }
            self.bytes.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded {
        bytes: Vec::new(),
        max: limits.manifest_bytes,
    };
    serde_json::to_writer_pretty(&mut output, &manifest).map_err(|_| limit())?;
    Ok(output.bytes)
}
struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn publish(
    target: &Path,
    cancel: &AtomicBool,
    write: impl FnOnce(File) -> Result<()>,
) -> Result<()> {
    check_cancel(cancel)?;
    let parent = target
        .parent()
        .ok_or_else(|| AppError::invalid("缺少导出目录"))?
        .canonicalize()
        .map_err(io)?;
    let name = target
        .file_name()
        .ok_or_else(|| AppError::invalid("缺少导出文件名"))?;
    let target = parent.join(name);
    if target.try_exists().map_err(io)? {
        return Err(AppError::invalid(
            "目标已存在，请选择新的文件名；不会覆盖现有文件",
        ));
    }
    let temp = TemporaryFile(parent.join(format!(".exchange-{}.tmp", uuid::Uuid::new_v4())));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .map_err(io)?;
    write(file)?;
    check_cancel(cancel)?;
    publish_no_replace(&temp.0, &target).map_err(io)?;
    Ok(())
}
#[cfg(windows)]
fn publish_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let from: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Same canonical parent/volume. No REPLACE_EXISTING and no COPY_ALLOWED:
    // publication refuses a racing target and never falls back to a partial copy.
    // Unlike hard links, this primitive also works on FAT/exFAT volumes.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn publish_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    // rename() may replace a racing target on Unix; hard-link publication cannot.
    fs::hard_link(source, target)
}
pub fn export_annotations(
    doc: &ProjectDocument,
    target: &Path,
    cancel: &AtomicBool,
    limits: Limits,
    mut progress: impl FnMut(&str, u64),
) -> Result<()> {
    let bytes = encode(doc, false, limits)?;
    publish(target, cancel, |mut file| {
        file.write_all(&bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
        progress("清单", bytes.len() as u64);
        Ok(())
    })
}
pub fn export_bundle(
    doc: &ProjectDocument,
    root: &Path,
    target: &Path,
    cancel: &AtomicBool,
    limits: Limits,
    mut progress: impl FnMut(&str, u64),
) -> Result<()> {
    let manifest = encode(doc, true, limits)?;
    if doc.media.len() as u64 + 1 > limits.entries {
        return Err(limit());
    }
    let mut total = manifest.len() as u64;
    if total > limits.total_bytes {
        return Err(limit());
    }
    publish(target, cancel, |file| {
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o644);
        zip.start_file("manifest.json", options)
            .map_err(zip_error)?;
        zip.write_all(&manifest).map_err(io)?;
        for media in &doc.media {
            check_cancel(cancel)?;
            let source = Path::new(&media.source_ref);
            let source = if source.is_absolute() {
                source.to_path_buf()
            } else {
                root.join(source)
            };
            let stamp = SourceStamp::read(&source)?;
            if stamp.bytes > limits.media_bytes {
                return Err(limit());
            }
            if stamp.bytes != media.byte_length
                || fingerprint(&source, cancel, |n| progress("校验原文件", n))? != media.sha256
            {
                return Err(AppError::new(
                    ErrorCode::IdentityMismatch,
                    "源音频指纹已改变",
                ));
            }
            stamp.verify(&source)?;
            zip.start_file(
                super::manifest::media_path(&media.id),
                options.large_file(media.byte_length >= u32::MAX as u64),
            )
            .map_err(zip_error)?;
            let mut input = File::open(&source).map_err(io)?;
            let mut hash = Sha256::new();
            let mut count = 0;
            let mut buffer = [0; 65536];
            loop {
                check_cancel(cancel)?;
                let n = input.read(&mut buffer).map_err(io)?;
                if n == 0 {
                    break;
                }
                count += n as u64;
                total += n as u64;
                if count > limits.media_bytes || total > limits.total_bytes {
                    return Err(limit());
                }
                hash.update(&buffer[..n]);
                zip.write_all(&buffer[..n]).map_err(io)?;
                progress("复制原始媒体", total);
            }
            stamp.verify(&source)?;
            if count != media.byte_length || format!("{:x}", hash.finalize()) != media.sha256 {
                return Err(AppError::new(
                    ErrorCode::IdentityMismatch,
                    "复制期间源音频已改变",
                ));
            }
        }
        zip.finish().map_err(zip_error)?.sync_all().map_err(io)?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    #[test]
    fn publication_refuses_a_target_created_during_write_and_cleans_only_its_temp() {
        let root = std::env::temp_dir().join(format!("exchange-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let target = root.join("shared.json");
        let result = publish(&target, &AtomicBool::new(false), |mut file| {
            file.write_all(b"our export").map_err(io)?;
            file.sync_all().map_err(io)?;
            fs::write(&target, b"other writer").map_err(io)?;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"other writer");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn publication_cleans_partial_and_cancelled_files_and_moves_complete_bytes() {
        let root = std::env::temp_dir().join(format!("exchange-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let target = root.join("shared.json");
        let cancel = AtomicBool::new(false);
        assert!(publish(&target, &cancel, |mut file| {
            file.write_all(b"partial").map_err(io)?;
            Err(io(std::io::Error::other("injected write failure")))
        })
        .is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(
            publish(&target, &cancel, |mut file| {
                file.write_all(b"cancelled").map_err(io)?;
                file.sync_all().map_err(io)?;
                cancel.store(true, Ordering::Relaxed);
                Ok(())
            })
            .unwrap_err()
            .code,
            ErrorCode::Cancelled
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        cancel.store(false, Ordering::Relaxed);
        publish(&target, &cancel, |mut file| {
            file.write_all(b"complete").map_err(io)?;
            file.sync_all().map_err(io)
        })
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"complete");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
