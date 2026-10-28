use super::*;
use crate::{
    collaboration::validation::{decode, limit, require, uuid},
    error::{AppError, Result},
    model::validation::MAX_SAFE_INTEGER,
};
use std::collections::{HashMap, HashSet};
pub(super) fn basename(name: &str, folder: bool) -> Result<()> {
    let chars = name.chars().count();
    require(
        chars > 0
            && chars <= if folder { 128 } else { 255 }
            && name.len() <= if folder { 512 } else { 1024 }
            && !name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            && name != "."
            && name != ".."
            && (!folder || name.trim() == name),
        "Invalid organization name",
    )
}
impl Organization {
    pub fn parse(bytes: &[u8], project_id: &str) -> Result<Self> {
        let head: Self = decode(
            bytes,
            MAX_ORGANIZATION_BYTES,
            "audio-annotator-organization",
        )?;
        head.validate()?;
        require(
            head.project_id == project_id,
            "Organization project mismatch",
        )?;
        Ok(head)
    }
    pub fn validate(&self) -> Result<()> {
        require(
            self.kind == "audio-annotator-organization" && self.format_version == 1,
            "Invalid organization format",
        )?;
        uuid(&self.project_id)?;
        limit(
            self.revision <= MAX_SAFE_INTEGER
                && self.layout_revision <= self.revision
                && self.folders.len() <= MAX_FOLDERS
                && self.media.len() <= 10_000,
        )?;
        let mut folders = HashMap::new();
        let mut siblings = HashSet::new();
        for f in &self.folders {
            uuid(&f.id)?;
            basename(&f.name, true)?;
            require(
                folders.insert(f.id.as_str(), f).is_none(),
                "Duplicate folder ID",
            )?;
            require(
                siblings.insert((f.parent_id.as_deref(), f.name.to_lowercase())),
                "Duplicate sibling name",
            )?;
        }
        for f in &self.folders {
            let mut current = Some(f.id.as_str());
            let mut seen = HashSet::new();
            while let Some(id) = current {
                require(seen.insert(id), "Organization folder cycle")?;
                limit(seen.len() <= 16)?;
                current = folders
                    .get(id)
                    .ok_or_else(|| AppError::invalid("Missing folder parent"))?
                    .parent_id
                    .as_deref();
            }
        }
        let mut media = HashSet::new();
        for m in &self.media {
            uuid(&m.media_id)?;
            basename(&m.original_filename, false)?;
            require(media.insert(&m.media_id), "Duplicate media membership")?;
            if let Some(id) = &m.folder_id {
                uuid(id)?;
                require(folders.contains_key(id.as_str()), "Missing media folder")?;
            }
        }
        Ok(())
    }
    pub fn apply(&self, operation: OrganizationOperation) -> Result<Self> {
        self.apply_with_recycled(operation, || Ok(HashSet::new()))
    }
    /// Only the repository may authorize recycled memberships using its under-lock read.
    pub(super) fn apply_with_recycled(
        &self,
        operation: OrganizationOperation,
        recycled: impl FnOnce() -> Result<HashSet<String>>,
    ) -> Result<Self> {
        self.validate()?;
        let mut next = self.clone();
        match operation {
            OrganizationOperation::CreateFolder {
                id,
                parent_id,
                name,
            } => next.folders.push(Folder {
                id,
                parent_id,
                name,
            }),
            OrganizationOperation::RenameFolder { id, name } => {
                next.folders
                    .iter_mut()
                    .find(|f| f.id == id)
                    .ok_or_else(|| AppError::invalid("Unknown folder"))?
                    .name = name
            }
            OrganizationOperation::MoveFolder { id, parent_id } => {
                next.folders
                    .iter_mut()
                    .find(|f| f.id == id)
                    .ok_or_else(|| AppError::invalid("Unknown folder"))?
                    .parent_id = parent_id
            }
            OrganizationOperation::RemoveFolder { id } => {
                let parent = next
                    .folders
                    .iter()
                    .find(|f| f.id == id)
                    .ok_or_else(|| AppError::invalid("Unknown folder"))?
                    .parent_id
                    .clone();
                let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
                for folder in &self.folders {
                    if let Some(parent) = folder.parent_id.as_deref() {
                        children.entry(parent).or_default().push(&folder.id);
                    }
                }
                // validate() bounds this traversal to 10,000 folders and 16 levels.
                let mut subtree = HashSet::new();
                let mut pending = vec![id.as_str()];
                while let Some(folder) = pending.pop() {
                    subtree.insert(folder);
                    if let Some(descendants) = children.get(folder) {
                        pending.extend(descendants);
                    }
                }
                // Empty subtrees need no recycle authority, including when that file is unavailable.
                let recycled = if next
                    .media
                    .iter()
                    .any(|m| m.folder_id.as_deref().is_some_and(|f| subtree.contains(f)))
                {
                    recycled()?
                } else {
                    HashSet::new()
                };
                let blocked = next
                    .media
                    .iter()
                    .filter(|m| {
                        m.folder_id.as_deref().is_some_and(|f| subtree.contains(f))
                            && !recycled.contains(&m.media_id)
                    })
                    .count();
                require(
                    blocked == 0,
                    &format!("目录及子目录仍关联 {blocked} 个未进入共享回收站的音频（包括隐藏或未加载的音频）"),
                )?;
                for membership in &mut next.media {
                    if membership
                        .folder_id
                        .as_deref()
                        .is_some_and(|f| subtree.contains(f))
                    {
                        membership.folder_id = parent.clone();
                    }
                }
                next.folders.retain(|f| !subtree.contains(f.id.as_str()));
            }
            OrganizationOperation::MoveMedia {
                media_id,
                folder_id,
            } => {
                next.media
                    .iter_mut()
                    .find(|m| m.media_id == media_id)
                    .ok_or_else(|| AppError::invalid("Unknown media"))?
                    .folder_id = folder_id
            }
        }
        next.revision += 1;
        next.layout_revision += 1;
        next.validate()?;
        Ok(next)
    }
    pub(crate) fn add_media(&self, id: &str, plan: &NativePlacementPlan) -> Result<Self> {
        require(
            self.project_id == plan.project_id,
            "Placement project mismatch",
        )?;
        if self.layout_revision != plan.layout_revision {
            return Err(crate::error::AppError::new(
                crate::error::ErrorCode::RevisionConflict,
                "Organization layout changed",
            ));
        }
        let mut next = self.clone();
        let mut parent = plan.target_folder_id.clone();
        if let Some(id) = &parent {
            require(
                next.folders.iter().any(|f| &f.id == id),
                "Placement target missing",
            )?;
        }
        for name in &plan.relative_folder_segments {
            if let Some(existing) = next
                .folders
                .iter()
                .find(|f| f.parent_id == parent && f.name.to_lowercase() == name.to_lowercase())
            {
                parent = Some(existing.id.clone());
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                next.folders.push(Folder {
                    id: id.clone(),
                    parent_id: parent,
                    name: name.clone(),
                });
                parent = Some(id);
            }
        }
        next.media.push(MediaMembership {
            media_id: id.into(),
            folder_id: parent,
            original_filename: plan.original_filename.clone(),
        });
        next.revision += 1;
        next.validate()?;
        Ok(next)
    }
}
