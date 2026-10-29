//! One entry selects one metadata root. Root author identities and leases never move.
use super::{
    journal::{PurgeReceipt, RetiredMedia},
    projection::CheckpointMapping,
};
use crate::{
    collaboration::{atomic, consts::*, validation::*, CollaborationManifest, MANIFEST_KIND},
    error::{AppError, ErrorCode, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationEntry {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub name: String,
    pub created_at: String,
    pub catalog_version: u32,
    pub metadata_generation: String,
    pub generation_hash: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationDescriptor {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub generation_id: String,
    pub source_entry_hash: String,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub source_generation: Option<String>,
    pub checkpoint_map: Vec<CheckpointMapping>,
    pub receipts: Vec<PurgeReceipt>,
    pub retired: Vec<RetiredMedia>,
}
impl GenerationDescriptor {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let value: Self = decode(bytes, MAX_LAYER_BYTES, GENERATION_KIND)?;
        uuid(&value.project_id)?;
        uuid(&value.generation_id)?;
        digest(&value.source_entry_hash)?;
        if let Some(source) = &value.source_generation {
            uuid(source)?;
            require(
                source != &value.generation_id,
                "Generation cannot source itself",
            )?;
        }
        limit(
            value.checkpoint_map.len() <= MAX_AUTHORS * 16
                && value.receipts.len() <= MAX_MEDIA
                && value.retired.len() <= MAX_MEDIA,
        )?;
        let mut mapped = HashSet::new();
        let mut targets = HashSet::new();
        for mapping in &value.checkpoint_map {
            mapping.validate()?;
            require(
                mapped.insert((&mapping.author_id, mapping.source.revision)),
                "Duplicate source checkpoint",
            )?;
            require(
                targets.insert((&mapping.author_id, mapping.target.revision)),
                "Duplicate target checkpoint",
            )?;
        }
        let mut operations = HashSet::new();
        let mut preparations = HashSet::new();
        let mut removed = std::collections::HashMap::new();
        for receipt in &value.receipts {
            receipt.validate()?;
            require(
                operations.insert(&receipt.operation_id),
                "Duplicate purge receipt",
            )?;
            if let Some(attempt) = &receipt.legacy_preparation_id {
                require(
                    preparations.insert(attempt),
                    "Legacy preparation belongs to multiple purge operations",
                )?;
            }
            for id in &receipt.removed_ids {
                require(
                    removed.insert(id, &receipt.operation_id).is_none(),
                    "Media retired by multiple operations",
                )?;
            }
        }
        let mut retired = HashSet::new();
        for item in &value.retired {
            uuid(&item.media_id)?;
            uuid(&item.operation_id)?;
            require(retired.insert(&item.media_id), "Duplicate retired media")?;
            require(
                removed.get(&item.media_id) == Some(&&item.operation_id),
                "Retired media has no receipt",
            )?;
        }
        require(
            removed.len() == retired.len(),
            "Receipt has no retired identity",
        )?;
        Ok(value)
    }
}
impl GenerationEntry {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        limit(bytes.len() <= MAX_LAYER_BYTES)?;
        let entry: Self = serde_json::from_slice(bytes)
            .map_err(|_| AppError::invalid("Invalid generation entry"))?;
        require(entry.kind == MANIFEST_KIND, "Invalid manifest kind")?;
        if entry.format_version != GENERATION_COLLABORATION_FORMAT || entry.catalog_version != 2 {
            return Err(AppError::new(
                ErrorCode::UnsupportedVersion,
                "Unsupported generation entry",
            ));
        }
        uuid(&entry.metadata_generation)?;
        digest(&entry.generation_hash)?;
        entry.effective().validate()?;
        Ok(entry)
    }
    pub(crate) fn effective(&self) -> CollaborationManifest {
        CollaborationManifest {
            kind: self.kind.clone(),
            format_version: self.format_version,
            project_id: self.project_id.clone(),
            name: self.name.clone(),
            created_at: self.created_at.clone(),
            media: vec![],
        }
    }
    pub(crate) fn resolve(&self, root: &Path) -> Result<PathBuf> {
        uuid(&self.metadata_generation)?;
        let path = root.join("state").join(&self.metadata_generation);
        atomic::safe_existing(&path)?;
        let bytes = atomic::read(&path.join("generation.json"), MAX_LAYER_BYTES)?;
        require(
            hash(&bytes) == self.generation_hash,
            "Generation digest mismatch",
        )?;
        let descriptor = GenerationDescriptor::parse(&bytes)?;
        require(
            descriptor.project_id == self.project_id
                && descriptor.generation_id == self.metadata_generation,
            "Generation identity mismatch",
        )?;
        let source_bytes = atomic::read(&path.join("source-entry.json"), MAX_LAYER_BYTES)?;
        require(
            hash(&source_bytes) == descriptor.source_entry_hash,
            "Source entry digest mismatch",
        )?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Header {
            format_version: u32,
        }
        let source_header: Header = serde_json::from_slice(&source_bytes)
            .map_err(|_| AppError::invalid("Invalid source entry header"))?;
        let (source, source_generation) = match source_header.format_version {
            crate::collaboration::CURRENT_COLLABORATION_FORMAT => {
                let source: crate::collaboration::catalog_storage::DefaultManifest =
                    serde_json::from_slice(&source_bytes)
                        .map_err(|_| AppError::invalid("Invalid source entry structure"))?;
                (source.effective()?, None)
            }
            GENERATION_COLLABORATION_FORMAT => {
                let source = Self::parse(&source_bytes)?;
                (source.effective(), Some(source.metadata_generation))
            }
            _ => {
                return Err(AppError::new(
                    ErrorCode::UnsupportedVersion,
                    "Unsupported source entry version",
                ))
            }
        };
        require(
            source.project_id == self.project_id
                && source.name == self.name
                && source.created_at == self.created_at
                && source_generation == descriptor.source_generation,
            "Source entry identity mismatch",
        )?;
        let retired: HashSet<_> = descriptor
            .retired
            .iter()
            .map(|r| r.media_id.as_str())
            .collect();
        let organization = crate::collaboration::organization::read(&path, &self.project_id)?;
        require(
            organization
                .media
                .iter()
                .all(|m| !retired.contains(m.media_id.as_str())),
            "Retired media cannot reenter generation membership",
        )?;
        Ok(path)
    }
}
