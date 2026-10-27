//! Discovery is immutable and independent of project publication. Staged audio must be
//! retained by the caller until catalog publication and its release acknowledgement.
mod archive;
mod rules;
mod staging;
pub use staging::{StagedAudio, StagingSession};
mod discovery;
mod jingcheng;
mod organization;
use crate::{
    error::{AppError, ErrorCode, Result},
    media::identity::SourceStamp,
};
pub use discovery::scan;
pub use organization::{FolderSummary, OrganizationConfig, OrganizationMode};
pub use rules::{Mode, Rules};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MAX_PAGE: usize = 50;
pub const MAX_ISSUES: usize = 256;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Folder,
    Zip,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub kind: SourceKind,
    pub paths: Vec<String>,
    pub rules: Rules,
    pub organization: OrganizationConfig,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        self.rules.validate()?;
        self.organization.validate(self.rules.mode)?;
        if self.paths.is_empty()
            || self.paths.len() > 32
            || (self.kind == SourceKind::Folder && self.paths.len() != 1)
            || self
                .paths
                .iter()
                .any(|p| p.is_empty() || p.len() > 32768 || p.contains('\0'))
        {
            return Err(AppError::invalid("请选择一个文件夹或最多 32 个 ZIP"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub entries: usize,
    pub candidates: usize,
    pub manifest_bytes: u64,
    pub audio_bytes: u64,
    pub selected_bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: 100_000,
            candidates: 10_000,
            manifest_bytes: 1024 * 1024,
            audio_bytes: 1024 * 1024 * 1024,
            selected_bytes: 20 * 1024 * 1024 * 1024,
        }
    }
}
impl Limits {
    fn validate(self) -> Result<()> {
        let max = Self::default();
        if self.entries > max.entries
            || self.candidates > max.candidates
            || self.manifest_bytes > max.manifest_bytes
            || self.audio_bytes > max.audio_bytes
            || self.selected_bytes > max.selected_bytes
        {
            return Err(limit());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub checked: usize,
    pub candidates: usize,
    pub skipped: usize,
    pub issues: usize,
    pub selected_bytes: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub index: usize,
    pub source_index: usize,
    pub source_name: String,
    pub relative_path: String,
    pub display_name: String,
    pub byte_length: u64,
    pub logical_position: Option<u32>,
    pub resulting_folder_path: Vec<String>,
    pub original_filename: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub source_index: usize,
    pub relative_path: String,
    pub message: String,
}
#[derive(Debug)]
struct Source {
    path: PathBuf,
    kind: SourceKind,
    stamp: Option<SourceStamp>,
    manifests: std::collections::HashMap<String, (PathBuf, SourceStamp)>,
}
#[derive(Debug)]
struct Entry {
    path: String,
    size: u64,
    zip_index: Option<usize>,
    stamp: Option<SourceStamp>,
}
#[derive(Debug)]
pub struct ScanResult {
    pub counts: Counts,
    pub issues: Vec<Issue>,
    candidates: Vec<Candidate>,
    entries: Vec<Entry>,
    sources: Vec<Source>,
    limits: Limits,
    folder_summary: Vec<FolderSummary>,
}
impl ScanResult {
    /// Before publishing the immutable preview, omit exact already-imported folder paths.
    /// This is path exclusion only: ZIP entries and equal bytes at other paths remain distinct.
    /// Callers resolve known paths outside application locks; discovery already validated entries.
    pub fn exclude_folder_paths(&mut self, canonical_paths: &[PathBuf]) {
        let known: std::collections::HashSet<_> = canonical_paths.iter().collect();
        let mut candidates = Vec::with_capacity(self.candidates.len());
        let mut entries = Vec::with_capacity(self.entries.len());
        for (mut candidate, entry) in self.candidates.drain(..).zip(self.entries.drain(..)) {
            let source = &self.sources[candidate.source_index];
            if source.kind == SourceKind::Folder && known.contains(&source.path.join(&entry.path)) {
                self.counts.skipped += 1;
                self.counts.selected_bytes -= candidate.byte_length;
            } else {
                candidate.index = candidates.len();
                candidates.push(candidate);
                entries.push(entry);
            }
        }
        self.candidates = candidates;
        self.entries = entries;
        self.counts.candidates = self.candidates.len();
        // Exclusion cannot introduce new folders or exceed the original bound.
        self.rebuild_summary().expect("bounded subset");
    }
    /// Native preflight can exclude invalid project placements without exposing entry paths.
    pub fn validate_placements(
        &mut self,
        mut validate: impl FnMut(&Candidate) -> Result<()>,
    ) -> Result<()> {
        let mut candidates = vec![];
        let mut entries = vec![];
        for (mut candidate, entry) in std::mem::take(&mut self.candidates)
            .into_iter()
            .zip(std::mem::take(&mut self.entries))
        {
            if let Err(error) = validate(&candidate) {
                self.counts.skipped += 1;
                self.counts.selected_bytes -= candidate.byte_length;
                self.issue(
                    candidate.source_index,
                    &candidate.relative_path,
                    error.message,
                );
            } else {
                candidate.index = candidates.len();
                candidates.push(candidate);
                entries.push(entry);
            }
        }
        self.candidates = candidates;
        self.entries = entries;
        self.counts.candidates = self.candidates.len();
        self.rebuild_summary()
    }
    pub fn folder_summary(&self) -> &[FolderSummary] {
        &self.folder_summary
    }
    pub fn bind_target_path(&mut self, prefix: &[String]) -> Result<()> {
        let mut candidates = vec![];
        let mut entries = vec![];
        for (mut c, e) in std::mem::take(&mut self.candidates)
            .into_iter()
            .zip(std::mem::take(&mut self.entries))
        {
            if prefix.len() + c.resulting_folder_path.len() > 16 {
                self.counts.skipped += 1;
                self.counts.selected_bytes -= c.byte_length;
                self.issue(c.source_index, &c.relative_path, "目标和生成目录超过 16 层");
                continue;
            }
            let mut path = prefix.to_vec();
            path.extend(c.resulting_folder_path);
            c.resulting_folder_path = path;
            c.index = candidates.len();
            candidates.push(c);
            entries.push(e);
        }
        self.candidates = candidates;
        self.entries = entries;
        self.counts.candidates = self.candidates.len();
        self.rebuild_summary()
    }
    pub(super) fn rebuild_summary(&mut self) -> Result<()> {
        let mut nodes = vec![];
        let mut index = std::collections::HashMap::new();
        for c in &self.candidates {
            let mut parent = None;
            for name in &c.resulting_folder_path {
                let key = (parent, name.to_lowercase());
                let current = if let Some(i) = index.get(&key) {
                    *i
                } else {
                    if nodes.len() >= 10_000 {
                        return Err(limit());
                    }
                    let i = nodes.len();
                    nodes.push(FolderSummary {
                        index: i,
                        parent_index: parent,
                        name: name.clone(),
                        media_count: 0,
                    });
                    index.insert(key, i);
                    i
                };
                nodes[current].media_count += 1;
                parent = Some(current);
            }
        }
        self.folder_summary = nodes;
        Ok(())
    }
    pub fn candidates(&self) -> &[Candidate] {
        &self.candidates
    }
    pub fn page(&self, offset: usize, limit: usize) -> Result<&[Candidate]> {
        if limit == 0 || limit > MAX_PAGE || offset > self.candidates.len() {
            return Err(AppError::invalid("无效分页"));
        }
        Ok(&self.candidates[offset..offset.saturating_add(limit).min(self.candidates.len())])
    }
    fn issue(&mut self, source_index: usize, path: &str, message: impl Into<String>) {
        self.counts.issues += 1;
        if self.issues.len() < MAX_ISSUES {
            self.issues.push(Issue {
                source_index,
                relative_path: path.into(),
                message: message.into(),
            });
        }
    }
}
fn limit() -> AppError {
    AppError::new(
        ErrorCode::ResourceLimit,
        "导入源超过扫描或音频大小上限，请缩小范围",
    )
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidArchive, message)
}
fn io(error: std::io::Error) -> AppError {
    AppError::invalid(format!("读取或暂存导入源失败：{error}"))
}
fn zip_error(error: zip::result::ZipError) -> AppError {
    invalid(format!("ZIP 不受支持或无效：{error}"))
}
fn reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}
