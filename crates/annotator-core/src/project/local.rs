use super::{FileStore, LoadReport, ProjectSession, ProjectSnapshot, RecoverySource};
use crate::{
    collaboration::{AuthorSession, CollaborationRepository, PrivateWorkspace},
    error::{AppError, ErrorCode, Result},
    model::{Change, ProjectDocument},
};
use std::path::Path;

enum Storage {
    Local(FileStore),
    Shared(Box<PrivateWorkspace>),
    Transient(std::path::PathBuf),
}

/// Session and its OS write lock have exactly the same owner and lifetime.
pub struct LocalProject {
    store: Storage,
    session: Option<ProjectSession>,
    recovery: Option<LoadReport>,
}
impl LocalProject {
    /// In-memory, read-only media authority. Never creates a catalog, lock or project file.
    pub fn transient(root: std::path::PathBuf, document: ProjectDocument) -> Result<Self> {
        Ok(Self {
            store: Storage::Transient(root),
            session: Some(ProjectSession::new(document)?),
            recovery: None,
        })
    }
    /// Convenience preparation + installation. Callers with an app mutex capture
    /// workspace.catalog_source(), prepare off-lock, then adopt_prepared_catalog.
    pub fn adopt_shared_catalog(
        &mut self,
        id: &str,
        revision: u64,
        repo: std::sync::Arc<CollaborationRepository>,
    ) -> Result<ProjectSnapshot> {
        let prepared = self.workspace()?.catalog_source().prepare(repo)?;
        self.adopt_prepared_catalog(id, revision, prepared)
    }
    /// Install a verified off-lock read without accessing shared storage. The
    /// caller also guards its project instance/runtime before invoking this method.
    pub fn adopt_prepared_catalog(
        &mut self,
        id: &str,
        revision: u64,
        prepared: crate::collaboration::PreparedCatalogUpdate,
    ) -> Result<ProjectSnapshot> {
        if self.recovery.is_some() {
            let d = &self.workspace()?.envelope().document;
            if d.project_id != id || d.revision != revision {
                return Err(AppError::new(
                    ErrorCode::RevisionConflict,
                    "Private recovery changed",
                ));
            }
            self.workspace_mut()?.adopt_prepared_catalog(prepared)?;
            self.recovery = self.workspace()?.recovery_report();
            let document = self.workspace()?.envelope().document.clone();
            return Ok(ProjectSnapshot {
                document,
                can_undo: false,
                can_redo: false,
            });
        }
        self.check(id, revision)?;
        self.workspace()?.validate_prepared_catalog(&prepared)?;
        if self.workspace()?.manifest() == prepared.repo.manifest()
            && !prepared.retirement.changed()
        {
            return self.snapshot();
        }
        let mut session = self.active_session()?.clone();
        session.retire_media(&prepared.retirement.retired)?;
        session.adopt_catalog(prepared.repo.manifest())?;
        self.workspace_mut()?.adopt_prepared_catalog(prepared)?;
        self.session = Some(session);
        self.snapshot()
    }
    /// Native creator-only seed: validation keeps the immutable catalog and actor binding.
    /// The full private document never enters the shared repository.
    pub fn initialize_shared_private(&mut self, document: ProjectDocument) -> Result<()> {
        if self.workspace()?.actor().is_none() {
            return Err(AppError::invalid("Creator identity required"));
        }
        self.workspace_mut()?.save(&document)?;
        self.session = Some(ProjectSession::new(document)?);
        Ok(())
    }
    pub fn load_shared_version(
        &mut self,
        remote: Option<&crate::collaboration::AuthorLayer>,
    ) -> Result<ProjectSnapshot> {
        let current = self.snapshot()?.document;
        if current != self.workspace()?.envelope().document {
            self.workspace_mut()?.save(&current)?;
        }
        let document = self.workspace_mut()?.load_remote(remote)?;
        self.session = Some(ProjectSession::new(document)?);
        self.snapshot()
    }
    pub fn reconcile_shared_version(
        &mut self,
        remote: Option<&crate::collaboration::AuthorLayer>,
    ) -> Result<ProjectSnapshot> {
        let current = self.snapshot()?.document;
        if current != self.workspace()?.envelope().document {
            self.workspace_mut()?.save(&current)?;
        }
        self.workspace_mut()?.reconcile_remote(remote)?;
        let document = self.workspace()?.envelope().document.clone();
        if document != current {
            self.session = Some(ProjectSession::new(document)?);
        }
        self.snapshot()
    }
    pub fn open_shared(
        repo: std::sync::Arc<CollaborationRepository>,
        actor: Option<std::sync::Arc<AuthorSession>>,
        local: &Path,
    ) -> Result<Self> {
        let workspace = PrivateWorkspace::open(repo, actor, local)?;
        Self::from_workspace(workspace)
    }
    pub fn open_shared_view_only(
        repo: std::sync::Arc<CollaborationRepository>,
        local: &Path,
    ) -> Result<Self> {
        Self::from_workspace(PrivateWorkspace::open_view_only(repo, local)?)
    }
    fn from_workspace(workspace: PrivateWorkspace) -> Result<Self> {
        let recovery = workspace.recovery_report();
        let session = if recovery.is_some() {
            None
        } else {
            Some(ProjectSession::new(workspace.envelope().document.clone())?)
        };
        Ok(Self {
            store: Storage::Shared(Box::new(workspace)),
            session,
            recovery,
        })
    }
    pub fn is_shared(&self) -> bool {
        matches!(self.store, Storage::Shared(_))
    }
    pub fn storage_root(&self) -> &Path {
        match &self.store {
            Storage::Local(s) => s.root(),
            Storage::Shared(s) => s.root(),
            Storage::Transient(root) => root,
        }
    }
    pub fn workspace(&self) -> Result<&PrivateWorkspace> {
        match &self.store {
            Storage::Shared(s) => Ok(s),
            _ => Err(AppError::invalid("Not a collaborative project")),
        }
    }
    pub fn workspace_mut(&mut self) -> Result<&mut PrivateWorkspace> {
        match &mut self.store {
            Storage::Shared(s) => Ok(s),
            _ => Err(AppError::invalid("Not a collaborative project")),
        }
    }
    fn active_session(&mut self) -> Result<&mut ProjectSession> {
        if matches!(self.store, Storage::Transient(_)) {
            return Err(AppError::invalid("Read-only preview"));
        }
        self.session
            .as_mut()
            .ok_or_else(|| AppError::invalid("请先选择恢复版本"))
    }
    pub fn apply_change(
        &mut self,
        id: &str,
        revision: u64,
        change: Change,
    ) -> Result<ProjectSnapshot> {
        if self.is_shared()
            && self.workspace()?.is_view_only()
            && !matches!(
                change,
                Change::RelinkMedia { .. }
                    | Change::AddEdit { .. }
                    | Change::UpdateEdit { .. }
                    | Change::RemoveEdit { .. }
                    | Change::SetEditEnabled { .. }
                    | Change::ResetMediaMasks { .. }
                    | Change::UpdateAnalysis { .. }
                    | Change::UpdatePlaybackMix { .. }
                    | Change::UpdateViewState { .. }
            )
        {
            return Err(AppError::invalid(
                "View-only identity cannot change shared labels",
            ));
        }
        if self.is_shared()
            && matches!(
                change,
                Change::ImportMedia { .. }
                    | Change::ImportMediaBatch { .. }
                    | Change::RemoveMedia { .. }
            )
        {
            return Err(AppError::invalid("Shared media catalog is immutable"));
        }
        self.active_session()?.apply_change(id, revision, change)
    }
    pub fn undo(&mut self, id: &str, revision: u64) -> Result<ProjectSnapshot> {
        if self.is_shared() && self.workspace()?.is_view_only() {
            let mut session = self.active_session()?.clone();
            let snapshot = session.undo(id, revision)?;
            self.workspace()?
                .authorize_private_document(&snapshot.document)?;
            self.session = Some(session);
            return Ok(snapshot);
        }
        self.active_session()?.undo(id, revision)
    }
    pub fn redo(&mut self, id: &str, revision: u64) -> Result<ProjectSnapshot> {
        if self.is_shared() && self.workspace()?.is_view_only() {
            let mut session = self.active_session()?.clone();
            let snapshot = session.redo(id, revision)?;
            self.workspace()?
                .authorize_private_document(&snapshot.document)?;
            self.session = Some(session);
            return Ok(snapshot);
        }
        self.active_session()?.redo(id, revision)
    }
    pub fn export_document(&self) -> Result<ProjectDocument> {
        let document = self.snapshot()?.document;
        match &self.store {
            Storage::Local(_) | Storage::Transient(_) => Ok(document),
            Storage::Shared(s) => {
                crate::collaboration::LayerPayload::from_document(&document)?.project(s.manifest())
            }
        }
    }
    pub fn create(root: &Path, name: String) -> Result<Self> {
        let document = ProjectDocument::create(name)?;
        Ok(Self {
            store: Storage::Local(FileStore::create(root, &document)?),
            session: Some(ProjectSession::new(document)?),
            recovery: None,
        })
    }
    pub fn open(root: &Path) -> Result<Self> {
        let (store, report) = FileStore::open(root)?;
        if report.primary.is_none() || !report.candidates.is_empty() {
            Ok(Self {
                store: Storage::Local(store),
                session: None,
                recovery: Some(report),
            })
        } else {
            Ok(Self {
                store: Storage::Local(store),
                session: Some(ProjectSession::new(report.primary.unwrap())?),
                recovery: None,
            })
        }
    }
    pub fn root(&self) -> &Path {
        match &self.store {
            Storage::Local(s) => s.root(),
            Storage::Shared(s) => s.shared_root(),
            Storage::Transient(root) => root,
        }
    }
    pub fn persisted_revision(&self) -> u64 {
        match &self.store {
            Storage::Local(s) => s.persisted_revision(),
            Storage::Shared(s) => s.persisted_revision(),
            Storage::Transient(_) => 0,
        }
    }
    pub fn recovery(&self) -> Option<&LoadReport> {
        self.recovery.as_ref()
    }
    pub fn store_mut(&mut self) -> Result<&mut FileStore> {
        match &mut self.store {
            Storage::Local(s) => Ok(s),
            _ => Err(AppError::invalid(
                "Collaborative projects use a private workspace",
            )),
        }
    }
    pub fn session_mut(&mut self) -> Result<&mut ProjectSession> {
        if matches!(self.store, Storage::Transient(_)) {
            return Err(AppError::invalid("Read-only preview"));
        }
        if self.is_shared() {
            return Err(AppError::invalid(
                "Use guarded collaborative project operations",
            ));
        }
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
        if let Storage::Shared(workspace) = &mut self.store {
            let document = workspace.resolve_recovery(source)?;
            self.session = Some(ProjectSession::new(document)?);
            self.recovery = None;
            return Ok(());
        }
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
            self.store_mut()?.save(&document)?;
        } else {
            self.store_mut()?.keep_primary(&document)?;
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
        match &mut self.store {
            Storage::Local(s) => s.save(&snapshot.document)?,
            Storage::Shared(s) => s.save(&snapshot.document)?,
            Storage::Transient(_) => return Err(AppError::invalid("Read-only preview")),
        };
        Ok(revision)
    }
    pub fn save_as(&mut self, root: &Path, id: &str, revision: u64) -> Result<()> {
        if matches!(self.store, Storage::Transient(_)) {
            return Err(AppError::invalid("Read-only preview"));
        }
        let mut document = self.check(id, revision)?.document;
        let authority = if self.is_shared() {
            let fresh = CollaborationRepository::open(self.root())?;
            let authority = crate::exchange::SharedSourceAuthority::capture(&fresh);
            let prepared = self
                .workspace()?
                .catalog_source()
                .prepare_retirement(fresh)?;
            self.adopt_prepared_catalog(id, revision, prepared)?;
            // Retirement is a system update, but cannot silently change the
            // caller's explicit revision contract for the copy being requested.
            document = self.check(id, revision)?.document;
            Some(authority)
        } else {
            None
        };
        if self.is_shared() {
            // Resolve aliases before FileStore can create even its lock file.
            let destination = root.canonicalize().map_err(super::store::io_error)?;
            if destination.starts_with(self.root()) {
                return Err(AppError::invalid(
                    "Personal copies must be saved outside the shared project directory",
                ));
            }
        }
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
        let _authority = authority.as_ref().map(|a| a.lock()).transpose()?;
        let store = FileStore::create(root, &document)?;
        let old_root = self.root().to_path_buf();
        self.active_session()?.rebase_sources(&old_root);
        self.store = Storage::Local(store);
        Ok(())
    }
    pub fn prepare_close(&mut self, id: &str, revision: u64, discard: bool) -> Result<()> {
        if matches!(self.store, Storage::Transient(_)) {
            return Err(AppError::invalid("Read-only preview"));
        }
        let snapshot = self.check(id, revision)?;
        if discard {
            // Explicit discard must remain available when storage is unwritable.
            // Suppress recovery when possible; a leftover candidate still requires
            // an explicit choice on next open and is never loaded silently.
            if self.is_shared() {
                // If suppression cannot be persisted, open presents an explicit recovery
                // choice for the unaccepted candidate rather than silently publishing it.
                let _ = self.workspace_mut()?.suppress_recovery();
                return Ok(());
            }
            let path = self.root().join("project.json");
            let primary = std::fs::read_to_string(path)
                .ok()
                .and_then(|s| ProjectDocument::from_json(&s).ok());
            if let Some(doc) = primary {
                let _ = self.store_mut()?.keep_primary(&doc);
            }
        } else if self.persisted_revision() != snapshot.document.revision {
            return Err(AppError::new(ErrorCode::SaveFailed, "项目仍有未保存内容"));
        }
        Ok(())
    }
}
