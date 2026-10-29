//! Validated source checkpoint bindings; applying a rebase belongs to the transaction.
use crate::{
    collaboration::{validation::*, Checkpoint},
    error::Result,
    model::validation::MAX_SAFE_INTEGER,
};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointMapping {
    pub author_id: String,
    pub source: Checkpoint,
    pub target: Checkpoint,
}
impl CheckpointMapping {
    pub(crate) fn validate(&self) -> Result<()> {
        uuid(&self.author_id)?;
        for checkpoint in [&self.source, &self.target] {
            require(
                (1..=MAX_SAFE_INTEGER).contains(&checkpoint.revision),
                "Invalid mapped revision",
            )?;
            digest(&checkpoint.hash)?;
        }
        Ok(())
    }
}

use crate::collaboration::{atomic, AuthorLayer, CollaborationManifest, CollaborationRepository};
use std::{collections::HashSet, fs, path::Path, sync::atomic::AtomicBool};

/// One projection for shared history, private checkpoints and live undo/redo.
pub fn project_document(
    document: &mut crate::model::ProjectDocument,
    retired: &HashSet<String>,
) -> Result<()> {
    document.media.retain(|m| !retired.contains(&m.id));
    document
        .annotations
        .retain(|a| !retired.contains(&a.region.media_id));
    document
        .edits
        .retain(|e| !retired.contains(&e.region.media_id));
    document.analysis.retain(|id, _| !retired.contains(id));
    document.playback_mix.retain(|id, _| !retired.contains(id));
    document
        .view_state
        .media
        .retain(|id, _| !retired.contains(id));
    for selected in [
        &mut document.view_state.active_media_id,
        &mut document.view_state.compare_media_id,
    ] {
        if selected.as_ref().is_some_and(|id| retired.contains(id)) {
            *selected = None;
        }
    }
    let maximum = document
        .media
        .iter()
        .map(crate::model::MediaDescriptor::duration)
        .fold(0.0, f64::max);
    for (id, view) in &mut document.view_state.media {
        if let Some(media) = document.media.iter().find(|m| &m.id == id) {
            let limit = if document.view_state.linked_time {
                maximum
            } else {
                media.duration()
            };
            view.end_seconds = view.end_seconds.min(limit);
            if view.start_seconds >= view.end_seconds {
                view.start_seconds = 0.0;
            }
        }
    }
    document.validate()
}
pub(crate) fn project_payload(
    payload: &mut crate::collaboration::LayerPayload,
    retired: &HashSet<String>,
) {
    payload
        .annotations
        .retain(|a| !retired.contains(&a.region.media_id));
    payload
        .media_labels
        .retain(|m| !retired.contains(&m.media_id));
}

