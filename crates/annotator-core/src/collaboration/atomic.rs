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
pub(crate) fn is_link(metadata: &fs::Metadata) -> bool {
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
#[cfg(windows)]
fn reparse_attribute(path: &Path) -> Option<bool> {
    use std::{
        os::windows::ffi::OsStrExt,
        path::{Component, Prefix},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
    };
    // Only verbatim absolute paths have identical spelling for std and Win32 here.
    // In particular, retain std's normalization/error handling for ordinary paths.
    let mut components = path.components();
    let prefix = match components.next()? {
        Component::Prefix(prefix) => prefix.kind(),
        _ => return None,
    };
    if !matches!(prefix, Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _))
        || !matches!(components.next(), Some(Component::RootDir))
        || components
            .clone()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    // GetFileAttributesW cannot query a share root (ERROR_BAD_NETPATH).
    if matches!(prefix, Prefix::VerbatimUNC(_, _)) && components.next().is_none() {
        return None;
    }
    let mut wide: Vec<_> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return None;
    }
    wide.push(0);
    // The buffer is NUL terminated and lives throughout the call. This API reports
    // the named link's own attributes, not its target's attributes.
    let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
    (attributes != INVALID_FILE_ATTRIBUTES)
        .then_some(attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

pub fn safe_existing(path: &Path) -> Result<()> {
    // Check every existing ancestor, including the caller-supplied root before canonicalizing it.
    for part in path.ancestors() {
        if part.as_os_str().is_empty() {
            continue;
        }
        #[cfg(windows)]
        let link = reparse_attribute(part)
            .map(Ok)
            .unwrap_or_else(|| fs::symlink_metadata(part).map(|metadata| is_link(&metadata)))
            .map_err(io)?;
        #[cfg(not(windows))]
        let link = is_link(&fs::symlink_metadata(part).map_err(io)?);
        require(!link, "Symlink/reparse paths are forbidden")?;
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
/// Verify an exact held file identity before native owned-file cleanup.
pub fn verify_lock_path(path: &Path, held: &File) -> Result<()> {
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
pub(crate) fn no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
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
pub(crate) fn no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    // Hard-link creation is atomic and fails if the destination exists; rename would overwrite.
    fs::hard_link(source, target)?;
    fs::remove_file(source)?;
    File::open(target.parent().unwrap())?.sync_all()
}

#[cfg(all(test, windows))]
mod attribute_tests {
    use super::*;
    use std::os::windows::ffi::OsStringExt;
    #[test]
    fn attribute_fallback_preserves_owned_access_denied_errors() {
        if let Some(path) = std::env::var_os("ANNOTATOR_ATTRIBUTE_DENIED_FILE") {
            let path = Path::new(&path);
            let old = fs::symlink_metadata(path).unwrap_err();
            assert_eq!(old.kind(), std::io::ErrorKind::PermissionDenied);
            assert_eq!(reparse_attribute(path), None);
            assert!(safe_existing(path).is_err());
            return;
        }
        let root = std::env::temp_dir().join(format!("attribute-dacl-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = fs::canonicalize(&root).unwrap().join("owned-denied-file");
        fs::write(&file, b"owned fixture").unwrap();
        let script = r#"
$ErrorActionPreference='Stop'
$p=Split-Path -Parent $env:ANNOTATOR_ATTRIBUTE_FIXTURE
$original=Get-Acl -LiteralPath $p
$sddl=$original.Sddl
try {
    $denied=Get-Acl -LiteralPath $p
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Deny)
    $denied.AddAccessRule($rule)
    Set-Acl -LiteralPath $p -AclObject $denied
    $env:ANNOTATOR_ATTRIBUTE_DENIED_FILE=$env:ANNOTATOR_ATTRIBUTE_FIXTURE
    & $env:ANNOTATOR_ATTRIBUTE_TEST_EXE --exact collaboration::atomic::attribute_tests::attribute_fallback_preserves_owned_access_denied_errors --nocapture
    if($LASTEXITCODE -ne 0){throw 'Denied-file characterization failed'}
} finally {
    Set-Acl -LiteralPath $p -AclObject $original
    if((Get-Acl -LiteralPath $p).Sddl -ne $sddl){throw 'Exact owned DACL restoration failed'}
}
"#;
        let result = std::process::Command::new("pwsh")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("ANNOTATOR_ATTRIBUTE_FIXTURE", &file)
            .env(
                "ANNOTATOR_ATTRIBUTE_TEST_EXE",
                std::env::current_exe().unwrap(),
            )
            .output()
            .unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
    #[test]
    fn canonical_attribute_checks_match_metadata_and_reject_reparse_ancestors() {
        let root = std::env::temp_dir().join(format!("attribute-parity-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let unicode = root.join("原始音频-é-🎵");
        fs::create_dir(&unicode).unwrap();
        let file = unicode.join("source.wav");
        fs::write(&file, b"sample").unwrap();
        let long = (0..12).fold(unicode.clone(), |p, _| p.join("long-directory-segment"));
        fs::create_dir_all(&long).unwrap();
        fs::write(long.join("leaf"), b"sample").unwrap();
        for path in [&file, &long.join("leaf")] {
            for part in path.ancestors() {
                assert_eq!(
                    reparse_attribute(part),
                    Some(is_link(&fs::symlink_metadata(part).unwrap())),
                    "{part:?}"
                );
            }
            safe_existing(path).unwrap();
        }
        assert_eq!(reparse_attribute(&root.join("absent")), None);
        assert!(safe_existing(&root.join("absent")).is_err());
        assert_eq!(reparse_attribute(Path::new("relative")), None);
        assert_eq!(reparse_attribute(Path::new(r"C:\Windows")), None);
        assert_eq!(reparse_attribute(Path::new(r"\\?\UNC\server\share\")), None);
        // A real SMB root can be supplied by the Windows release verification run.
        if let Some(unc) = std::env::var_os("ANNOTATOR_ATTRIBUTE_UNC_ROOT") {
            let unc = Path::new(&unc);
            assert_eq!(reparse_attribute(unc), None);
            let baseline = unc
                .ancestors()
                .filter(|p| !p.as_os_str().is_empty())
                .all(|p| fs::symlink_metadata(p).is_ok_and(|metadata| !is_link(&metadata)));
            assert_eq!(safe_existing(unc).is_ok(), baseline);
        }
        let nul = std::ffi::OsString::from_wide(&[92, 92, 63, 92, 67, 58, 92, 0, 120]);
        assert_eq!(reparse_attribute(Path::new(&nul)), None);
        assert!(safe_existing(Path::new(&nul)).is_err());
        let junction = root.join("alias");
        let result = std::process::Command::new("pwsh").args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:ANNOTATOR_PARITY_LINK -Target $env:ANNOTATOR_PARITY_TARGET -ErrorAction Stop | Out-Null"]).env("ANNOTATOR_PARITY_LINK", &junction).env("ANNOTATOR_PARITY_TARGET", &unicode).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(reparse_attribute(&junction), Some(true));
        assert!(safe_existing(&junction).is_err());
        assert!(safe_existing(&junction.join("source.wav")).is_err());
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
