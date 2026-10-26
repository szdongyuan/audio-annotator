//! Discovery is immutable and independent of project publication. Staged audio must be
//! retained by the caller until catalog publication and its release acknowledgement.
mod archive;
mod rules;
mod staging;
pub use staging::StagedAudio;
mod discovery;
mod jingcheng;
use crate::{
    error::{AppError, ErrorCode, Result},
    media::identity::SourceStamp,
};
pub use discovery::scan;
pub use rules::{Mode, Rules};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const MAX_PAGE: usize = 256;
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
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        self.rules.validate()?;
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
