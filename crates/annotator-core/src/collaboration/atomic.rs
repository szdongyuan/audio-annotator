//! Same-directory immutable publication. Cleanup only ever names our own temporary file.
use super::validation::{limit, require};
use crate::error::{AppError, ErrorCode, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishFault {
    PartialWrite,
    Sync,
    Rename,
    AfterPublish,
    CancelAfterWrite,
}

pub(crate) fn io(error: std::io::Error) -> AppError {
    let mut error = AppError::new(
        ErrorCode::SaveFailed,
        format!("Collaboration I/O failed: {error}"),
    );
    error.retryable = true;
    error
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
pub fn safe_existing(path: &Path) -> Result<()> {
    // Check every existing ancestor, including the caller-supplied root before canonicalizing it.
    for part in path.ancestors() {
        if part.as_os_str().is_empty() {
            continue;
        }
        let metadata = fs::symlink_metadata(part).map_err(io)?;
        require(!is_link(&metadata), "Symlink/reparse paths are forbidden")?;
    }
    Ok(())
}
pub(crate) fn ensure_dir(path: &Path) -> Result<()> {
    safe_existing(
        path.parent()
            .ok_or_else(|| AppError::invalid("Missing parent directory"))?,
    )?;
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(io(e)),
    }
    safe_existing(path)?;
    require(
        fs::metadata(path).map_err(io)?.is_dir(),
        "Expected collaboration directory",
    )
}
pub(crate) fn read(path: &Path, max: usize) -> Result<Vec<u8>> {
    safe_existing(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(io)?;
    let metadata = file.metadata().map_err(io)?;
    require(
        metadata.is_file() && !is_link(&metadata),
        "Expected regular collaboration file",
    )?;
    limit(metadata.len() <= max as u64)?;
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    limit(bytes.len() <= max)?;
    safe_existing(path)?;
    Ok(bytes)
}
pub(crate) fn lock(path: &Path) -> Result<File> {
    safe_existing(
        path.parent()
            .ok_or_else(|| AppError::invalid("Missing lock parent"))?,
    )?;
    if path.try_exists().map_err(io)? {
        safe_existing(path)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000).share_mode(0x1 | 0x2);
    }
    let file = options.open(path).map_err(io)?;
    require(
        file.metadata().map_err(io)?.is_file() && !is_link(&file.metadata().map_err(io)?),
        "Invalid lock file",
    )?;
    file.try_lock().map_err(|_| {
        AppError::new(
            ErrorCode::ProjectLocked,
            "This author already has a writable session, or its OS lock is unavailable",
        )
    })?;
    safe_existing(path)?;
    Ok(file)
}
pub(crate) fn verify_lock_path(path: &Path, held: &File) -> Result<()> {
    safe_existing(path)?;
    let current = File::open(path).map_err(io)?;
    #[cfg(windows)]
    let same = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        fn identity(file: &File) -> Result<(u32, u32, u32)> {
            // The OS fills a fixed-layout output record; both handles remain live throughout.
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
                return Err(io(std::io::Error::last_os_error()));
            }
            Ok((
                info.dwVolumeSerialNumber,
                info.nFileIndexHigh,
                info.nFileIndexLow,
            ))
        }
        identity(held)? == identity(&current)?
    };
    #[cfg(not(windows))]
    let same = {
        use std::os::unix::fs::MetadataExt;
        let a = held.metadata().map_err(io)?;
        let b = current.metadata().map_err(io)?;
        a.dev() == b.dev() && a.ino() == b.ino()
    };
    require(same, "Writer lock file authority changed")
}
fn check(
    fault: Option<PublishFault>,
    point: PublishFault,
    cancel: Option<&AtomicBool>,
) -> Result<()> {
    if cancel.is_some_and(|c| c.load(Ordering::Acquire))
        || (fault == Some(PublishFault::CancelAfterWrite) && point == PublishFault::PartialWrite)
    {
        return Err(AppError::new(ErrorCode::Cancelled, "Publication cancelled"));
    }
    if fault == Some(point) {
        return Err(io(std::io::Error::other(format!(
            "Injected publication fault: {point:?}"
        ))));
    }
    Ok(())
}
/// Create a new immutable file, never replace one. Also used by collaboration creation.
pub fn publish_new(
    path: &Path,
    bytes: &[u8],
    fault: Option<PublishFault>,
    cancel: Option<&AtomicBool>,
) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::invalid("Missing publication parent"))?;
    safe_existing(parent)?;
    if cancel.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err(AppError::new(ErrorCode::Cancelled, "Publication cancelled"));
    }
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut owned = false;
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)
            .map_err(io)?;
        owned = true;
        let split = bytes.len() / 2;
        file.write_all(&bytes[..split]).map_err(io)?;
        check(fault, PublishFault::PartialWrite, cancel)?;
        file.write_all(&bytes[split..]).map_err(io)?;
        file.flush().map_err(io)?;
        check(fault, PublishFault::Sync, cancel)?;
        file.sync_all().map_err(io)?;
        drop(file);
        check(fault, PublishFault::Rename, cancel)?;
        safe_existing(parent)?;
        no_replace(&tmp, path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::new(
                    ErrorCode::RevisionConflict,
                    "Immutable publication already exists",
                )
            } else {
                io(e)
            }
        })?;
        check(fault, PublishFault::AfterPublish, None)
    })();
    if owned {
        let _ = fs::remove_file(&tmp);
    }
    result
}
#[cfg(windows)]
fn no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let from: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<_> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Deliberately omit MOVEFILE_REPLACE_EXISTING: the destination is a compare-and-create boundary.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    // Hard-link creation is atomic and fails if the destination exists; rename would overwrite.
    fs::hard_link(source, target)?;
    fs::remove_file(source)?;
    File::open(target.parent().unwrap())?.sync_all()
}