/// Non-serializable proof, built by walking hash-bound, payload-free provenance.
/// Each map is still bound to its exact source entry and applied in chain order.
#[derive(Clone)]
pub(crate) struct Retirement {
    pub retired: HashSet<String>,
    pub source: CollaborationManifest,
    maps: Vec<Vec<CheckpointMapping>>,
}
impl Retirement {
    pub(crate) fn read(
        repo: &CollaborationRepository,
        source_hash: &str,
        catalog: Vec<crate::collaboration::PublicMedia>,
    ) -> Result<Self> {
        digest(source_hash)?;
        if source_hash == repo.manifest_identity() {
            let mut source = repo.manifest().clone();
            source.media = catalog;
            super::super::catalog_workspace::validate_extension(&source, repo.manifest())?;
            return Ok(Self {
                retired: HashSet::new(),
                source,
                maps: vec![],
            });
        }
        let mut bytes = atomic::read(&repo.root.join("collaboration.json"), MAX_LAYER_BYTES)?;
        require(
            hash(&bytes) == repo.manifest_identity(),
            "Retirement authority changed",
        )?;
        let mut dir = repo.metadata_root.clone();
        let mut maps = vec![];
        let mut budget = MAX_TOTAL_LAYER_BYTES;
        let mut seen = HashSet::new();
        let mut retired = HashSet::new();
        for _ in 0..=MAX_MEDIA {
            let entry = super::generation::GenerationEntry::parse(&bytes)?;
            require(seen.insert(hash(&bytes)), "Cyclic retirement provenance")?;
            let descriptor_bytes =
                atomic::read(&dir.join("generation.json"), MAX_LAYER_BYTES.min(budget))?;
            budget -= descriptor_bytes.len();
            require(
                hash(&descriptor_bytes) == entry.generation_hash,
                "Retirement generation digest mismatch",
            )?;
            let descriptor = super::generation::GenerationDescriptor::parse(&descriptor_bytes)?;
            require(
                descriptor.project_id == entry.project_id
                    && descriptor.generation_id == entry.metadata_generation,
                "Retirement generation identity mismatch",
            )?;
            retired.extend(descriptor.retired.iter().map(|r| r.media_id.clone()));
            maps.push(descriptor.checkpoint_map);
            let prior = atomic::read(&dir.join("source-entry.json"), MAX_LAYER_BYTES.min(budget))?;
            budget -= prior.len();
            require(
                hash(&prior) == descriptor.source_entry_hash,
                "Retirement source digest mismatch",
            )?;
            let version = serde_json::from_slice::<serde_json::Value>(&prior)
                .map_err(|_| crate::error::AppError::invalid("Invalid retirement source"))?
                ["formatVersion"]
                .as_u64();
            let (mut source, generation) = match version {
                Some(5) => {
                    let old: crate::collaboration::catalog_storage::DefaultManifest =
                        serde_json::from_slice(&prior).map_err(|_| {
                            crate::error::AppError::invalid("Invalid retirement source entry")
                        })?;
                    (old.effective()?, None)
                }
                Some(6) => {
                    let old = super::generation::GenerationEntry::parse(&prior)?;
                    (old.effective(), Some(old.metadata_generation))
                }
                _ => {
                    return Err(crate::error::AppError::invalid(
                        "Unsupported retirement source",
                    ))
                }
            };
            require(
                source.project_id == entry.project_id
                    && source.name == entry.name
                    && source.created_at == entry.created_at
                    && generation == descriptor.source_generation,
                "Retirement source identity mismatch",
            )?;
            if descriptor.source_entry_hash == source_hash {
                source.media = catalog;
                source.validate()?;
                require(
                    source.project_id == repo.manifest.project_id
                        && source.name == repo.manifest.name
                        && source.created_at == repo.manifest.created_at,
                    "Retirement project changed",
                )?;
                require(
                    source.media.iter().all(|old| {
                        retired.contains(&old.id)
                            || repo.manifest.media.iter().any(|new| new == old)
                    }),
                    "Unproven catalog shrink or descriptor mutation",
                )?;
                require(
                    repo.manifest.media.iter().all(|m| !retired.contains(&m.id)),
                    "Retired catalog identity reappeared",
                )?;
                maps.reverse();
                return Ok(Self {
                    retired,
                    source,
                    maps,
                });
            }
            require(
                generation.is_some(),
                "Private source entry is not retirement ancestry",
            )?;
            dir = repo
                .metadata_root
                .join("provenance")
                .join(&descriptor.source_entry_hash);
            bytes = prior;
        }
        limit(false)?;
        unreachable!()
    }
    pub(crate) fn checkpoint(
        &self,
        actor: &str,
        checkpoint: Option<&Checkpoint>,
    ) -> Result<Option<Checkpoint>> {
        let Some(mut checkpoint) = checkpoint.cloned() else {
            return Ok(None);
        };
        for map in &self.maps {
            checkpoint = map
                .iter()
                .find(|m| m.author_id == actor && m.source == checkpoint)
                .ok_or_else(|| {
                    crate::error::AppError::invalid("Unknown retirement source checkpoint")
                })?
                .target
                .clone();
        }
        Ok(Some(checkpoint))
    }
    pub(crate) fn changed(&self) -> bool {
        !self.maps.is_empty()
    }
    pub(crate) fn layer(&self, layer: &AuthorLayer) -> Result<AuthorLayer> {
        if !self.changed() {
            return Ok(layer.clone());
        }
        let target = self
            .checkpoint(&layer.author_id, Some(&layer.checkpoint()))?
            .unwrap();
        let mut layer = layer.clone();
        project_payload(&mut layer.payload, &self.retired);
        layer.parent = if target.revision == 1 {
            None
        } else {
            require(layer.parent.is_some(), "Missing retirement source parent")?;
            self.checkpoint(&layer.author_id, layer.parent.as_ref())?
        };
        layer.revision = target.revision;
        layer.hash = layer.computed_hash()?;
        require(
            layer.hash == target.hash,
            "Retirement layer payload or parent changed",
        )?;
        Ok(layer)
    }
}

