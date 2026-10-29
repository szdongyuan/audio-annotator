use super::*;
use crate::error::Result;
use std::sync::Arc;

#[derive(Clone)]
pub struct RememberedLayers {
    manifest: CollaborationManifest,
    snapshot: CollaborationSnapshot,
}
impl RememberedLayers {
    pub fn adopt_prepared_catalog(&mut self, prepared: &PreparedCatalogUpdate) -> Result<()> {
        super::validation::require(
            self.manifest == prepared.source.manifest,
            "Remembered retirement source changed",
        )?;
        let mut snapshot = self.snapshot.clone();
        for author in &mut snapshot.authors {
            if let Some(layer) = &author.layer {
                author.layer = Some(prepared.retirement.layer(layer)?);
            }
        }
        self.manifest = prepared.repo.manifest().clone();
        self.snapshot = snapshot;
        Ok(())
    }
    /// Extend validation authority only after explicit catalog adoption. Previously
    /// displayed layers remain intact; callers then install the fresh full snapshot.
    pub fn adopt_catalog(&mut self, manifest: CollaborationManifest) -> Result<()> {
        manifest.validate()?;
        super::catalog_workspace::validate_extension(&self.manifest, &manifest)?;
        self.manifest = manifest;
        Ok(())
    }
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
        limit(snapshot.authors.len() <= MAX_AUTHORS)?;
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
    pub(super) manifest_hash: String,
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
        let (checkpoint, manifest_hash) = self.repo.publish_with_source(
            &self.actor,
            self.base.as_ref(),
            &self.pending.payload,
            fault,
            None,
        )?;
        Ok(PublicationAck {
            manifest_hash,
            nonce: self.nonce,
            base: self.base,
            pending: self.pending,
            checkpoint,
        })
    }
}
