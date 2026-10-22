use crate::error::{AppError, ErrorCode, Result};
use std::{
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
};

/// Keep the handle alive for the entire writable session. A stale file is harmless.
pub struct ProjectLock {
    _file: File,
}
impl ProjectLock {
    pub fn acquire(root: &Path) -> Result<Self> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(".project.lock"))
            .map_err(super::store::io_error)?;
        file.try_lock().map_err(|e| {
            AppError::new(
                ErrorCode::ProjectLocked,
                format!("项目正在另一窗口中使用，或无法取得写入锁：{e}"),
            )
        })?;
        file.set_len(0).map_err(super::store::io_error)?;
        file.seek(SeekFrom::Start(0))
            .map_err(super::store::io_error)?;
        write!(file, "pid={}", std::process::id()).map_err(super::store::io_error)?;
        file.sync_all().map_err(super::store::io_error)?;
        Ok(Self { _file: file })
    }
}
