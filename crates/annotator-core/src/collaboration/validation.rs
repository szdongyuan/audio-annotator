use super::model::*;
use crate::{
    error::{AppError, ErrorCode, Result},
    model::{validation::MAX_SAFE_INTEGER, ProjectDocument},
};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
pub const MAX_AUTHORS: usize = 128;
pub const MAX_LAYER_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TOTAL_LAYER_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_AUTHOR_BYTES: usize = 8192;
pub const MAX_MEDIA: usize = 10_000;
pub const MAX_CATEGORIES: usize = 4096;
pub const MAX_ANNOTATIONS: usize = 100_000;
pub(crate) fn require(valid: bool, message: &str) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(AppError::invalid(message))
    }
}
pub(crate) fn limit(valid: bool) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::ResourceLimit,
            "Collaboration resource limit exceeded",
        ))
    }
}
pub(crate) fn uuid(value: &str) -> Result<()> {
    require(
        uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value),
        "Invalid canonical UUID",
    )
}
pub(crate) fn digest(value: &str) -> Result<()> {
    require(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid SHA-256",
    )
}
pub(crate) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn decode<T: DeserializeOwned>(bytes: &[u8], max: usize, kind: &str) -> Result<T> {
    limit(bytes.len() <= max)?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Header {
        kind: String,
        format_version: u32,
    }
    let header: Header = serde_json::from_slice(bytes)
        .map_err(|_| AppError::invalid("Invalid collaboration header"))?;
    if header.format_version
        != if matches!(kind, LAYER_KIND | "audio-annotator-private-workspace") {
            2
        } else {
            1
        }
    {
        return Err(AppError::new(
            ErrorCode::UnsupportedVersion,
            "Unsupported collaboration format version",
        ));
    }
    require(header.kind == kind, "Invalid collaboration kind")?;
    // Decode from the original stream so duplicate fields are errors, not collapsed by Value.
    serde_json::from_slice(bytes).map_err(|_| AppError::invalid("Invalid collaboration structure"))
}
pub fn parse_manifest(bytes: &[u8]) -> Result<CollaborationManifest> {
    limit(bytes.len() <= MAX_LAYER_BYTES)?;
    let manifest: CollaborationManifest =
        serde_json::from_slice(bytes).map_err(|_| AppError::invalid("Invalid manifest"))?;
    manifest.validate()?;
    Ok(manifest)
}
impl CollaborationManifest {
    pub fn validate(&self) -> Result<()> {
        require(self.kind == MANIFEST_KIND, "Invalid manifest kind")?;
        if !super::consts::supported_catalog_format(self.format_version) {
            return Err(AppError::new(
                ErrorCode::UnsupportedVersion,
                "Unsupported collaboration version; use the prior app or exchange/export workflow",
            ));
        }
        limit(self.media.len() <= MAX_MEDIA)?;
        let mut paths = HashSet::new();
        for media in &self.media {
            uuid(&media.id)?;
            let prefix = format!("media/{}.", media.id);
            let extension = media
                .source_ref
                .strip_prefix(&prefix)
                .ok_or_else(|| AppError::invalid("Media path must use its canonical UUID"))?;
            require(
                matches!(extension, "wav" | "flac" | "mp3"),
                "Unsupported or unsafe media path",
            )?;
            require(paths.insert(&media.source_ref), "Duplicate media path")?;
        }
        self.base_document()?.validate()
    }
    pub fn base_document(&self) -> Result<ProjectDocument> {
        let mut doc = ProjectDocument::create(self.name.clone())?;
        doc.project_id = self.project_id.clone();
        doc.created_at = self.created_at.clone();
        doc.updated_at = self.created_at.clone();
        doc.media = self.media.iter().map(PublicMedia::descriptor).collect();
        for media in &doc.media {
            doc.analysis.insert(media.id.clone(), Default::default());
            doc.playback_mix
                .insert(media.id.clone(), Default::default());
        }
        Ok(doc)
    }
}
impl LayerPayload {
    /// Whitelist projection: local paths, edits, analysis, mix and views cannot enter this DTO.
    pub fn from_document(doc: &ProjectDocument) -> Result<Self> {
        doc.validate()?;
        Ok(Self {
            categories: doc.categories.clone(),
            annotations: doc.annotations.clone(),
            media_labels: doc
                .media
                .iter()
                .map(|m| MediaLabels {
                    media_id: m.id.clone(),
                    note: m.note.clone(),
                    channel_notes: m.channel_notes.clone(),
                    category_ids: m.category_ids.clone(),
                    channel_category_ids: m.channel_category_ids.clone(),
                })
                .collect(),
        })
    }
    pub fn project(&self, manifest: &CollaborationManifest) -> Result<ProjectDocument> {
        manifest.validate()?;
        limit(
            self.categories.len() <= MAX_CATEGORIES
                && self.annotations.len() <= MAX_ANNOTATIONS
                && self.media_labels.len() <= MAX_MEDIA,
        )?;
        let mut doc = manifest.base_document()?;
        doc.categories = self.categories.clone();
        doc.annotations = self.annotations.clone();
        let mut ids = HashSet::new();
        let positions: HashMap<_, _> = doc
            .media
            .iter()
            .enumerate()
            .map(|(i, m)| (m.id.clone(), i))
            .collect();
        for labels in &self.media_labels {
            require(ids.insert(&labels.media_id), "Duplicate media labels")?;
            let index = positions
                .get(&labels.media_id)
                .ok_or_else(|| AppError::invalid("Labels reference unknown media"))?;
            let media = &mut doc.media[*index];
            media.note = labels.note.clone();
            media.channel_notes = labels.channel_notes.clone();
            media.category_ids = labels.category_ids.clone();
            media.channel_category_ids = labels.channel_category_ids.clone();
        }
        doc.validate()?;
        Ok(doc)
    }
    pub fn hash(&self) -> Result<String> {
        let bytes =
            serde_json::to_vec(self).map_err(|_| AppError::invalid("Cannot encode payload"))?;
        limit(bytes.len() <= MAX_LAYER_BYTES)?;
        Ok(hash(&bytes))
    }
}
impl AuthorLayer {
    pub fn computed_hash(&self) -> Result<String> {
        // Bind all semantic authority fields; the hash itself is excluded.
        let bytes = serde_json::to_vec(&(
            self.kind.as_str(),
            self.format_version,
            self.project_id.as_str(),
            self.author_id.as_str(),
            self.revision,
            &self.parent,
            &self.payload,
        ))
        .map_err(|_| AppError::invalid("Cannot encode layer"))?;
        limit(bytes.len() <= MAX_LAYER_BYTES)?;
        Ok(hash(&bytes))
    }
    pub fn parse(bytes: &[u8], manifest: &CollaborationManifest, author: &str) -> Result<Self> {
        let layer: Self = decode(bytes, MAX_LAYER_BYTES, LAYER_KIND)?;
        uuid(&layer.author_id)?;
        require(
            layer.project_id == manifest.project_id && layer.author_id == author,
            "Layer identity mismatch",
        )?;
        require(
            (1..=MAX_SAFE_INTEGER).contains(&layer.revision),
            "Invalid layer revision",
        )?;
        match &layer.parent {
            None => require(layer.revision == 1, "Missing parent checkpoint")?,
            Some(parent) => {
                require(
                    parent.revision > 0
                        && parent.revision < MAX_SAFE_INTEGER
                        && parent.revision + 1 == layer.revision,
                    "Invalid parent revision",
                )?;
                digest(&parent.hash)?;
            }
        }
        layer.payload.project(manifest)?;
        digest(&layer.hash)?;
        require(
            layer.computed_hash()? == layer.hash,
            "Layer digest mismatch",
        )?;
        Ok(layer)
    }
}
