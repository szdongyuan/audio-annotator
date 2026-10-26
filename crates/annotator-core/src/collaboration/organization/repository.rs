use super::*;
use crate::{
    collaboration::{atomic, validation::limit, AuthorSession, CollaborationRepository},
    error::{AppError, ErrorCode, Result},
};
use std::path::Path;
pub(crate) fn read(root: &Path, project_id: &str) -> Result<Organization> {
    Organization::parse(
        &atomic::read(&root.join("organization.json"), MAX_ORGANIZATION_BYTES)?,
        project_id,
    )
}
pub(crate) fn encode(head: &Organization) -> Result<Vec<u8>> {
    head.validate()?;
    let bytes =
        serde_json::to_vec(head).map_err(|_| AppError::invalid("Cannot encode organization"))?;
    limit(bytes.len() <= MAX_ORGANIZATION_BYTES)?;
    Ok(bytes)
}
impl CollaborationRepository {
    pub fn organization(&self) -> &Organization {
        &self.organization
    }
    pub fn read_organization(&self) -> Result<Organization> {
        self.authority()?;
        read(&self.root, &self.manifest.project_id)
    }
    pub fn apply_organization(
        &self,
        session: &AuthorSession,
        expected_revision: u64,
        operation: OrganizationOperation,
    ) -> Result<Organization> {
        self.apply_organization_controlled(
            session,
            expected_revision,
            operation,
            &std::sync::atomic::AtomicBool::new(false),
            || Ok(()),
        )
    }
    /// Complete bounded catalog I/O before acquiring the native owner's final guard.
    /// The returned guard is held only across cancellable atomic head replacement.
    pub fn apply_organization_controlled<Guard>(
        &self,
        session: &AuthorSession,
        expected_revision: u64,
        operation: OrganizationOperation,
        cancel: &std::sync::atomic::AtomicBool,
        before_commit: impl FnOnce() -> Result<Guard>,
    ) -> Result<Organization> {
        crate::media::identity::check_cancel(cancel)?;
        let _lock = atomic::short_lock(&self.root.join("catalog/.commit.lock"))?;
        self.session_authority(session)?;
        let current = self.reload_catalog()?;
        if current.organization.revision != expected_revision {
            let mut e = AppError::new(ErrorCode::RevisionConflict, "Organization revision changed");
            e.details = Some(serde_json::json!({"currentRevision":current.organization.revision}));
            return Err(e);
        }
        let next = current.organization.apply(operation)?;
        let bytes = encode(&next)?;
        let _guard = before_commit()?;
        atomic::replace_metadata_controlled(
            &self.root.join("organization.json"),
            &bytes,
            None,
            Some(cancel),
        )?;
        Ok(next)
    }
    pub fn seal_media_placement(
        &self,
        layout_revision: u64,
        target_folder_id: Option<String>,
        relative_folder_segments: Vec<String>,
        original_filename: String,
    ) -> Result<NativePlacementPlan> {
        let head = self.read_organization()?;
        if head.layout_revision != layout_revision {
            return Err(AppError::new(
                ErrorCode::RevisionConflict,
                "Organization layout changed",
            ));
        }
        NativePlacementCapture::new(head, target_folder_id)?
            .seal(relative_folder_segments, original_filename)
    }
    /// Seed a freshly created, owned copy target with validated folder IDs before any media.
    /// Existing projects cannot be replaced by this initialization capability.
    pub fn initialize_copy_layout(
        &self,
        session: &AuthorSession,
        source: &Organization,
    ) -> Result<Self> {
        source.validate()?;
        let _lock = atomic::short_lock(&self.root.join("catalog/.commit.lock"))?;
        self.session_authority(session)?;
        let current = self.reload_catalog()?;
        if current.organization.revision != 0
            || !current.organization.folders.is_empty()
            || !current.organization.media.is_empty()
        {
            return Err(AppError::invalid("Copy layout requires a new empty target"));
        }
        let mut head = Organization::empty(self.manifest.project_id.clone());
        head.folders = source.folders.clone();
        atomic::replace_metadata_controlled(
            &self.root.join("organization.json"),
            &encode(&head)?,
            None,
            None,
        )?;
        self.reload_catalog()
    }
    pub fn capture_media_placement(
        &self,
        target_folder_id: Option<String>,
    ) -> Result<NativePlacementCapture> {
        NativePlacementCapture::new(self.read_organization()?, target_folder_id)
    }
}
impl NativePlacementCapture {
    fn new(head: Organization, target_folder_id: Option<String>) -> Result<Self> {
        let mut target_path = vec![];
        let mut parent = target_folder_id.as_deref();
        while let Some(id) = parent {
            let folder = head
                .folders
                .iter()
                .find(|f| f.id == id)
                .ok_or_else(|| AppError::invalid("Target folder no longer exists"))?;
            target_path.push(folder.name.clone());
            parent = folder.parent_id.as_deref();
        }
        target_path.reverse();
        let siblings = head
            .folders
            .iter()
            .map(|f| ((f.parent_id.clone(), f.name.to_lowercase()), f.id.clone()))
            .collect();
        Ok(Self {
            head,
            target_folder_id,
            target_path,
            siblings,
        })
    }
    pub fn layout_revision(&self) -> u64 {
        self.head.layout_revision
    }
    pub fn target_path(&self) -> &[String] {
        &self.target_path
    }
    pub fn seal(
        &self,
        relative_folder_segments: Vec<String>,
        original_filename: String,
    ) -> Result<NativePlacementPlan> {
        for segment in &relative_folder_segments {
            validation::basename(segment, true)?;
        }
        validation::basename(&original_filename, false)?;
        let plan = NativePlacementPlan {
            project_id: self.head.project_id.clone(),
            layout_revision: self.head.layout_revision,
            target_folder_id: self.target_folder_id.clone(),
            relative_folder_segments,
            original_filename,
        };
        limit(
            self.target_path.len() + plan.relative_folder_segments.len() <= 16
                && self.head.revision < crate::model::validation::MAX_SAFE_INTEGER,
        )?;
        let mut parent = self.target_folder_id.clone();
        let mut additional = 0;
        for segment in &plan.relative_folder_segments {
            if additional == 0 {
                if let Some(id) = self.siblings.get(&(parent.clone(), segment.to_lowercase())) {
                    parent = Some(id.clone());
                    continue;
                }
            }
            additional += 1;
        }
        limit(self.head.folders.len() + additional <= MAX_FOLDERS)?;
        Ok(plan)
    }
}
