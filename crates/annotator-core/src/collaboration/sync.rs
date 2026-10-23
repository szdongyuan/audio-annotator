use super::*;
use crate::error::Result;
use std::sync::Arc;

pub struct RememberedLayers {
    manifest: CollaborationManifest,
    snapshot: CollaborationSnapshot,
}
impl RememberedLayers {
    pub fn new(manifest: CollaborationManifest) -> Self {
        Self {
            snapshot: CollaborationSnapshot {
                project_id: manifest.project_id.clone(),
                authors: vec![],
            },
            manifest,
        }
    }
    pub fn snapshot(&self) -> &CollaborationSnapshot {
        &self.snapshot
    }
    pub fn update(&mut self, mut snapshot: CollaborationSnapshot) -> Result<()> {
        use super::validation::{limit, require};
        use crate::error::AppError;
        require(
            snapshot.project_id == self.manifest.project_id,
            "Remote snapshot project mismatch",
        )?;
        let mut ids = std::collections::HashSet::new();
        for author in &mut snapshot.authors {
            require(
                ids.insert(author.identity.author_id.clone()),
                "Duplicate snapshot author",
            )?;
            if let Some(layer) = &author.layer {
                if let Err(error) = AuthorLayer::parse(
                    &serde_json::to_vec(layer).map_err(|_| AppError::invalid("Invalid layer"))?,
                    &self.manifest,
                    &author.identity.author_id,
                ) {
                    author.error = Some(error);
                    author.layer = None;
                }
            }
            if let Some(old) = self
                .snapshot
                .authors
                .iter()
                .find(|a| a.identity.author_id == author.identity.author_id)
            {
                let regressed = old.layer.as_ref().is_some_and(|old| {
                    author.layer.as_ref().is_none_or(|new| {
                        new.revision < old.revision
                            || (new.revision == old.revision && new.hash != old.hash)
                    })
                });
                if author.error.is_some() || regressed {
                    author.layer = old.layer.clone();
                    if author.error.is_none() {
                        author.error = Some(AppError::invalid(
                            "Missing or regressed shared author layer",
                        ));
                    }
                }
            }
        }
        for old in &self.snapshot.authors {
            if !ids.contains(&old.identity.author_id) {
                let mut retained = old.clone();
                retained.error = Some(AppError::invalid("Previously verified author missing"));
                snapshot.authors.push(retained);
            }
        }
        limit(snapshot.authors.len() <= MAX_ACCOUNTS)?;
        let mut total = 0usize;
        for author in &snapshot.authors {
            if let Some(layer) = &author.layer {
                total += serde_json::to_vec(layer)
                    .map_err(|_| AppError::invalid("Cannot encode layer"))?
                    .len();
            }
        }
        limit(total <= MAX_TOTAL_LAYER_BYTES)?;
        self.snapshot = snapshot;
        Ok(())
    }
}

/// Owns an admitted author's lease until the worker ends; it is never a renderer DTO.
pub struct PublicationCapture {
    pub(super) repo: Arc<CollaborationRepository>,
    pub(super) actor: Arc<AuthorSession>,
    pub(super) nonce: uuid::Uuid,
    pub(super) base: Option<Checkpoint>,
    pub(super) pending: PendingPayload,
}
pub struct PublicationAck {
    pub(super) nonce: uuid::Uuid,
    pub(super) base: Option<Checkpoint>,
    pub(super) pending: PendingPayload,
    pub(super) checkpoint: Checkpoint,
}
impl PublicationCapture {
    pub fn generation(&self) -> u64 {
        self.pending.generation
    }
    pub fn payload(&self) -> &LayerPayload {
        &self.pending.payload
    }
    pub fn publish(self) -> Result<PublicationAck> {
        self.publish_controlled(None)
    }
    pub fn publish_controlled(self, fault: Option<atomic::PublishFault>) -> Result<PublicationAck> {
        let checkpoint = self.repo.publish_controlled(
            &self.actor,
            self.base.as_ref(),
            &self.pending.payload,
            fault,
            None,
        )?;
        Ok(PublicationAck {
            nonce: self.nonce,
            base: self.base,
            pending: self.pending,
            checkpoint,
        })
    }
}
