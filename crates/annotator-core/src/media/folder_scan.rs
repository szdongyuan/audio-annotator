//! Discovery only: no decoding or document mutation. Results belong to one runtime owner.
use crate::{
    error::{AppError, ErrorCode, Result},
    media::identity::check_cancel,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub const MAX_CANDIDATES: usize = 10_000;
pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_ISSUES: usize = 256;
pub const MAX_PAGE: usize = 256;
#[derive(Clone, Copy)]
pub struct Limits {
    pub candidates: usize,
    pub entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            candidates: MAX_CANDIDATES,
            entries: MAX_ENTRIES,
        }
    }
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub checked: usize,
    pub candidates: usize,
    pub existing: usize,
    pub skipped: usize,
    pub failed: usize,
    pub issues: usize,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub relative_path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    Access,
    UnresolvedSource,
    Existing,
    Reparse,
    Unsupported,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub path: String,
    pub kind: IssueKind,
    pub message: String,
}
#[derive(Debug)]
pub struct ScanResult {
    pub root: String,
    pub candidates: Vec<Candidate>,
    pub issues: Vec<Issue>,
    pub counts: Counts,
}
impl ScanResult {
    fn issue(&mut self, path: &Path, kind: IssueKind, message: impl Into<String>) {
        self.counts.issues += 1;
        if matches!(kind, IssueKind::Access | IssueKind::UnresolvedSource) {
            self.counts.failed += 1;
        }
        if self.issues.len() < MAX_ISSUES {
            self.issues.push(Issue {
                path: path.to_string_lossy().into_owned(),
                kind,
                message: message.into(),
            });
        }
    }
}
fn limit() -> AppError {
    AppError::new(
        ErrorCode::ResourceLimit,
        "文件夹超过扫描上限，请缩小目录范围",
    )
}
fn key(path: &Path) -> String {
    // Windows canonical paths have a verbatim prefix. Normalize lexical fallbacks too.
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/")
        .to_lowercase()
}
fn absolute(root: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let mut normalized = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    normalized
}
fn reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

pub fn scan(
    root: &Path,
    project_root: &Path,
    existing: &[String],
    recursive: bool,
    cancel: &AtomicBool,
    limits: Limits,
    progress: impl FnMut(&Counts),
) -> Result<ScanResult> {
    scan_with_access_check(
        root,
        project_root,
        existing,
        recursive,
        cancel,
        limits,
        progress,
        |_| Ok(()),
    )
}

