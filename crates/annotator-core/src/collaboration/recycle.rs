//! Shared, reversible visibility. Catalog descriptors, audio and author layers stay intact.
use super::{
    atomic,
    validation::{limit, require, uuid, MAX_MEDIA},
    AuthorSession, CollaborationRepository,
};
use crate::error::{AppError, ErrorCode, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::atomic::AtomicBool};
const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecycleOperation {
    pub operation_id: String,
    pub media_ids: Vec<String>,
    pub trash: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecycledMedia {
    pub media_id: String,
    pub deleted_by: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    operation_id: String,
    payload_hash: String,
    actor_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recycle {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub revision: u64,
    pub trashed: Vec<RecycledMedia>,
    pub recent_operations: Vec<Receipt>,
}
impl RecycleOperation {
    fn validate(&self) -> Result<()> {
        uuid(&self.operation_id)?;
        limit(!self.media_ids.is_empty() && self.media_ids.len() <= MAX_MEDIA)?;
        let mut seen = HashSet::new();
        for id in &self.media_ids {
            uuid(id)?;
            require(seen.insert(id), "Duplicate recycle media")?;
        }
        Ok(())
    }
}
impl Recycle {
    /// Filter an exchange projection, never the live editor or an author's layer.
    pub fn filter_export(&self, doc: &mut crate::model::ProjectDocument) {
        let ids: HashSet<_> = self.trashed.iter().map(|m| &m.media_id).collect();
        doc.media.retain(|m| !ids.contains(&m.id));
        doc.annotations
            .retain(|a| !ids.contains(&a.region.media_id));
        doc.edits.retain(|e| !ids.contains(&e.region.media_id));
        doc.analysis.retain(|id, _| !ids.contains(id));
        doc.playback_mix.retain(|id, _| !ids.contains(id));
        doc.view_state.media.retain(|id, _| !ids.contains(id));
        if doc
            .view_state
            .active_media_id
            .as_ref()
            .is_some_and(|id| ids.contains(id))
        {
            doc.view_state.active_media_id = None;
        }
        if doc
            .view_state
            .compare_media_id
            .as_ref()
            .is_some_and(|id| ids.contains(id))
        {
            doc.view_state.compare_media_id = None;
        }
        if doc.view_state.compare_media_id.is_none() {
            doc.view_state.linked_time = false;
        }
    }
    fn empty(project_id: String) -> Self {
        Self {
            kind: "audio-annotator-recycle".into(),
            format_version: 1,
            project_id,
            revision: 0,
            trashed: vec![],
            recent_operations: vec![],
        }
    }
    pub(super) fn validate(&self, project_id: &str) -> Result<()> {
        require(
            self.kind == "audio-annotator-recycle"
                && self.format_version == 1
                && self.project_id == project_id,
            "Invalid recycle identity",
        )?;
        uuid(&self.project_id)?;
        limit(
            self.revision < crate::model::validation::MAX_SAFE_INTEGER
                && self.trashed.len() <= MAX_MEDIA
                && self.recent_operations.len() <= 64,
        )?;
        let mut seen = HashSet::new();
        for item in &self.trashed {
            uuid(&item.media_id)?;
            uuid(&item.deleted_by)?;
            require(seen.insert(&item.media_id), "Duplicate recycled media")?;
        }
        let mut operations = HashSet::new();
        for receipt in &self.recent_operations {
            uuid(&receipt.operation_id)?;
            super::validation::digest(&receipt.payload_hash)?;
            uuid(&receipt.actor_id)?;
            require(
                operations.insert(&receipt.operation_id),
                "Duplicate recycle receipt",
            )?;
        }
        Ok(())
    }
    fn apply(
        &self,
        actor: &str,
        expected: u64,
        operation: RecycleOperation,
        known: &HashSet<&str>,
    ) -> Result<Self> {
        operation.validate()?;
        let payload_hash = super::validation::hash(
            &serde_json::to_vec(&operation)
                .map_err(|_| AppError::invalid("Cannot hash recycle operation"))?,
        );
        if let Some(receipt) = self
            .recent_operations
            .iter()
            .find(|r| r.operation_id == operation.operation_id)
        {
            require(
                receipt.payload_hash == payload_hash && receipt.actor_id == actor,
                "Recycle operation ID reused",
            )?;
            return Ok(self.clone());
        }
        if self.revision != expected {
            return Err(AppError::new(
                ErrorCode::RevisionConflict,
                "回收站已被其他协作者更新，请核对后重试",
            ));
        }
        require(
            operation
                .media_ids
                .iter()
                .all(|id| known.contains(id.as_str())),
            "Unknown recycle media",
        )?;
        let ids: HashSet<_> = operation.media_ids.iter().collect();
        let mut next = self.clone();
        next.trashed.retain(|m| !ids.contains(&m.media_id));
        if operation.trash {
            next.trashed
                .extend(operation.media_ids.iter().map(|id| RecycledMedia {
                    media_id: id.clone(),
                    deleted_by: actor.to_owned(),
                }));
        }
        next.trashed.sort_by(|a, b| a.media_id.cmp(&b.media_id));
        next.revision += 1;
        next.recent_operations.push(Receipt {
            operation_id: operation.operation_id,
            payload_hash,
            actor_id: actor.to_owned(),
        });
        if next.recent_operations.len() > 64 {
            next.recent_operations.remove(0);
        }
        next.validate(&self.project_id)?;
        Ok(next)
    }
}
impl CollaborationRepository {
    pub fn read_recycle(&self) -> Result<Recycle> {
        self.authority()?;
        let path = self.metadata_root.join("recycle.json");
        match std::fs::symlink_metadata(&path) {
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && self.manifest.format_version == super::CURRENT_COLLABORATION_FORMAT =>
            {
                return Ok(Recycle::empty(self.manifest.project_id.clone()))
            }
            Err(e) => return Err(atomic::io(e)),
            _ => (),
        }
        let bytes = atomic::read(&path, MAX_BYTES)?;
        let head: Recycle = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::invalid("Invalid recycle file"))?;
        head.validate(&self.manifest.project_id)?;
        Ok(head)
    }
    pub fn apply_recycle_controlled<Guard>(
        &self,
        session: &AuthorSession,
        expected: u64,
        operation: RecycleOperation,
        cancel: &AtomicBool,
        before_commit: impl FnOnce() -> Result<Guard>,
    ) -> Result<Recycle> {
        crate::media::identity::check_cancel(cancel)?;
        let _lock = self.commit_guard()?;
        self.session_authority(session)?;
        let catalog = self.reload_catalog()?;
        let head = self.read_recycle()?;
        let known = catalog
            .manifest
            .media
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        let next = head.apply(&session.identity().author_id, expected, operation, &known)?;
        let bytes = serde_json::to_vec(&next)
            .map_err(|_| AppError::invalid("Cannot encode recycle file"))?;
        limit(bytes.len() <= MAX_BYTES)?;
        let _guard = before_commit()?;
        if next.revision != head.revision {
            let path = self.metadata_root.join("recycle.json");
            if path.try_exists().map_err(atomic::io)? {
                atomic::replace_metadata_controlled(&path, &bytes, None, Some(cancel))?;
            } else {
                atomic::publish_new(&path, &bytes, None, Some(cancel))?;
            }
        }
        Ok(next)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn id(n: u8) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }
    #[test]
    fn atomic_unknown_conflict_and_response_loss_retry_after_restore() {
        let media = [id(1), id(2)];
        let known = media.iter().map(String::as_str).collect();
        let head = Recycle::empty(id(9));
        let op = RecycleOperation {
            operation_id: id(10),
            media_ids: media.to_vec(),
            trash: true,
        };
        let deleted = head.apply(&id(7), 0, op.clone(), &known).unwrap();
        assert_eq!(deleted.trashed.len(), 2);
        assert!(head
            .apply(
                &id(7),
                0,
                RecycleOperation {
                    media_ids: vec![id(1), id(3)],
                    ..op.clone()
                },
                &known
            )
            .is_err());
        assert!(deleted
            .apply(
                &id(8),
                0,
                RecycleOperation {
                    operation_id: id(11),
                    ..op.clone()
                },
                &known
            )
            .is_err());
        let restored = deleted
            .apply(
                &id(8),
                1,
                RecycleOperation {
                    operation_id: id(12),
                    trash: false,
                    ..op.clone()
                },
                &known,
            )
            .unwrap();
        let retried = restored.apply(&id(7), 0, op.clone(), &known).unwrap();
        assert!(retried.trashed.is_empty());
        assert_eq!(retried.revision, 2);
        assert!(restored.apply(&id(8), 0, op, &known).is_err());
    }
}
