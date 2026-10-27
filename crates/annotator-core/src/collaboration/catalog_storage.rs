//! Bounded immutable catalog reads against one captured organization head.
use super::{atomic, validation::*, *};
use crate::error::{AppError, ErrorCode, Result};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
pub(super) const MAX_RECORD_BYTES: usize = 65536;
pub(super) const MAX_CATALOG_ENTRIES: usize = 100_000;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DefaultManifest {
    pub(super) kind: String,
    pub(super) format_version: u32,
    pub(super) project_id: String,
    pub(super) name: String,
    pub(super) created_at: String,
    pub(super) catalog_version: u32,
}
impl DefaultManifest {
    pub(super) fn effective(self) -> Result<CollaborationManifest> {
        require(self.kind == MANIFEST_KIND, "Invalid default manifest kind")?;
        if self.format_version != crate::collaboration::CURRENT_COLLABORATION_FORMAT
            || self.catalog_version != 2
        {
            return Err(AppError::new(
                ErrorCode::UnsupportedVersion,
                "Unsupported default catalog format",
            ));
        }
        let manifest = CollaborationManifest {
            kind: self.kind,
            format_version: CURRENT_COLLABORATION_FORMAT,
            project_id: self.project_id,
            name: self.name,
            created_at: self.created_at,
            media: vec![],
        };
        manifest.validate()?;
        Ok(manifest)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CatalogRecord {
    kind: String,
    format_version: u32,
    project_id: String,
    media: PublicMedia,
}
impl CatalogRecord {
    pub(super) fn new(project_id: &str, media: PublicMedia) -> Self {
        Self {
            kind: "audio-annotator-media-record".into(),
            format_version: 1,
            project_id: project_id.into(),
            media,
        }
    }
    fn parse(bytes: &[u8], manifest: &CollaborationManifest) -> Result<Self> {
        let record: Self = decode(bytes, MAX_RECORD_BYTES, "audio-annotator-media-record")?;
        require(
            record.project_id == manifest.project_id,
            "Catalog project mismatch",
        )?;
        let mut check = manifest.clone();
        check.media = vec![record.media.clone()];
        check.validate()?;
        Ok(record)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogRevision {
    pub media_count: usize,
    pub byte_length: usize,
    pub digest: String,
}
/// Native result. Deferred layers retain their complete verified payload and original hash.
pub struct CatalogSnapshot {
    pub snapshot: CollaborationSnapshot,
    pub catalog_update_available: bool,
    pub revision: Option<CatalogRevision>,
    pub deferred_authors: Vec<AuthorLayer>,
}

pub(super) struct LoadedCatalog {
    pub manifest: CollaborationManifest,
    pub revision: Option<CatalogRevision>,
    pub record_hashes: Vec<(String, String)>,
    pub organization: organization::Organization,
}
pub(super) fn record_digest(records: &[(String, String)]) -> Result<String> {
    Ok(hash(
        &serde_json::to_vec(records).map_err(|_| AppError::invalid("Cannot hash catalog"))?,
    ))
}
#[cfg(test)]
std::thread_local! {
    pub(super) static CATALOG_LOADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn load(
    root: &Path,
    bytes: &[u8],
    after_entry: &mut impl FnMut(&Path) -> Result<()>,
) -> Result<LoadedCatalog> {
    #[cfg(test)]
    CATALOG_LOADS.with(|count| count.set(count.get() + 1));
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Header {
        format_version: u32,
    }
    limit(bytes.len() <= MAX_LAYER_BYTES)?;
    let header: Header =
        serde_json::from_slice(bytes).map_err(|_| AppError::invalid("Invalid manifest header"))?;
    if header.format_version != crate::collaboration::CURRENT_COLLABORATION_FORMAT {
        return Err(AppError::new(
            ErrorCode::UnsupportedVersion,
            "Unsupported collaboration version; use the prior app or exchange/export workflow",
        ));
    }
    let fixed: DefaultManifest = serde_json::from_slice(bytes)
        .map_err(|_| AppError::invalid("Invalid default manifest structure"))?;
    let mut manifest = fixed.effective()?;
    let organization = organization::read(root, &manifest.project_id)?;
    let referenced = organization
        .media
        .iter()
        .map(|m| m.media_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let dir = root.join("catalog");
    atomic::safe_existing(&dir)?;
    let mut entries = Vec::new();
    for (index, entry) in fs::read_dir(&dir).map_err(atomic::io)?.enumerate() {
        limit(index < MAX_CATALOG_ENTRIES)?;
        let entry = entry.map_err(atomic::io)?;
        after_entry(&entry.path())?;
        entries.push(entry);
    }
    // SMB metadata/read latency dominates large catalogs. Keep full validation, but
    // overlap independent records with a fixed worker bound against the captured head.
    let byte_length = std::sync::atomic::AtomicUsize::new(bytes.len());
    let read_entry = |entry: &fs::DirEntry| -> Result<Option<(PublicMedia, String)>> {
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| AppError::invalid("Invalid catalog filename"))?;
        if name.starts_with('.') && name.ends_with(".tmp") {
            atomic::safe_existing(&dir)?;
            match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => require(
                    metadata.is_file() && !atomic::is_link(&metadata),
                    "Symlink/reparse paths are forbidden",
                )?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(atomic::io(error)),
            }
            return Ok(None);
        }
        atomic::safe_existing(&entry.path())?;
        require(
            entry.file_type().map_err(atomic::io)?.is_file(),
            "Expected regular catalog entry",
        )?;
        if name == ".commit.lock" {
            return Ok(None);
        }
        let id = name
            .strip_suffix(".json")
            .ok_or_else(|| AppError::invalid("Unknown catalog entry"))?;
        uuid(id)?;
        if !referenced.contains(id) {
            return Ok(None);
        }
        let bytes = atomic::read(&entry.path(), MAX_RECORD_BYTES)?;
        let prior = byte_length.fetch_add(bytes.len(), std::sync::atomic::Ordering::Relaxed);
        limit(prior + bytes.len() <= MAX_LAYER_BYTES)?;
        let record = CatalogRecord::parse(&bytes, &manifest)?;
        require(record.media.id == id, "Catalog filename identity mismatch")?;
        let path = root.join(&record.media.source_ref);
        atomic::safe_existing(&path)?;
        let metadata = fs::metadata(&path).map_err(atomic::io)?;
        require(
            metadata.is_file() && metadata.len() == record.media.byte_length,
            "Missing or changed catalog media",
        )?;
        Ok(Some((record.media, hash(&bytes))))
    };
    let records = std::thread::scope(|scope| -> Result<Vec<_>> {
        let chunk_size = entries.len().div_ceil(8).max(1);
        let handles: Vec<_> = entries
            .chunks(chunk_size)
            .map(|chunk| {
                let read_entry = &read_entry;
                scope.spawn(move || -> Result<Vec<_>> {
                    let mut result = Vec::new();
                    for entry in chunk {
                        if let Some(record) = read_entry(entry)? {
                            result.push(record);
                        }
                    }
                    Ok(result)
                })
            })
            .collect();
        let mut records = Vec::new();
        for handle in handles {
            records.extend(
                handle
                    .join()
                    .map_err(|_| AppError::invalid("Catalog reader failed"))??,
            );
        }
        Ok(records)
    })?;
    let byte_length = byte_length.into_inner();
    let mut records = records;
    require(
        records.len() == referenced.len(),
        "Missing committed catalog record",
    )?;
    records.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    let record_hashes = records
        .iter()
        .map(|r| (r.0.id.clone(), r.1.clone()))
        .collect::<Vec<_>>();
    let digest = record_digest(&record_hashes)?;
    manifest.media = records.into_iter().map(|r| r.0).collect();
    manifest.validate()?;
    let revision = CatalogRevision {
        media_count: manifest.media.len(),
        byte_length,
        digest,
    };
    Ok(LoadedCatalog {
        manifest,
        revision: Some(revision),
        record_hashes,
        organization,
    })
}
