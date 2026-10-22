use super::{invalid, io, limit, zip_error, Limits, Manifest};
use crate::{
    error::{AppError, ErrorCode, Result},
    media::{decode::decode, identity::check_cancel, registry::same_identity},
    model::ProjectDocument,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
#[derive(Debug)]
pub struct ImportedProject {
    pub document: ProjectDocument,
    pub path: PathBuf,
}
/// Cleanup is scoped to a freshly created canonical directory bearing our random ownership token.
struct Staging {
    path: PathBuf,
    token: String,
}
impl Staging {
    fn create(parent: &Path) -> Result<Self> {
        let token = uuid::Uuid::new_v4().to_string();
        let path = parent.join(format!(".exchange-{token}"));
        fs::create_dir(&path).map_err(|e| context(e, "创建暂存目录"))?;
        let stage = Self { path, token };
        // An empty exclusive marker needs no data write (including when storage is exhausted).
        if let Err(error) = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.path.join(stage.marker()))
        {
            // Before a marker exists, only remove an empty directory we just created.
            if stage.path.canonicalize().is_ok_and(|p| p == stage.path) {
                let _ = fs::remove_dir(&stage.path);
            }
            return Err(io(error));
        }
        Ok(stage)
    }
    fn marker(&self) -> String {
        format!(".exchange-owner-{}", self.token)
    }
    fn owned(&self) -> bool {
        self.path
            .symlink_metadata()
            .is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
            && self.path.canonicalize().is_ok_and(|p| p == self.path)
            && self
                .path
                .join(self.marker())
                .symlink_metadata()
                .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() == 0)
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        if self.owned() {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
fn read_manifest(input: impl Read, limits: Limits) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input
        .take(limits.manifest_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > limits.manifest_bytes {
        return Err(limit());
    }
    Ok(bytes)
}
pub fn import_exchange(
    source: &Path,
    parent: &Path,
    cancel: &AtomicBool,
    limits: Limits,
    mut progress: impl FnMut(&str, u64),
) -> Result<ImportedProject> {
    check_cancel(cancel)?;
    let parent = parent.canonicalize().map_err(io)?;
    let mut file = File::open(source).map_err(io)?;
    let mut magic = [0; 4];
    let n = file.read(&mut magic).map_err(io)?;
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    let bundle = n == 4 && &magic[..2] == b"PK";
    let stage = Staging::create(&parent)?;
    let manifest = if bundle {
        let entries = super::limits::preflight(&mut file, limits)?;
        let mut zip = zip::ZipArchive::new(file).map_err(zip_error)?;
        if zip.len() != entries {
            return Err(invalid("重复 ZIP 条目"));
        }
        let bytes = read_manifest(zip.by_name("manifest.json").map_err(zip_error)?, limits)?;
        let manifest = Manifest::parse(&bytes, true)?;
        let document = manifest.document(false)?;
        let allowed: HashSet<_> = manifest
            .media
            .iter()
            .map(|m| super::manifest::media_path(&m.id))
            .chain(std::iter::once("manifest.json".to_owned()))
            .collect();
        if entries != allowed.len() || zip.file_names().any(|n| !allowed.contains(n)) {
            return Err(invalid("包内文件缺失或包含未声明条目"));
        }
        let mut total = bytes.len() as u64;
        if total > limits.total_bytes {
            return Err(limit());
        }
        fs::create_dir(stage.path.join("media")).map_err(io)?;
        for media in &document.media {
            check_cancel(cancel)?;
            if media.byte_length > limits.media_bytes {
                return Err(limit());
            }
            let mut entry = zip.by_name(&media.source_ref).map_err(zip_error)?;
            if entry.is_symlink() || !entry.is_file() || entry.size() != media.byte_length {
                return Err(invalid("媒体条目类型或长度不符"));
            }
            let path = stage.path.join(&media.source_ref);
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(io)?;
            let mut count = 0;
            let mut hash = Sha256::new();
            let mut buffer = [0; 65536];
            loop {
                check_cancel(cancel)?;
                let n = entry
                    .read(&mut buffer)
                    .map_err(|e| invalid(format!("ZIP 解压或 CRC 校验失败：{e}")))?;
                if n == 0 {
                    break;
                }
                count += n as u64;
                total += n as u64;
                if count > limits.media_bytes || total > limits.total_bytes {
                    return Err(limit());
                }
                hash.update(&buffer[..n]);
                output.write_all(&buffer[..n]).map_err(io)?;
                progress("校验并提取媒体", total);
            }
            output.sync_all().map_err(io)?;
            drop(output);
            if count != media.byte_length || format!("{:x}", hash.finalize()) != media.sha256 {
                return Err(AppError::new(
                    ErrorCode::IdentityMismatch,
                    "包内音频指纹不一致",
                ));
            }
            // Verify claimed channel/rate/frame metadata with the same decoder used by relink.
            let decoded = decode(
                &path,
                &stage.path.join(".validation"),
                cancel,
                |phase, n| progress(phase, n),
            )?;
            if !same_identity(media, &decoded.descriptor) {
                return Err(AppError::new(
                    ErrorCode::IdentityMismatch,
                    "包内音频元数据不一致",
                ));
            }
        }
        if stage.path.join(".validation").exists() {
            fs::remove_dir_all(stage.path.join(".validation"))
                .map_err(|e| context(e, "清理验证缓存"))?;
        }
        manifest
    } else {
        Manifest::parse(&read_manifest(file, limits)?, false)?
    };
    let document = manifest.document(true)?;
    let bytes = serde_json::to_vec_pretty(&document).map_err(|_| invalid("项目编码失败"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(limit());
    }
    let mut project = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(stage.path.join("project.json"))
        .map_err(io)?;
    project.write_all(&bytes).map_err(io)?;
    project.sync_all().map_err(io)?;
    drop(project);
    progress("发布独立项目", bytes.len() as u64);
    check_cancel(cancel)?;
    if !stage.owned() {
        return Err(invalid("暂存目录身份已改变"));
    }
    let path = parent.join(format!("imported-{}", document.project_id));
    if path.try_exists().map_err(io)? {
        return Err(invalid("目标项目已存在"));
    }
    fs::rename(&stage.path, &path).map_err(|e| context(e, "发布项目目录"))?;
    // Only an ownership marker is removed after publication; media and project are now durable.
    let _ = fs::remove_file(path.join(stage.marker()));
    Ok(ImportedProject { document, path })
}
fn context(error: std::io::Error, phase: &str) -> AppError {
    let mut error = io(error);
    error.message = format!("{phase}：{}", error.message);
    error
}
