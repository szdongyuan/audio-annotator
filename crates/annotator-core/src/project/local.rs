use super::{FileStore, LoadReport, ProjectSession, ProjectSnapshot, RecoverySource};
use crate::{
    error::{AppError, ErrorCode, Result},
    model::ProjectDocument,
};
use std::path::Path;

/// Session and its OS write lock have exactly the same owner and lifetime.
pub struct LocalProject {
    store: FileStore,
    session: Option<ProjectSession>,
    recovery: Option<LoadReport>,
}
impl LocalProject {
    pub fn create(root: &Path, name: String) -> Result<Self> {
        let document = ProjectDocument::create(name)?;
        Ok(Self {
            store: FileStore::create(root, &document)?,
            session: Some(ProjectSession::new(document)?),
            recovery: None,
        })
    }
    pub fn open(root: &Path) -> Result<Self> {
        let (store, report) = FileStore::open(root)?;
        if report.primary.is_none() || !report.candidates.is_empty() {
            Ok(Self {
                store,
                session: None,
                recovery: Some(report),
            })
        } else {
            Ok(Self {
                store,
                session: Some(ProjectSession::new(report.primary.unwrap())?),
                recovery: None,
            })
        }
    }
    pub fn root(&self) -> &Path {
        self.store.root()
    }
    pub fn persisted_revision(&self) -> u64 {
        self.store.persisted_revision()
    }
    pub fn recovery(&self) -> Option<&LoadReport> {
        self.recovery.as_ref()
    }
    pub fn store_mut(&mut self) -> &mut FileStore {
        &mut self.store
    }
    pub fn session_mut(&mut self) -> Result<&mut ProjectSession> {
        self.session
            .as_mut()
            .ok_or_else(|| AppError::invalid("请先选择恢复版本"))
    }
    pub fn snapshot(&self) -> Result<ProjectSnapshot> {
        self.session
            .as_ref()
            .map(ProjectSession::snapshot)
            .ok_or_else(|| AppError::invalid("请先选择恢复版本"))
    }
    pub fn resolve_recovery(&mut self, source: Option<RecoverySource>) -> Result<()> {
        let report = self
            .recovery
            .as_ref()
            .ok_or_else(|| AppError::invalid("没有待处理的恢复选项"))?;
        let document = match source {
            Some(source) => report
                .candidates
                .iter()
                .find(|c| c.source == source)
                .map(|c| c.document.clone()),
            None => report.primary.clone(),
        }
        .ok_or_else(|| AppError::invalid("所选恢复版本不可用"))?;
        if source.is_some() {
            self.store.save(&document)?;
        } else {
            self.store.keep_primary(&document)?;
        }
        self.session = Some(ProjectSession::new(document)?);
        self.recovery = None;
        Ok(())
    }
    fn check(&self, id: &str, revision: u64) -> Result<ProjectSnapshot> {
        let snapshot = self.snapshot()?;
        if snapshot.document.project_id != id || snapshot.document.revision != revision {
            return Err(AppError::new(
                ErrorCode::RevisionConflict,
                "项目已改变，请重试操作",
            ));
        }
        Ok(snapshot)
    }
    pub fn save(&mut self, id: &str, revision: u64) -> Result<u64> {
        let snapshot = self.check(id, revision)?;
        self.store.save(&snapshot.document)?;
        Ok(revision)
    }
    pub fn save_as(&mut self, root: &Path, id: &str, revision: u64) -> Result<()> {
        let mut document = self.check(id, revision)?.document;
        // Relative media continue pointing to their original source, even if unavailable.
        for media in &mut document.media {
            if Path::new(&media.source_ref).is_relative() {
                media.source_ref = self
                    .root()
                    .join(&media.source_ref)
                    .to_string_lossy()
                    .into_owned();
            }
        }
        // Acquire and publish the new project first. Any failure leaves this session intact.
        let store = FileStore::create(root, &document)?;
        let old_root = self.root().to_path_buf();
        self.session_mut()?.rebase_sources(&old_root);
        self.store = store;
        Ok(())
    }
    pub fn prepare_close(&mut self, id: &str, revision: u64, discard: bool) -> Result<()> {
        let snapshot = self.check(id, revision)?;
        if discard {
            // Explicit discard must remain available when storage is unwritable.
            // Suppress recovery when possible; a leftover candidate still requires
            // an explicit choice on next open and is never loaded silently.
            let path = self.root().join("project.json");
            let primary = std::fs::read_to_string(path)
                .ok()
                .and_then(|s| ProjectDocument::from_json(&s).ok());
            if let Some(doc) = primary {
                let _ = self.store.keep_primary(&doc);
            }
        } else if self.persisted_revision() != snapshot.document.revision {
            return Err(AppError::new(ErrorCode::SaveFailed, "项目仍有未保存内容"));
        }
        Ok(())
    }
}