/// The access hook allows deterministic permission failures without changing filesystem ACLs.
#[allow(clippy::too_many_arguments)]
pub fn scan_with_access_check(
    root: &Path,
    project_root: &Path,
    existing: &[String],
    recursive: bool,
    cancel: &AtomicBool,
    limits: Limits,
    mut progress: impl FnMut(&Counts),
    mut access: impl FnMut(&Path) -> std::io::Result<()>,
) -> Result<ScanResult> {
    check_cancel(cancel)?;
    if limits.candidates > MAX_CANDIDATES || limits.entries > MAX_ENTRIES {
        return Err(limit());
    }
    let root =
        fs::canonicalize(root).map_err(|e| AppError::invalid(format!("无法访问文件夹: {e}")))?;
    access(&root).map_err(|e| AppError::invalid(format!("无法访问文件夹: {e}")))?;
    let root_entries =
        fs::read_dir(&root).map_err(|e| AppError::invalid(format!("无法读取文件夹: {e}")))?;
    let project_root = fs::canonicalize(project_root)
        .map_err(|e| AppError::invalid(format!("无法访问项目目录: {e}")))?;
    let mut result = ScanResult {
        root: root.to_string_lossy().into_owned(),
        candidates: vec![],
        issues: vec![],
        counts: Counts::default(),
    };
    let mut known = HashSet::new();
    for raw in existing {
        check_cancel(cancel)?;
        let path = absolute(&project_root, raw);
        known.insert(key(&path));
        match fs::canonicalize(&path) {
            Ok(p) => {
                known.insert(key(&p));
            }
            Err(e) => result.issue(
                &path,
                IssueKind::UnresolvedSource,
                format!("已有源无法解析，保留原关联: {e}"),
            ),
        }
    }
    // Iterators keep traversal storage proportional to depth, not directory width.
    let mut stack = vec![(root.clone(), root_entries)];
    while let Some((directory, entries)) = stack.last_mut() {
        check_cancel(cancel)?;
        let Some(entry) = entries.next() else {
            stack.pop();
            continue;
        };
        result.counts.checked += 1;
        if result.counts.checked > limits.entries {
            return Err(limit());
        }
        progress(&result.counts);
        check_cancel(cancel)?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                result.issue(directory, IssueKind::Access, e.to_string());
                continue;
            }
        };
        let path = entry.path();
        let metadata = match access(&path).and_then(|_| fs::symlink_metadata(&path)) {
            Ok(m) => m,
            Err(e) => {
                result.issue(&path, IssueKind::Access, e.to_string());
                continue;
            }
        };
        // Do this before canonicalization or opening a directory: includes junctions.
        if reparse(&metadata) {
            result.counts.skipped += 1;
            result.issue(&path, IssueKind::Reparse, "跳过链接或重解析点");
            continue;
        }
        if metadata.is_dir() {
            if recursive {
                match fs::read_dir(&path) {
                    Ok(entries) => stack.push((path, entries)),
                    Err(e) => result.issue(&path, IssueKind::Access, e.to_string()),
                }
            }
            continue;
        }
        let supported = path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
            ["wav", "flac", "mp3"]
                .iter()
                .any(|ext| s.eq_ignore_ascii_case(ext))
        });
        if !metadata.is_file() || !supported {
            result.counts.skipped += 1;
            result.issue(&path, IssueKind::Unsupported, "跳过不支持的文件");
            continue;
        }
        let canonical = match fs::canonicalize(&path) {
            Ok(p) => p,
            Err(e) => {
                result.issue(&path, IssueKind::Access, e.to_string());
                continue;
            }
        };
        if known.contains(&key(&canonical)) || known.contains(&key(&path)) {
            result.counts.existing += 1;
            result.issue(&path, IssueKind::Existing, "已存在相同路径，保留原关联");
            continue;
        }
        if result.candidates.len() >= limits.candidates {
            return Err(limit());
        }
        known.insert(key(&canonical));
        result.candidates.push(Candidate {
            path: canonical
                .to_str()
                .ok_or_else(|| AppError::invalid("音频路径不是有效 Unicode"))?
                .into(),
            relative_path: path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/"),
        });
        result.counts.candidates += 1;
    }
    check_cancel(cancel)?;
    result
        .candidates
        .sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(result)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanToken {
    pub task_id: String,
    pub owner_id: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageKind {
    Candidates,
    Issues,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub token: ScanToken,
    pub kind: PageKind,
    pub offset: usize,
    pub total: usize,
    pub candidates: Vec<Candidate>,
    pub issues: Vec<Issue>,
}
#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FolderEvent {
    Progress {
        token: ScanToken,
        counts: Counts,
    },
    Result {
        token: ScanToken,
        root: String,
        counts: Counts,
        retained_issues: usize,
    },
    Cancelled {
        token: ScanToken,
    },
    Failed {
        token: ScanToken,
        error: AppError,
    },
}
struct Active {
    token: ScanToken,
    cancel: Arc<AtomicBool>,
    result: Option<ScanResult>,
    finished: bool,
}
pub struct FolderTasks {
    owner: String,
    active: Option<Active>,
}
impl Default for FolderTasks {
    fn default() -> Self {
        Self {
            owner: uuid::Uuid::new_v4().to_string(),
            active: None,
        }
    }
}
impl FolderTasks {
    pub fn begin(&mut self) -> Result<(ScanToken, Arc<AtomicBool>)> {
        if self.active.is_some() {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "请结束或释放当前文件夹扫描",
            ));
        }
        let token = ScanToken {
            task_id: uuid::Uuid::new_v4().to_string(),
            owner_id: self.owner.clone(),
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.active = Some(Active {
            token: token.clone(),
            cancel: cancel.clone(),
            result: None,
            finished: false,
        });
        Ok((token, cancel))
    }
    fn current(&self, token: &ScanToken) -> Result<&Active> {
        self.active
            .as_ref()
            .filter(|a| a.token == *token)
            .ok_or_else(|| AppError::invalid("文件夹扫描已失效"))
    }
    pub fn is_current(&self, token: &ScanToken) -> bool {
        self.current(token)
            .is_ok_and(|a| !a.cancel.load(Ordering::Relaxed))
    }
    pub fn cancel(&mut self, token: &ScanToken) -> Result<()> {
        self.current(token)?.cancel.store(true, Ordering::Relaxed);
        self.active.as_mut().unwrap().result = None;
        Ok(())
    }
    pub fn release(&mut self, token: &ScanToken) -> Result<()> {
        self.cancel(token)?;
        self.active = None;
        Ok(())
    }
    pub fn reset(&mut self) {
        if let Some(active) = self.active.take() {
            active.cancel.store(true, Ordering::Relaxed);
        }
        self.owner = uuid::Uuid::new_v4().to_string();
    }
    pub fn complete(
        &mut self,
        token: &ScanToken,
        result: Result<ScanResult>,
    ) -> Result<FolderEvent> {
        if self.current(token)?.finished {
            return Err(AppError::invalid("扫描已结束"));
        }
        let active = self.active.as_mut().unwrap();
        active.finished = true;
        let result = if active.cancel.load(Ordering::Relaxed) {
            Err(AppError::new(ErrorCode::Cancelled, "扫描已取消"))
        } else {
            result
        };
        Ok(match result {
            Ok(result) => {
                let event = FolderEvent::Result {
                    token: token.clone(),
                    root: result.root.clone(),
                    counts: result.counts.clone(),
                    retained_issues: result.issues.len(),
                };
                active.result = Some(result);
                event
            }
            Err(e) if e.code == ErrorCode::Cancelled => FolderEvent::Cancelled {
                token: token.clone(),
            },
            Err(error) => FolderEvent::Failed {
                token: token.clone(),
                error,
            },
        })
    }
    pub fn page(
        &self,
        token: &ScanToken,
        kind: PageKind,
        offset: usize,
        limit: usize,
    ) -> Result<Page> {
        if limit == 0 || limit > MAX_PAGE {
            return Err(AppError::invalid("分页大小必须为 1–256"));
        }
        let result = self
            .current(token)?
            .result
            .as_ref()
            .ok_or_else(|| AppError::invalid("扫描结果不可用"))?;
        let total = match kind {
            PageKind::Candidates => result.candidates.len(),
            PageKind::Issues => result.issues.len(),
        };
        if offset > total {
            return Err(AppError::invalid("分页位置越界"));
        }
        let end = offset.saturating_add(limit).min(total);
        Ok(Page {
            token: token.clone(),
            kind,
            offset,
            total,
            candidates: match kind {
                PageKind::Candidates => result.candidates[offset..end].to_vec(),
                _ => vec![],
            },
            issues: match kind {
                PageKind::Issues => result.issues[offset..end].to_vec(),
                _ => vec![],
            },
        })
    }
}
