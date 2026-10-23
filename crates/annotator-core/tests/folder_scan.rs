use annotator_core::{error::ErrorCode, media::folder_scan::*};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("annotator-folders-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn file(&self, p: &str) {
        let path = self.0.join(p);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"scan does not decode").unwrap();
    }
    fn scan(&self, recursive: bool, existing: &[String]) -> ScanResult {
        scan(
            &self.0,
            &self.0,
            existing,
            recursive,
            &AtomicBool::new(false),
            Limits::default(),
            |_| {},
        )
        .unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        let own = fs::canonicalize(&self.0).unwrap();
        assert!(
            own.starts_with(temp)
                && own
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("annotator-folders-")
        );
        fs::remove_dir_all(own).unwrap();
    }
}

#[test]
fn recursive_extensions_stable_order_and_relative_existing_paths() {
    let t = Tree::new();
    for p in [
        "z.MP3",
        "a.WAV",
        "nested/a.WAV",
        "nested/b.FlAc",
        "readme.txt",
    ] {
        t.file(p);
    }
    let one = t.scan(false, &[]);
    assert_eq!(one.candidates.len(), 2);
    let r = t.scan(true, &["./a.WAV".into()]);
    assert_eq!(
        r.candidates
            .iter()
            .map(|c| c.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["nested/a.WAV", "nested/b.FlAc", "z.MP3"]
    );
    assert_eq!(r.counts.existing, 1);
    assert_eq!(r.counts.skipped, 1);
    assert!(r
        .candidates
        .iter()
        .all(|c| Path::new(&c.path).is_absolute()));
    assert_eq!(
        t.scan(true, &[t.0.join("a.WAV").to_string_lossy().into_owned()])
            .candidates,
        r.candidates
    );
}

#[test]
fn unresolved_existing_sources_are_reported_and_hardlinks_remain_distinct() {
    let t = Tree::new();
    t.file("a.wav");
    fs::hard_link(t.0.join("a.wav"), t.0.join("b.wav")).unwrap();
    let r = t.scan(true, &["missing.wav".into()]);
    assert_eq!(r.candidates.len(), 2);
    assert!(r
        .issues
        .iter()
        .any(|i| i.kind == IssueKind::UnresolvedSource));
}

#[test]
fn limits_cancel_and_root_failure_never_return_partial_results() {
    let t = Tree::new();
    t.file("a.wav");
    t.file("b.wav");
    assert_eq!(Limits::default().candidates, 10_000);
    assert_eq!(Limits::default().entries, 100_000);
    assert_eq!(
        scan(
            &t.0,
            &t.0,
            &[],
            true,
            &AtomicBool::new(false),
            Limits {
                candidates: 2,
                entries: 2
            },
            |_| {}
        )
        .unwrap()
        .candidates
        .len(),
        2
    );
    for limits in [
        Limits {
            candidates: 1,
            ..Limits::default()
        },
        Limits {
            entries: 1,
            ..Limits::default()
        },
        Limits {
            candidates: 10_001,
            ..Limits::default()
        },
        Limits {
            entries: 100_001,
            ..Limits::default()
        },
    ] {
        assert_eq!(
            scan(
                &t.0,
                &t.0,
                &[],
                true,
                &AtomicBool::new(false),
                limits,
                |_| {}
            )
            .unwrap_err()
            .code,
            ErrorCode::ResourceLimit
        );
    }
    assert_eq!(
        scan(
            &t.0,
            &t.0,
            &[],
            true,
            &AtomicBool::new(true),
            Limits::default(),
            |_| {}
        )
        .unwrap_err()
        .code,
        ErrorCode::Cancelled
    );
    assert!(scan(
        &t.0.join("missing"),
        &t.0,
        &[],
        true,
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
    let cancel = AtomicBool::new(false);
    assert_eq!(
        scan(&t.0, &t.0, &[], true, &cancel, Limits::default(), |_| {
            cancel.store(true, Ordering::Relaxed)
        })
        .unwrap_err()
        .code,
        ErrorCode::Cancelled
    );
}

#[test]
fn child_permission_failure_continues_and_issue_storage_is_bounded() {
    let t = Tree::new();
    t.file("denied/hidden.wav");
    t.file("ok.wav");
    for n in 0..300 {
        t.file(&format!("skip{n}.txt"));
    }
    let r = scan_with_access_check(
        &t.0,
        &t.0,
        &[],
        true,
        &AtomicBool::new(false),
        Limits::default(),
        |_| {},
        |p| {
            if p.file_name().is_some_and(|n| n == "denied") {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        },
    )
    .unwrap();
    assert_eq!(r.candidates.len(), 1);
    assert_eq!(r.issues.len(), MAX_ISSUES);
    assert_eq!(r.counts.issues, 301);
    assert_eq!(r.counts.failed, 1);
    assert!(r.issues.iter().any(|i| i.kind == IssueKind::Access));
}

#[test]
fn task_pages_reset_and_release_are_bounded_and_owner_checked() {
    let t = Tree::new();
    for n in 0..260 {
        t.file(&format!("{n:03}.wav"));
    }
    let mut tasks = FolderTasks::default();
    let (token, cancel) = tasks.begin().unwrap();
    assert!(tasks.begin().is_err());
    assert!(tasks.page(&token, PageKind::Candidates, 0, 256).is_err());
    tasks.complete(&token, Ok(t.scan(false, &[]))).unwrap();
    assert_eq!(
        tasks
            .page(&token, PageKind::Candidates, 0, 256)
            .unwrap()
            .candidates
            .len(),
        256
    );
    assert_eq!(
        tasks
            .page(&token, PageKind::Candidates, 256, 256)
            .unwrap()
            .candidates
            .len(),
        4
    );
    assert!(tasks.page(&token, PageKind::Candidates, 0, 257).is_err());
    tasks.reset();
    assert!(cancel.load(Ordering::Relaxed));
    assert!(tasks.page(&token, PageKind::Candidates, 0, 1).is_err());
    let (next, flag) = tasks.begin().unwrap();
    assert_ne!(token.owner_id, next.owner_id);
    assert!(tasks.cancel(&token).is_err());
    assert!(!flag.load(Ordering::Relaxed));
    assert!(tasks.complete(&token, Ok(t.scan(false, &[]))).is_err());
    tasks.release(&next).unwrap();
    assert!(flag.load(Ordering::Relaxed));
    for _ in 0..300 {
        let (token, _) = tasks.begin().unwrap();
        tasks.complete(&token, Ok(t.scan(false, &[]))).unwrap();
        tasks.release(&token).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn real_ntfs_junction_is_not_followed() {
    use std::process::Command;
    let t = Tree::new();
    t.file("outside/secret.wav");
    fs::create_dir(t.0.join("scan")).unwrap();
    let output = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:SCAN_LINK -Target $env:SCAN_TARGET | Out-Null"])
        .env("SCAN_LINK", t.0.join("scan/link")).env("SCAN_TARGET", t.0.join("outside")).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let r = scan(
        &t.0.join("scan"),
        &t.0,
        &[],
        true,
        &AtomicBool::new(false),
        Limits::default(),
        |_| {},
    )
    .unwrap();
    assert!(r.candidates.is_empty());
    assert_eq!(r.issues[0].kind, IssueKind::Reparse);
    // Remove only the verified owned junction before the owned tree's recursive cleanup.
    let link = t.0.join("scan/link");
    assert!(link.starts_with(&t.0));
    fs::remove_dir(link).unwrap();
    assert!(t.0.join("outside/secret.wav").exists());
}

#[test]
fn cancellation_has_its_own_signal_and_terminal_results_release_storage() {
    use annotator_core::media::registry::MediaTasks;
    let t = Tree::new();
    t.file("a.wav");
    let mut folders = FolderTasks::default();
    let mut media = MediaTasks::default();
    let (token, scan_cancel) = folders.begin().unwrap();
    let (_, media_cancel) = media.begin(token.task_id.clone()).unwrap();
    media.cancel(&token.task_id);
    assert!(media_cancel.load(Ordering::Relaxed));
    assert!(!scan_cancel.load(Ordering::Relaxed));
    media.finish(&token.task_id);
    let (_, new_media_cancel) = media.begin(token.task_id.clone()).unwrap();
    folders.cancel(&token).unwrap();
    assert!(!new_media_cancel.load(Ordering::Relaxed));
    assert!(matches!(
        folders.complete(&token, Ok(t.scan(false, &[]))).unwrap(),
        FolderEvent::Cancelled { .. }
    ));
    assert!(folders.page(&token, PageKind::Candidates, 0, 1).is_err());
    folders.release(&token).unwrap();
    let (token, _) = folders.begin().unwrap();
    folders.complete(&token, Ok(t.scan(false, &[]))).unwrap();
    folders.cancel(&token).unwrap();
    assert!(folders.page(&token, PageKind::Candidates, 0, 1).is_err());
    folders.release(&token).unwrap();
    let (token, _) = folders.begin().unwrap();
    assert!(matches!(
        folders
            .complete(
                &token,
                Err(annotator_core::error::AppError::invalid("root"))
            )
            .unwrap(),
        FolderEvent::Failed { .. }
    ));
    assert!(folders.page(&token, PageKind::Candidates, 0, 1).is_err());
    folders.release(&token).unwrap();
    assert!(folders.begin().is_ok());
}