/// Reads the complete retained chain, with one transaction-wide byte budget.
pub(super) fn retained_history(
    repo: &CollaborationRepository,
    author: &str,
    budget: &mut usize,
) -> Result<Vec<AuthorLayer>> {
    uuid(author)?;
    let dir = repo.metadata_root.join("annotations").join(author);
    if !dir.try_exists().map_err(atomic::io)? {
        return Ok(vec![]);
    }
    atomic::safe_existing(&dir)?;
    let mut revisions = vec![];
    for (index, entry) in fs::read_dir(&dir).map_err(atomic::io)?.enumerate() {
        limit(index < 256)?;
        let entry = entry.map_err(atomic::io)?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| crate::error::AppError::invalid("Invalid history name"))?;
        if name == ".writer.lock" || (name.starts_with('.') && name.ends_with(".tmp")) {
            continue;
        }
        require(
            name.len() == 25
                && name.ends_with(".json")
                && name[..20].bytes().all(|b| b.is_ascii_digit()),
            "Invalid history revision filename",
        )?;
        let revision = name[..20]
            .parse::<u64>()
            .map_err(|_| crate::error::AppError::invalid("Invalid history revision"))?;
        revisions.push((revision, entry.path()));
    }
    revisions.sort_by_key(|r| r.0);
    limit(revisions.len() <= 16)?;
    let mut history: Vec<AuthorLayer> = vec![];
    for (revision, path) in revisions {
        let bytes = atomic::read(&path, MAX_LAYER_BYTES.min(*budget))?;
        *budget -= bytes.len();
        let layer = AuthorLayer::parse(&bytes, &repo.manifest, author)?;
        require(layer.revision == revision, "History revision mismatch")?;
        if let Some(previous) = history.last() {
            require(
                layer.parent.as_ref() == Some(&previous.checkpoint()),
                "Invalid retained history chain",
            )?;
        }
        history.push(layer);
    }
    Ok(history)
}

pub(super) fn project_history(
    history: Vec<AuthorLayer>,
    manifest: &CollaborationManifest,
    removed: &HashSet<String>,
) -> Result<(Vec<AuthorLayer>, Vec<CheckpointMapping>)> {
    let mut projected: Vec<AuthorLayer> = vec![];
    let mut mappings = vec![];
    for mut layer in history {
        let source = layer.checkpoint();
        project_payload(&mut layer.payload, removed);
        layer.revision = projected.len() as u64 + 1;
        layer.parent = projected.last().map(AuthorLayer::checkpoint);
        layer.hash = layer.computed_hash()?;
        layer.payload.project(manifest)?;
        mappings.push(CheckpointMapping {
            author_id: layer.author_id.clone(),
            source,
            target: layer.checkpoint(),
        });
        projected.push(layer);
    }
    Ok((projected, mappings))
}

/// Payload-free ancestry survives cleanup of old generation directories. Each
/// archived descriptor is hash-bound by the exact prior entry; its source entry
/// in turn binds the next link. A mapping never loses its source generation.
pub(super) fn preserve_provenance(
    repo: &CollaborationRepository,
    destination: &Path,
    source_entry: &[u8],
    cancel: &AtomicBool,
) -> Result<()> {
    if repo.manifest.format_version != crate::collaboration::consts::GENERATION_COLLABORATION_FORMAT
    {
        return Ok(());
    }
    let mut entry_bytes = source_entry.to_vec();
    let mut current_dir = repo.metadata_root.clone();
    let mut budget = MAX_TOTAL_LAYER_BYTES;
    let mut seen = HashSet::new();
    for _ in 0..=MAX_MEDIA {
        let entry = super::generation::GenerationEntry::parse(&entry_bytes)?;
        let entry_hash = hash(&entry_bytes);
        require(
            seen.insert(entry_hash.clone()),
            "Cyclic generation provenance",
        )?;
        let descriptor_bytes = atomic::read(
            &current_dir.join("generation.json"),
            MAX_LAYER_BYTES.min(budget),
        )?;
        budget -= descriptor_bytes.len();
        require(
            hash(&descriptor_bytes) == entry.generation_hash,
            "Provenance generation digest mismatch",
        )?;
        let descriptor = super::generation::GenerationDescriptor::parse(&descriptor_bytes)?;
        require(
            descriptor.project_id == entry.project_id
                && descriptor.generation_id == entry.metadata_generation,
            "Provenance generation identity mismatch",
        )?;
        let prior = atomic::read(
            &current_dir.join("source-entry.json"),
            MAX_LAYER_BYTES.min(budget),
        )?;
        budget -= prior.len();
        require(
            hash(&prior) == descriptor.source_entry_hash,
            "Provenance source entry digest mismatch",
        )?;
        let target = destination.join("provenance").join(&entry_hash);
        fs::create_dir(&target).map_err(atomic::io)?;
        atomic::publish_new(
            &target.join("generation.json"),
            &descriptor_bytes,
            None,
            Some(cancel),
        )?;
        atomic::publish_new(
            &target.join("source-entry.json"),
            &prior,
            None,
            Some(cancel),
        )?;
        if descriptor.source_generation.is_none() {
            return Ok(());
        }
        let parent = super::generation::GenerationEntry::parse(&prior)?;
        require(
            Some(&parent.metadata_generation) == descriptor.source_generation.as_ref(),
            "Provenance source generation mismatch",
        )?;
        current_dir = repo
            .metadata_root
            .join("provenance")
            .join(&descriptor.source_entry_hash);
        entry_bytes = prior;
    }
    limit(false)
}
