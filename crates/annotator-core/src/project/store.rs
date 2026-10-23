use super::{
    lock::ProjectLock,
    recovery::{self, LoadReport, RecoveryCandidate, RecoverySource},
};
use crate::{
    error::{AppError, ErrorCode, Result},
    model::ProjectDocument,
};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    RecoveryWrite,
    RecoverySync,
    RecoveryReplace,
    BackupWrite,
    BackupSync,
    BackupReplace,
    MainWrite,
    MainSync,
    MainReplace,
}
pub struct FileStore {
    root: PathBuf,
    _lock: ProjectLock,
    project_id: String,
    persisted_revision: u64,
    fault: Option<FaultPoint>,
}
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
fn check_size(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(AppError::new(
            ErrorCode::ResourceLimit,
            "项目文件超出 32 MiB 限制",
        ));
    }
    Ok(())
}
pub(crate) fn io_error(error: std::io::Error) -> AppError {
    let mut e = AppError::new(ErrorCode::SaveFailed, format!("无法读写项目文件：{error}"));
    e.retryable = true;
    e
}
fn read(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(io_error)?
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    check_size(&bytes)?;
    Ok(bytes)
}
fn primary(root: &Path) -> Result<ProjectDocument> {
    let bytes = read(&root.join("project.json"))?;
    ProjectDocument::from_json(
        std::str::from_utf8(&bytes).map_err(|_| AppError::invalid("项目文件不是 UTF-8"))?,
    )
}
impl FileStore {
    pub fn create(root: &Path, document: &ProjectDocument) -> Result<Self> {
        document.validate()?;
        let root = root.canonicalize().map_err(io_error)?;
        let lock = ProjectLock::acquire(&root)?;
        if fs::read_dir(&root)
            .map_err(io_error)?
            .any(|e| e.map(|e| e.file_name() != ".project.lock").unwrap_or(true))
        {
            return Err(AppError::invalid(
                "请选择空文件夹；现有项目和文件不会被覆盖",
            ));
        }
        let mut store = Self {
            root,
            _lock: lock,
            project_id: document.project_id.clone(),
            persisted_revision: 0,
            fault: None,
        };
        store.save(document)?;
        Ok(store)
    }
    pub fn open(root: &Path) -> Result<(Self, LoadReport)> {
        let root = root.canonicalize().map_err(io_error)?;
        let lock = ProjectLock::acquire(&root)?;
        let result = primary(&root);
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e.code == ErrorCode::UnsupportedVersion)
        {
            return Err(result.unwrap_err());
        }
        let (primary, primary_error) = match result {
            Ok(d) => (Some(d), None),
            Err(e) => (None, Some(e)),
        };
        let mut candidates = Vec::new();
        for (name, source) in [
            ("recovery.json", RecoverySource::Recovery),
            ("project.json.bak", RecoverySource::Backup),
        ] {
            if let Ok(doc) = read(&root.join(name)).and_then(|b| recovery::decode(&b)) {
                if primary
                    .as_ref()
                    .is_none_or(|p| p.project_id == doc.project_id && doc.revision > p.revision)
                {
                    candidates.push(RecoveryCandidate {
                        source,
                        document: doc,
                    });
                }
            }
        }
        let identity = primary
            .as_ref()
            .or_else(|| candidates.first().map(|c| &c.document))
            .ok_or_else(|| {
                primary_error
                    .clone()
                    .unwrap_or_else(|| AppError::invalid("没有有效的项目文件"))
            })?;
        let project_id = identity.project_id.clone();
        candidates.retain(|c| c.document.project_id == project_id);
        let store = Self {
            root,
            _lock: lock,
            project_id,
            persisted_revision: primary.as_ref().map_or(0, |d| d.revision),
            fault: None,
        };
        Ok((
            store,
            LoadReport {
                primary,
                primary_error,
                candidates,
            },
        ))
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn persisted_revision(&self) -> u64 {
        self.persisted_revision
    }
    /// Deterministic I/O failures exercise production publication paths in integration tests.
    pub fn inject_fault(&mut self, fault: Option<FaultPoint>) {
        self.fault = fault;
    }
    fn check(&self, point: FaultPoint) -> Result<()> {
        if self.fault == Some(point) {
            return Err(io_error(std::io::Error::other(format!(
                "injected {point:?}"
            ))));
        }
        Ok(())
    }
    pub fn save(&mut self, document: &ProjectDocument) -> Result<()> {
        document.validate()?;
        if document.project_id != self.project_id {
            return Err(AppError::invalid("项目身份不匹配"));
        }
        if document.revision < self.persisted_revision {
            return Err(AppError::new(
                ErrorCode::RevisionConflict,
                "不能保存较旧的版本",
            ));
        }
        // Preflight all encodings before changing any existing recovery or primary.
        let recovery_bytes = recovery::encode(document)?;
        let bytes =
            serde_json::to_vec_pretty(document).map_err(|e| AppError::invalid(e.to_string()))?;
        check_size(&recovery_bytes)?;
        check_size(&bytes)?;
        let backup = primary(&self.root)
            .ok()
            .filter(|previous| {
                previous.project_id == self.project_id && previous.revision != document.revision
            })
            .map(|previous| recovery::encode(&previous))
            .transpose()?;
        if let Some(backup) = &backup {
            check_size(backup)?;
        }
        self.publish(
            "recovery.json",
            &recovery_bytes,
            [
                FaultPoint::RecoveryWrite,
                FaultPoint::RecoverySync,
                FaultPoint::RecoveryReplace,
            ],
        )?;
        // Never replace the last verified backup with a corrupted primary.
        if let Some(backup) = backup {
            self.publish(
                "project.json.bak",
                &backup,
                [
                    FaultPoint::BackupWrite,
                    FaultPoint::BackupSync,
                    FaultPoint::BackupReplace,
                ],
            )?;
        }
        self.publish(
            "project.json",
            &bytes,
            [
                FaultPoint::MainWrite,
                FaultPoint::MainSync,
                FaultPoint::MainReplace,
            ],
        )?;
        self.persisted_revision = document.revision;
        Ok(())
    }
    /// An explicit decision to keep the primary suppresses an otherwise recurring offer.
    pub fn keep_primary(&self, document: &ProjectDocument) -> Result<()> {
        document.validate()?;
        if document.project_id != self.project_id {
            return Err(AppError::invalid("项目身份不匹配"));
        }
        let bytes = recovery::encode(document)?;
        check_size(&bytes)?;
        self.publish(
            "recovery.json",
            &bytes,
            [
                FaultPoint::RecoveryWrite,
                FaultPoint::RecoverySync,
                FaultPoint::RecoveryReplace,
            ],
        )
    }
    fn publish(&self, name: &str, bytes: &[u8], points: [FaultPoint; 3]) -> Result<()> {
        check_size(bytes)?;
        let tmp = self
            .root
            .join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(io_error)?;
            // Write some bytes before the injected interruption to test partial-file cleanup.
            let split = bytes.len() / 2;
            file.write_all(&bytes[..split]).map_err(io_error)?;
            self.check(points[0])?;
            file.write_all(&bytes[split..]).map_err(io_error)?;
            file.flush().map_err(io_error)?;
            self.check(points[1])?;
            file.sync_all().map_err(io_error)?;
            drop(file);
            self.check(points[2])?;
            atomic_replace(&tmp, &self.root.join(name)).map_err(io_error)
        })();
        // Only our own temporary file; no glob cleanup of other writers' files.
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
}
#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Both paths share a canonical directory and volume. No delete-before-rename gap.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)?;
    fs::File::open(target.parent().unwrap())?.sync_all()
}
