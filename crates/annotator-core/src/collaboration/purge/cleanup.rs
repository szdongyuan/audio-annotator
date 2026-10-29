//! Receipt-bound exact file cleanup. Reads never run recovery or mutate shared files.
use super::{
    generation::GenerationDescriptor,
    journal::{JournalStatus, LegacyJournal, LegacyStatus, PurgeJournal, PurgeReceipt},
};
use crate::{
    collaboration::{atomic, validation::*, AuthorSession, CollaborationRepository},
    error::{AppError, Result},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanupKind {
    Audio,
    Catalog,
    History,
    Metadata,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Target {
    cleanup_id: String,
    path: String,
    media_id: Option<String>,
    display_name: String,
    kind: CleanupKind,
    identity: String,
    digest: String,
    bytes: u64,
    authorized: bool,
    staged_path: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupDependency {
    operation_id: String,
    manifest_hash: String,
    cleanup_ids: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyObserver {
    cleanup_id: String,
    author_id: String,
    legacy_preparation_id: String,
    source_entry_hash: String,
    lease_identity: String,
    fence_revision: u64,
    fence_hash: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    project_id: String,
    operation_id: String,
    source_entry_hash: String,
    generation_id: String,
    targets: Vec<Target>,
    // Older receipt-bound manifests remain readable and retain their exact hash.
    #[serde(default)]
    dependencies: Vec<CleanupDependency>,
    #[serde(default)]
    legacy_observers: Vec<LegacyObserver>,
}
enum WorkItem {
    File {
        receipt: Arc<PurgeReceipt>,
        target: Target,
    },
    Observer {
        receipt: Arc<PurgeReceipt>,
        scope: LegacyObserver,
    },
}
impl WorkItem {
    fn receipt(&self) -> &PurgeReceipt {
        match self {
            Self::File { receipt, .. } | Self::Observer { receipt, .. } => receipt,
        }
    }
    fn id(&self) -> &str {
        match self {
            Self::File { target, .. } => &target.cleanup_id,
            Self::Observer { scope, .. } => &scope.cleanup_id,
        }
    }
    fn kind(&self) -> CleanupKind {
        match self {
            Self::File { target, .. } => target.kind,
            Self::Observer { .. } => CleanupKind::History,
        }
    }
    fn into_page(self, error: Option<AppError>) -> CleanupItem {
        match self {
            Self::File { receipt, target } => CleanupItem {
                cleanup_id: target.cleanup_id,
                source_operation_id: receipt.operation_id.clone(),
                media_id: target.media_id,
                display_name: target.display_name,
                kind: target.kind,
                error,
            },
            Self::Observer { receipt, scope } => CleanupItem {
                cleanup_id: scope.cleanup_id,
                source_operation_id: receipt.operation_id.clone(),
                media_id: None,
                display_name: format!("Legacy publication staging ({})", scope.author_id),
                kind: CleanupKind::History,
                error,
            },
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Progress {
    attempting: bool,
    complete: bool,
    deleted_audio_bytes: u64,
    error: Option<AppError>,
}
#[derive(Debug, Clone)]
pub struct CleanupSummary {
    pub operation_id: String,
    pub complete: bool,
    pub deleted_audio_bytes: u64,
    pub pending_count: usize,
    pub failed_count: usize,
}
#[derive(Debug, Clone)]
pub struct CleanupItem {
    pub cleanup_id: String,
    pub source_operation_id: String,
    pub media_id: Option<String>,
    pub display_name: String,
    pub kind: CleanupKind,
    pub error: Option<AppError>,
}
#[derive(Debug)]
pub struct CleanupPage {
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub items: Vec<CleanupItem>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupBoundary {
    BeforeUnlink,
    AfterUnlinkBeforeProgress,
    AfterUnlink,
    AfterProgress,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaintenanceStatus {
    Accepted,
    Preparing,
    RollbackPending,
    RolledBack,
    LegacyCommitted,
    Superseded,
    CommittedPendingCleanup,
    Complete,
}
#[derive(Debug)]
pub struct MaintenanceOperation {
    pub status: MaintenanceStatus,
    pub operation_id: String,
    pub committed: bool,
    pub cleanup: Option<CleanupSummary>,
    pub legacy_attempt: bool,
}
fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| AppError::invalid("Cannot encode cleanup state"))?;
    limit(bytes.len() <= MAX_TOTAL_LAYER_BYTES)?;
    Ok(bytes)
}
fn operation_dir(repo: &CollaborationRepository, operation: &str) -> Result<PathBuf> {
    uuid(operation)?;
    Ok(repo.root.join("maintenance").join(operation))
}
fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(atomic::io(e)),
    }
}
fn hash_file(file: &mut File) -> Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(atomic::io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
/// Only native protocol names are representable; never accept a user filesystem path.
fn validate_path(target: &Target) -> Result<()> {
    let p = Path::new(&target.path);
    require(
        p.components().all(|c| matches!(c, Component::Normal(_)))
            && !target.path.contains('\\')
            && !target.path.contains(':'),
        "Invalid cleanup path",
    )?;
    let parts: Vec<_> = target.path.split('/').collect();
    let numeric = |s: &str| {
        s.strip_suffix(".json").is_some_and(|v| {
            v.len() == 20
                && v.bytes().all(|b| b.is_ascii_digit())
                && v.parse::<u64>().is_ok_and(|v| v > 0)
        })
    };
    let temporary = |s: &str| {
        s.strip_prefix('.')
            .and_then(|v| v.strip_suffix(".tmp"))
            .is_some_and(|id| uuid(id).is_ok())
    };
    let catalog = |s: &str| s.strip_suffix(".json").is_some_and(|v| uuid(v).is_ok());
    let metadata = |s: &str| {
        matches!(
            s,
            "organization.json" | "recycle.json" | "source-entry.json" | "generation.json"
        )
    };
    let valid = match parts.as_slice() {
        ["media", name] if target.kind == CleanupKind::Audio => {
            target.media_id.as_ref().is_some_and(|id| {
                name.strip_prefix(&format!("{id}.")).is_some_and(|ext| {
                    !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric())
                })
            })
        }
        ["catalog", name] => target.kind == CleanupKind::Catalog && catalog(name),
        ["annotations", author, name] => {
            target.kind == CleanupKind::History && uuid(author).is_ok() && numeric(name)
        }
        [name] => {
            target.kind == CleanupKind::Metadata
                && matches!(*name, "organization.json" | "recycle.json")
        }
        ["state", generation, "catalog", name] => {
            uuid(generation).is_ok()
                && (catalog(name) || temporary(name))
                && target.kind == CleanupKind::Catalog
        }
        ["state", generation, "annotations", author, name] => {
            uuid(generation).is_ok()
                && uuid(author).is_ok()
                && (numeric(name) || temporary(name))
                && target.kind == CleanupKind::History
        }
        ["state", generation, name] => {
            uuid(generation).is_ok()
                && (metadata(name) || temporary(name))
                && target.kind == CleanupKind::Metadata
        }
        ["state", generation, "provenance", digest_value, name] => {
            uuid(generation).is_ok()
                && digest(digest_value).is_ok()
                && matches!(*name, "source-entry.json" | "generation.json")
                && target.kind == CleanupKind::Metadata
        }
        ["maintenance", attempt, "rollback", author, name] => {
            uuid(attempt).is_ok()
                && uuid(author).is_ok()
                && (numeric(name) || temporary(name))
                && target.kind == CleanupKind::History
        }
        _ => false,
    };
    require(valid, "Cleanup target is outside the owned protocol")
}
fn capture_target(
    repo: &CollaborationRepository,
    targets: &mut Vec<Target>,
    path: &Path,
    kind: CleanupKind,
    media_id: Option<String>,
    display_name: String,
    expected: Option<(&str, u64)>,
) -> Result<()> {
    limit(targets.len() < 100_000)?;
    atomic::safe_existing(path)?;
    let mut file = File::open(path).map_err(atomic::io)?;
    let metadata = file.metadata().map_err(atomic::io)?;
    require(
        metadata.is_file() && !atomic::is_link(&metadata),
        "Invalid cleanup source object",
    )?;
    limit(kind == CleanupKind::Audio || metadata.len() <= MAX_LAYER_BYTES as u64)?;
    let identity = atomic::file_identity(&file)?;
    let digest_value = hash_file(&mut file)?;
    atomic::verify_lock_path(path, &file)?;
    if let Some((digest, length)) = expected {
        require(
            digest_value == digest && metadata.len() == length,
            "Cleanup source digest mismatch",
        )?;
    }
    let relative = path
        .strip_prefix(&repo.root)
        .map_err(|_| AppError::invalid("Cleanup path escapes project"))?
        .to_str()
        .ok_or_else(|| AppError::invalid("Invalid cleanup filename"))?
        .replace('\\', "/");
    let target = Target {
        cleanup_id: uuid::Uuid::new_v4().to_string(),
        path: relative,
        media_id,
        display_name,
        kind,
        identity,
        digest: digest_value,
        bytes: metadata.len(),
        authorized: true,
        staged_path: None,
    };
    validate_path(&target)?;
    targets.push(target);
    Ok(())
}
/// Called under the transaction's catalog/registration guards, before entry commit.
/// Every manifest revision gets its own immutable filename; failed attempts remain inert.
pub(super) fn capture(
    repo: &CollaborationRepository,
    operation: &str,
    removed: &[String],
    generation: &str,
    legacy_preparation: Option<&str>,
) -> Result<String> {
    let mut targets = vec![];
    for id in removed {
        let media = repo
            .manifest
            .media
            .iter()
            .find(|m| &m.id == id)
            .ok_or_else(|| AppError::invalid("Missing cleanup media authority"))?;
        capture_target(
            repo,
            &mut targets,
            &repo.root.join(&media.source_ref),
            CleanupKind::Audio,
            Some(id.clone()),
            media.display_name.clone(),
            Some((&media.sha256, media.byte_length)),
        )?;
    }
    // All bodies of the source metadata root become obsolete, including retained-media
    // catalogs and history. Their projected equivalents already live in the candidate.
    for name in ["organization.json", "recycle.json"] {
        let path = repo.metadata_root.join(name);
        if exists(&path)? {
            capture_target(
                repo,
                &mut targets,
                &path,
                CleanupKind::Metadata,
                None,
                name.into(),
                None,
            )?;
        }
    }
    for media in &repo.manifest.media {
        let path = repo
            .metadata_root
            .join("catalog")
            .join(format!("{}.json", media.id));
        capture_target(
            repo,
            &mut targets,
            &path,
            CleanupKind::Catalog,
            Some(media.id.clone()),
            media.display_name.clone(),
            None,
        )?;
    }
    for author in repo.authors()? {
        let author_id = &author.identity.author_id;
        let dir = repo.metadata_root.join("annotations").join(author_id);
        if !exists(&dir)? {
            continue;
        }
        atomic::safe_existing(&dir)?;
        for (index, entry) in fs::read_dir(&dir).map_err(atomic::io)?.enumerate() {
            limit(index < 256)?;
            let path = entry.map_err(atomic::io)?.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| AppError::invalid("Invalid history filename"))?;
            if name == ".writer.lock"
                || (repo.metadata_root == repo.root
                    && name.starts_with('.')
                    && name.ends_with(".tmp"))
            {
                // Old publishers can leave unowned payload staging. Receipt-bound
                // observers expose it without pretending parsing grants deletion.
                continue;
            }
            let bytes = atomic::read(&path, MAX_LAYER_BYTES)?;
            // Payload-free collision fences are permanent and never cleanup targets.
            let header: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::invalid("Invalid obsolete history"))?;
            if header["kind"] == crate::collaboration::consts::LEGACY_FENCE_KIND {
                continue;
            }
            crate::collaboration::AuthorLayer::parse(&bytes, &repo.manifest, author_id)?;
            capture_target(
                repo,
                &mut targets,
                &path,
                CleanupKind::History,
                None,
                format!("{} history", author.identity.display_name),
                None,
            )?;
        }
    }
    if repo.metadata_root != repo.root {
        for name in ["generation.json", "source-entry.json"] {
            capture_target(
                repo,
                &mut targets,
                &repo.metadata_root.join(name),
                CleanupKind::Metadata,
                None,
                name.into(),
                None,
            )?;
        }
    }
    // Include every earlier same-source legacy attempt before committing. Its journal
    // remains as payload-free ownership proof; backups must never be restored later.
    let maintenance = repo.root.join("maintenance");
    for (index, entry) in fs::read_dir(&maintenance).map_err(atomic::io)?.enumerate() {
        limit(index < MAX_MEDIA)?;
        let dir = entry.map_err(atomic::io)?.path();
        atomic::safe_existing(&dir)?;
        capture_orphans(repo, &dir, generation, &mut targets)?;
        let path = dir.join("legacy.json");
        if !exists(&path)? {
            continue;
        }
        let journal = LegacyJournal::parse(&atomic::read(&path, MAX_LAYER_BYTES)?)?;
        require(
            journal.project_id == repo.manifest.project_id,
            "Foreign legacy cleanup owner",
        )?;
        if journal.source_entry_hash != repo.manifest_hash {
            continue;
        }
        require(
            dir.file_name().and_then(|n| n.to_str()) == Some(journal.operation_id.as_str()),
            "Legacy cleanup attempt mismatch",
        )?;
        let recorded = capture_legacy_publications(repo, &dir, &journal, &mut targets)?;
        for author in journal.authors {
            for backup in author.backups {
                let relative = format!(
                    "maintenance/{}/rollback/{}/{:020}.json",
                    journal.operation_id, author.author_id, backup.revision
                );
                if recorded.contains(&relative) {
                    continue;
                }
                let path = repo.root.join(relative);
                if !exists(&path)? {
                    require(
                        author.retired || !author.backups_ready,
                        "Missing legacy cleanup backup",
                    )?;
                    continue;
                }
                capture_target(
                    repo,
                    &mut targets,
                    &path,
                    CleanupKind::History,
                    None,
                    "Upgrade rollback history".into(),
                    Some((&backup.byte_hash, backup.byte_length as u64)),
                )?;
            }
        }
    }
    let legacy_observers = if let Some(attempt) = legacy_preparation {
        observer_scopes(repo, operation, attempt)?
    } else {
        vec![]
    };
    let dependencies = capture_dependencies(repo, targets.len() + legacy_observers.len())?;
    let manifest = Manifest {
        dependencies,
        legacy_observers,
        project_id: repo.manifest.project_id.clone(),
        operation_id: operation.into(),
        source_entry_hash: repo.manifest_hash.clone(),
        generation_id: generation.into(),
        targets,
    };
    let bytes = encoded(&manifest)?;
    let digest_value = hash(&bytes);
    let dir = operation_dir(repo, operation)?;
    atomic::ensure_dir(&dir)?;
    atomic::publish_new(
        &dir.join(format!("cleanup-{digest_value}.json")),
        &bytes,
        None,
        None,
    )?;
    Ok(digest_value)
}

/// A later purge also retires media retained in earlier obsolete metadata bodies.
/// Bind only outstanding non-audio items to their original immutable authority.
fn capture_dependencies(
    repo: &CollaborationRepository,
    own_count: usize,
) -> Result<Vec<CleanupDependency>> {
    if repo.manifest.format_version != crate::collaboration::consts::GENERATION_COLLABORATION_FORMAT
    {
        return Ok(vec![]);
    }
    let generation = GenerationDescriptor::parse(&atomic::read(
        &repo.metadata_root.join("generation.json"),
        MAX_LAYER_BYTES,
    )?)?;
    let mut dependencies = vec![];
    let mut count = own_count;
    for receipt in generation.receipts {
        let (_, manifest) = load(repo, &receipt.operation_id)?;
        let mut cleanup_ids = vec![];
        for target in manifest.targets {
            if target.kind != CleanupKind::Audio
                && !progress(repo, &receipt.operation_id, &target.cleanup_id)?.complete
            {
                count += 1;
                limit(count <= 100_000)?;
                cleanup_ids.push(target.cleanup_id);
            }
        }
        for scope in manifest.legacy_observers {
            if !progress(repo, &receipt.operation_id, &scope.cleanup_id)?.complete {
                count += 1;
                limit(count <= 100_000)?;
                cleanup_ids.push(scope.cleanup_id);
            }
        }
        if !cleanup_ids.is_empty() {
            dependencies.push(CleanupDependency {
                operation_id: receipt.operation_id,
                manifest_hash: receipt.cleanup_manifest_hash,
                cleanup_ids,
            });
        }
    }
    Ok(dependencies)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CandidateOwner {
    project_id: String,
    operation_id: String,
    generation_id: String,
    source_entry_hash: String,
}
pub(super) fn register_candidate(
    repo: &CollaborationRepository,
    operation: &str,
    generation: &str,
) -> Result<()> {
    let owner = CandidateOwner {
        project_id: repo.manifest.project_id.clone(),
        operation_id: operation.into(),
        generation_id: generation.into(),
        source_entry_hash: repo.manifest_hash.clone(),
    };
    atomic::publish_new(
        &operation_dir(repo, operation)?.join(format!("candidate-{generation}.json")),
        &encoded(&owner)?,
        None,
        None,
    )
}
/// Persist empty-object identities before candidate payloads, so a later winning
/// transaction can authorize only these owned orphan files, never a directory wipe.
pub(super) fn publish_candidate(
    repo: &CollaborationRepository,
    operation: &str,
    generation: &str,
    path: &Path,
    bytes: &[u8],
    cancel: &AtomicBool,
    boundary: &mut impl FnMut(super::transaction::PurgeBoundary) -> Result<()>,
) -> Result<()> {
    let relative = path
        .strip_prefix(repo.root.join("state").join(generation))
        .map_err(|_| AppError::invalid("Candidate publication escapes generation"))?;
    let first = relative
        .components()
        .next()
        .and_then(|p| p.as_os_str().to_str());
    let kind = match first {
        Some("catalog") => CleanupKind::Catalog,
        Some("annotations") => CleanupKind::History,
        _ => CleanupKind::Metadata,
    };
    atomic::publish_new_owned(
        path,
        bytes,
        None,
        Some(cancel),
        |staged, held| {
            let relative = |p: &Path| {
                p.strip_prefix(&repo.root)
                    .ok()
                    .and_then(|p| p.to_str())
                    .map(|s| s.replace('\\', "/"))
                    .ok_or_else(|| AppError::invalid("Candidate path escapes project"))
            };
            let target = Target {
                cleanup_id: uuid::Uuid::new_v4().to_string(),
                path: relative(path)?,
                media_id: None,
                display_name: "Uncommitted generation metadata".into(),
                kind,
                identity: atomic::file_identity(held)?,
                digest: hash(bytes),
                bytes: bytes.len() as u64,
                authorized: true,
                staged_path: Some(relative(staged)?),
            };
            validate_path(&target)?;
            atomic::publish_new(
                &operation_dir(repo, operation)?.join(format!(
                    "candidate-file-{generation}-{}.json",
                    hash(target.path.as_bytes())
                )),
                &encoded(&target)?,
                None,
                None,
            )
        },
        |point| {
            boundary(if point == atomic::PublishFault::PartialWrite {
                super::transaction::PurgeBoundary::AfterCandidatePartialWrite
            } else {
                super::transaction::PurgeBoundary::AfterCandidateStaged
            })
        },
    )?;
    boundary(super::transaction::PurgeBoundary::AfterCandidatePublication)
}
fn capture_orphans(
    repo: &CollaborationRepository,
    dir: &Path,
    new_generation: &str,
    targets: &mut Vec<Target>,
) -> Result<()> {
    let mut owners = vec![];
    for (index, entry) in fs::read_dir(dir).map_err(atomic::io)?.enumerate() {
        limit(index < 200_000)?;
        let path = entry.map_err(atomic::io)?.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| AppError::invalid("Invalid candidate record name"))?;
        let Some(generation) = name
            .strip_prefix("candidate-")
            .and_then(|s| s.strip_suffix(".json"))
        else {
            continue;
        };
        if uuid(generation).is_err() || generation == new_generation {
            continue;
        }
        let owner: CandidateOwner = serde_json::from_slice(&atomic::read(&path, 65536)?)
            .map_err(|_| AppError::invalid("Invalid candidate owner"))?;
        require(
            owner.project_id == repo.manifest.project_id
                && owner.generation_id == generation
                && dir.file_name().and_then(|n| n.to_str()) == Some(owner.operation_id.as_str()),
            "Candidate ownership mismatch",
        )?;
        if owner.source_entry_hash != repo.manifest_hash {
            continue;
        }
        require(
            repo.metadata_root != repo.root.join("state").join(generation),
            "Candidate is still live",
        )?;
        owners.push(owner);
    }
    for owner in owners {
        let mut recorded = HashSet::new();
        for (index, entry) in fs::read_dir(dir).map_err(atomic::io)?.enumerate() {
            limit(index < 200_000)?;
            let path = entry.map_err(atomic::io)?.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| AppError::invalid("Invalid candidate record name"))?;
            if !name.starts_with(&format!("candidate-file-{}-", owner.generation_id)) {
                continue;
            }
            let target: Target = serde_json::from_slice(&atomic::read(&path, 65536)?)
                .map_err(|_| AppError::invalid("Invalid owned candidate file"))?;
            validate_path(&target)?;
            require(
                target
                    .path
                    .starts_with(&format!("state/{}/", owner.generation_id))
                    && target.kind != CleanupKind::Audio,
                "Candidate file escapes owner generation",
            )?;
            capture_publication(repo, target, &mut recorded, targets)?;
        }
        let root = repo.root.join("state").join(&owner.generation_id);
        if exists(&root)? {
            // A publication may have reached disk just before its identity record.
            // Enumerate only the two bounded protocol body directories, never delete
            // an unacknowledged object or hide its remaining payload behind Complete.
            for name in ["catalog", "annotations"] {
                let body = root.join(name);
                if !exists(&body)? {
                    continue;
                }
                atomic::safe_existing(&body)?;
                for (index, entry) in fs::read_dir(&body).map_err(atomic::io)?.enumerate() {
                    limit(index < 100_000)?;
                    let path = entry.map_err(atomic::io)?.path();
                    if name == "catalog" {
                        capture_unacknowledged(
                            repo,
                            &path,
                            CleanupKind::Catalog,
                            &recorded,
                            targets,
                        )?;
                    } else {
                        atomic::safe_existing(&path)?;
                        uuid(path.file_name().and_then(|s| s.to_str()).ok_or_else(|| {
                            AppError::invalid("Invalid candidate author directory")
                        })?)?;
                        for (index, entry) in fs::read_dir(path).map_err(atomic::io)?.enumerate() {
                            limit(index < 256)?;
                            capture_unacknowledged(
                                repo,
                                &entry.map_err(atomic::io)?.path(),
                                CleanupKind::History,
                                &recorded,
                                targets,
                            )?;
                        }
                    }
                }
            }
            for name in ["organization.json", "recycle.json"] {
                let path = root.join(name);
                if exists(&path)? {
                    capture_unacknowledged(repo, &path, CleanupKind::Metadata, &recorded, targets)?;
                }
            }
        }
    }
    Ok(())
}
fn capture_publication(
    repo: &CollaborationRepository,
    mut target: Target,
    recorded: &mut HashSet<String>,
    targets: &mut Vec<Target>,
) -> Result<()> {
    uuid(&target.cleanup_id)?;
    digest(&target.identity)?;
    digest(&target.digest)?;
    validate_path(&target)?;
    recorded.insert(target.path.clone());
    let staged = target.staged_path.take();
    if exists(&repo.root.join(&target.path))? {
        limit(targets.len() < 100_000)?;
        targets.push(target.clone());
    }
    if let Some(staged) = staged {
        let mut staged_target = target.clone();
        staged_target.path = staged;
        staged_target.cleanup_id = uuid::Uuid::new_v4().to_string();
        validate_path(&staged_target)?;
        require(
            Path::new(&staged_target.path).parent() == Path::new(&target.path).parent(),
            "Staging ownership escapes publication directory",
        )?;
        recorded.insert(staged_target.path.clone());
        let staged_path = repo.root.join(&staged_target.path);
        if exists(&staged_path)? {
            let mut actual = vec![];
            capture_target(
                repo,
                &mut actual,
                &staged_path,
                target.kind,
                None,
                "Interrupted payload staging metadata".into(),
                None,
            )?;
            let actual = actual.pop().unwrap();
            limit(targets.len() < 100_000)?;
            if actual.identity == target.identity {
                targets.push(actual);
            } else {
                targets.push(staged_target);
            }
        }
    }
    Ok(())
}
pub(super) fn publish_legacy_backup(
    repo: &CollaborationRepository,
    attempt: &str,
    path: &Path,
    bytes: &[u8],
    mut after_write: impl FnMut(atomic::PublishFault) -> Result<()>,
) -> Result<()> {
    atomic::publish_new_owned(
        path,
        bytes,
        None,
        None,
        |staged, held| {
            let relative = |p: &Path| {
                p.strip_prefix(&repo.root)
                    .ok()
                    .and_then(|p| p.to_str())
                    .map(|s| s.replace('\\', "/"))
                    .ok_or_else(|| AppError::invalid("Legacy backup escapes project"))
            };
            let target = Target {
                cleanup_id: uuid::Uuid::new_v4().to_string(),
                path: relative(path)?,
                media_id: None,
                display_name: "Upgrade rollback history".into(),
                kind: CleanupKind::History,
                identity: atomic::file_identity(held)?,
                digest: hash(bytes),
                bytes: bytes.len() as u64,
                authorized: true,
                staged_path: Some(relative(staged)?),
            };
            validate_path(&target)?;
            require(
                target
                    .path
                    .starts_with(&format!("maintenance/{attempt}/rollback/")),
                "Legacy backup escapes attempt",
            )?;
            atomic::publish_new(
                &operation_dir(repo, attempt)?
                    .join(format!("legacy-file-{}.json", hash(target.path.as_bytes()))),
                &encoded(&target)?,
                None,
                None,
            )
        },
        &mut after_write,
    )
}
fn capture_legacy_publications(
    repo: &CollaborationRepository,
    dir: &Path,
    journal: &LegacyJournal,
    targets: &mut Vec<Target>,
) -> Result<HashSet<String>> {
    let mut recorded = HashSet::new();
    for (index, entry) in fs::read_dir(dir).map_err(atomic::io)?.enumerate() {
        limit(index < 100_000)?;
        let path = entry.map_err(atomic::io)?.path();
        if !path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("legacy-file-"))
        {
            continue;
        }
        let target: Target = serde_json::from_slice(&atomic::read(&path, 65536)?)
            .map_err(|_| AppError::invalid("Invalid legacy publication intent"))?;
        require(
            journal.authors.iter().any(|author| {
                author.backups.iter().any(|backup| {
                    target.path
                        == format!(
                            "maintenance/{}/rollback/{}/{:020}.json",
                            journal.operation_id, author.author_id, backup.revision
                        )
                        && target.digest == backup.byte_hash
                        && target.bytes == backup.byte_length as u64
                })
            }),
            "Legacy publication has no backup owner",
        )?;
        capture_publication(repo, target, &mut recorded, targets)?;
    }
    Ok(recorded)
}
fn capture_unacknowledged(
    repo: &CollaborationRepository,
    path: &Path,
    kind: CleanupKind,
    recorded: &HashSet<String>,
    targets: &mut Vec<Target>,
) -> Result<()> {
    let relative = path
        .strip_prefix(&repo.root)
        .map_err(|_| AppError::invalid("Candidate file escapes project"))?
        .to_str()
        .ok_or_else(|| AppError::invalid("Invalid candidate file"))?
        .replace('\\', "/");
    if recorded.contains(&relative) {
        return Ok(());
    }
    capture_target(
        repo,
        targets,
        path,
        kind,
        None,
        "Unacknowledged candidate metadata".into(),
        None,
    )?;
    targets.last_mut().unwrap().authorized = false;
    Ok(())
}

fn observer_id(operation: &str, attempt: &str, author: &str) -> String {
    let digest = Sha256::digest(
        format!("legacy-staging-observer:{operation}:{attempt}:{author}").as_bytes(),
    );
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
fn observer_scopes(
    repo: &CollaborationRepository,
    operation: &str,
    attempt: &str,
) -> Result<Vec<LegacyObserver>> {
    let journal = LegacyJournal::parse(&atomic::read(
        &operation_dir(repo, attempt)?.join("legacy.json"),
        MAX_LAYER_BYTES,
    )?)?;
    require(
        journal.project_id == repo.manifest.project_id && journal.operation_id == attempt,
        "Legacy observer preparation identity mismatch",
    )?;
    Ok(journal
        .authors
        .into_iter()
        .map(|author| LegacyObserver {
            cleanup_id: observer_id(operation, attempt, &author.author_id),
            author_id: author.author_id,
            legacy_preparation_id: attempt.into(),
            source_entry_hash: journal.source_entry_hash.clone(),
            lease_identity: author.lease_hash,
            fence_revision: author.candidate_revision,
            fence_hash: author.fence_hash,
        })
        .collect())
}
fn known_paths(work: &[WorkItem]) -> HashMap<String, (String, String)> {
    work.iter()
        .filter_map(|item| {
            if let WorkItem::File { receipt, target } = item {
                Some((
                    target.path.clone(),
                    (receipt.operation_id.clone(), target.cleanup_id.clone()),
                ))
            } else {
                None
            }
        })
        .collect()
}

fn settle_observer(
    repo: &CollaborationRepository,
    session: &AuthorSession,
    receipt: &PurgeReceipt,
    scope: &LegacyObserver,
    known_paths: &HashMap<String, (String, String)>,
) -> Result<()> {
    require(
        committed(repo, &receipt.operation_id)? == *receipt,
        "Legacy observer has no permanent receipt",
    )?;
    let journal = LegacyJournal::parse(&atomic::read(
        &operation_dir(repo, &scope.legacy_preparation_id)?.join("legacy.json"),
        MAX_LAYER_BYTES,
    )?)?;
    require(
        journal.project_id == repo.manifest.project_id
            && journal.operation_id == scope.legacy_preparation_id
            && journal.source_entry_hash == receipt.source_entry_hash
            && journal.actor_id == receipt.actor_id
            && journal.authors.iter().any(|author| {
                author.author_id == scope.author_id
                    && author.lease_hash == scope.lease_identity
                    && author.candidate_revision == scope.fence_revision
                    && author.fence_hash == scope.fence_hash
            }),
        "Legacy observation ownership changed",
    )?;
    let dir = repo.root.join("annotations").join(&scope.author_id);
    let lease = dir.join(".writer.lock");
    require(
        atomic::lock_identity(&lease)? == scope.lease_identity,
        "Legacy observer stable lease identity changed",
    )?;
    let _drain = if session.identity().author_id == scope.author_id {
        Some(session.try_drain_publications()?)
    } else {
        None
    };
    let _foreign = if session.identity().author_id != scope.author_id {
        Some(atomic::lock(&lease).map_err(|mut error| {
            error.message = format!(
                "Legacy publication retirement remains pending: {}",
                error.message
            );
            error
        })?)
    } else {
        repo.session_authority(session)?;
        None
    };
    if let Some(held) = &_foreign {
        atomic::verify_lock_path(&lease, held)?;
    }
    require(
        atomic::lock_identity(&lease)? == scope.lease_identity,
        "Legacy observer stable lease identity changed",
    )?;
    let fence = dir.join(format!("{:020}.json", scope.fence_revision));
    require(
        hash(&atomic::read(&fence, MAX_LAYER_BYTES)?) == scope.fence_hash,
        "Permanent collision fence changed",
    )?;
    atomic::safe_existing(&dir)?;
    for (index, entry) in fs::read_dir(&dir).map_err(atomic::io)?.enumerate() {
        limit(index < 256)?;
        let path = entry.map_err(atomic::io)?.path();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| AppError::invalid("Invalid legacy staging entry"))?;
        if name == ".writer.lock" || path == fence {
            continue;
        }
        let relative = format!("annotations/{}/{name}", scope.author_id);
        if let Some((owner, id)) = known_paths.get(&relative) {
            if !progress(repo, owner, id)?.complete {
                continue;
            }
        }
        atomic::safe_existing(&path)?;
        return Err(AppError::invalid("Unowned legacy staging/history body remains; no original file ownership authorizes deletion"));
    }
    Ok(())
}

fn committed(repo: &CollaborationRepository, operation: &str) -> Result<PurgeReceipt> {
    require(
        repo.manifest.format_version
            == crate::collaboration::consts::GENERATION_COLLABORATION_FORMAT,
        "Cleanup has no committed generation",
    )?;
    let descriptor = GenerationDescriptor::parse(&atomic::read(
        &repo.metadata_root.join("generation.json"),
        MAX_LAYER_BYTES,
    )?)?;
    descriptor
        .receipts
        .into_iter()
        .find(|r| r.operation_id == operation)
        .ok_or_else(|| AppError::invalid("Cleanup has no permanent receipt"))
}
fn load(repo: &CollaborationRepository, operation: &str) -> Result<(PurgeReceipt, Manifest)> {
    let receipt = committed(repo, operation)?;
    let path = operation_dir(repo, operation)?
        .join(format!("cleanup-{}.json", receipt.cleanup_manifest_hash));
    let bytes = atomic::read(&path, MAX_TOTAL_LAYER_BYTES)?;
    require(
        hash(&bytes) == receipt.cleanup_manifest_hash,
        "Cleanup manifest digest changed",
    )?;
    let mut manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::invalid("Invalid cleanup manifest"))?;
    require(
        manifest.project_id == repo.manifest.project_id
            && manifest.operation_id == operation
            && manifest.source_entry_hash == receipt.source_entry_hash
            && manifest.generation_id == receipt.generation_id,
        "Cleanup manifest ownership mismatch",
    )?;
    limit(manifest.targets.len() <= 100_000)?;
    let mut paths = HashSet::new();
    let mut ids = HashSet::new();
    for target in &manifest.targets {
        validate_path(target)?;
        uuid(&target.cleanup_id)?;
        digest(&target.identity)?;
        digest(&target.digest)?;
        require(
            paths.insert(&target.path) && ids.insert(&target.cleanup_id),
            "Duplicate cleanup identity",
        )?;
        if target.kind == CleanupKind::Audio {
            require(
                target
                    .media_id
                    .as_ref()
                    .is_some_and(|id| receipt.removed_ids.contains(id)),
                "Audio cleanup exceeds retirement receipt",
            )?;
        }
    }
    if let Some(attempt) = &receipt.legacy_preparation_id {
        // Earlier receipt-bound manifests lacked explicit observer fields. Their
        // exact winning legacy preparation still grants observation, never unlink.
        if manifest.legacy_observers.is_empty() {
            manifest.legacy_observers = observer_scopes(repo, operation, attempt)?;
        }
    }
    limit(manifest.legacy_observers.len() <= MAX_AUTHORS)?;
    for scope in &manifest.legacy_observers {
        uuid(&scope.cleanup_id)?;
        uuid(&scope.author_id)?;
        uuid(&scope.legacy_preparation_id)?;
        digest(&scope.source_entry_hash)?;
        digest(&scope.lease_identity)?;
        digest(&scope.fence_hash)?;
        require(
            scope.cleanup_id
                == observer_id(operation, &scope.legacy_preparation_id, &scope.author_id)
                && receipt.legacy_preparation_id.as_deref()
                    == Some(scope.legacy_preparation_id.as_str())
                && scope.source_entry_hash == receipt.source_entry_hash
                && scope.fence_revision > 0
                && ids.insert(&scope.cleanup_id),
            "Invalid legacy staging observation scope",
        )?;
    }
    Ok((receipt, manifest))
}
/// Dependency resolution never re-reads a remaining file to grant new ownership.
/// All identities/digests and progress stay with the original permanent receipt.
fn load_work(
    repo: &CollaborationRepository,
    operation: &str,
) -> Result<(PurgeReceipt, Vec<WorkItem>)> {
    let (receipt, manifest) = load(repo, operation)?;
    let generation = GenerationDescriptor::parse(&atomic::read(
        &repo.metadata_root.join("generation.json"),
        MAX_LAYER_BYTES,
    )?)?;
    let current_index = generation
        .receipts
        .iter()
        .position(|r| r.operation_id == operation)
        .ok_or_else(|| AppError::invalid("Missing cleanup receipt"))?;
    // Receipts can contain the entire fixed selection. Share one per owner,
    // rather than cloning those vectors for every physical cleanup item.
    let shared = Arc::new(receipt.clone());
    let mut work: Vec<_> = manifest
        .targets
        .into_iter()
        .map(|target| WorkItem::File {
            receipt: Arc::clone(&shared),
            target,
        })
        .collect();
    work.extend(
        manifest
            .legacy_observers
            .into_iter()
            .map(|scope| WorkItem::Observer {
                receipt: Arc::clone(&shared),
                scope,
            }),
    );
    let mut operations = HashSet::new();
    limit(manifest.dependencies.len() <= MAX_MEDIA)?;
    for dependency in manifest.dependencies {
        uuid(&dependency.operation_id)?;
        digest(&dependency.manifest_hash)?;
        require(
            operations.insert(dependency.operation_id.clone()),
            "Duplicate cleanup dependency",
        )?;
        let index = generation
            .receipts
            .iter()
            .position(|r| r.operation_id == dependency.operation_id)
            .ok_or_else(|| AppError::invalid("Cleanup dependency has no permanent receipt"))?;
        require(
            index < current_index
                && generation.receipts[index].cleanup_manifest_hash == dependency.manifest_hash,
            "Cleanup dependency is not an earlier receipt-bound manifest",
        )?;
        let (owner, original) = load(repo, &dependency.operation_id)?;
        let owner = Arc::new(owner);
        limit(dependency.cleanup_ids.len() <= 100_000)?;
        let mut ids = HashSet::new();
        for id in dependency.cleanup_ids {
            uuid(&id)?;
            require(ids.insert(id), "Duplicate dependent cleanup item")?;
        }
        let requested = ids.len();
        let mut found = 0;
        for target in original.targets {
            if ids.contains(&target.cleanup_id) {
                require(
                    target.kind != CleanupKind::Audio,
                    "Cleanup dependency cannot expand audio targets",
                )?;
                limit(work.len() < 100_000)?;
                found += 1;
                work.push(WorkItem::File {
                    receipt: owner.clone(),
                    target,
                });
            }
        }
        for scope in original.legacy_observers {
            if ids.contains(&scope.cleanup_id) {
                limit(work.len() < 100_000)?;
                found += 1;
                work.push(WorkItem::Observer {
                    receipt: owner.clone(),
                    scope,
                });
            }
        }
        require(
            found == requested,
            "Cleanup dependency exceeds its original manifest",
        )?;
    }
    Ok((receipt, work))
}

fn progress_path(repo: &CollaborationRepository, operation: &str, id: &str) -> Result<PathBuf> {
    uuid(id)?;
    Ok(operation_dir(repo, operation)?.join(format!("progress-{id}.json")))
}
fn progress(repo: &CollaborationRepository, operation: &str, id: &str) -> Result<Progress> {
    let path = progress_path(repo, operation, id)?;
    if !exists(&path)? {
        return Ok(Progress::default());
    }
    let value: Progress = serde_json::from_slice(&atomic::read(&path, 65536)?)
        .map_err(|_| AppError::invalid("Invalid cleanup progress"))?;
    require(
        !value.complete || value.attempting || value.deleted_audio_bytes == 0,
        "Cleanup byte acknowledgement has no attempt",
    )?;
    Ok(value)
}
fn save_progress(
    repo: &CollaborationRepository,
    operation: &str,
    id: &str,
    value: &Progress,
) -> Result<()> {
    let path = progress_path(repo, operation, id)?;
    let bytes = encoded(value)?;
    if exists(&path)? {
        atomic::replace_metadata(&path, &bytes)
    } else {
        atomic::publish_new(&path, &bytes, None, None)
    }
}
fn unreferenced(
    repo: &CollaborationRepository,
    receipt: &PurgeReceipt,
    target: &Target,
) -> Result<()> {
    require(
        committed(repo, &receipt.operation_id)? == *receipt,
        "Cleanup permanent receipt changed",
    )?;
    let path = repo.root.join(&target.path);
    require(
        !path.starts_with(&repo.metadata_root),
        "Cleanup target is in the live generation",
    )?;
    if target.kind == CleanupKind::Audio {
        require(
            repo.manifest
                .media
                .iter()
                .all(|m| Some(&m.id) != target.media_id.as_ref() && m.source_ref != target.path),
            "Cleanup audio is still referenced",
        )?;
    }
    Ok(())
}
impl CollaborationRepository {
    /// A live new-version client can acknowledge its exact source/lease-bound
    /// legacy queue without closing. Tasks 7/8 call this after their local drain.
    /// It grants no ownership of unlisted files and performs no physical unlink.
    pub fn acknowledge_purge_staging_drained(
        &self,
        session: &AuthorSession,
        operation: &str,
    ) -> Result<CleanupSummary> {
        let current = Self::open(&self.root)?;
        current.session_authority(session)?;
        let (_, work) = load_work(&current, operation)?;
        let known = known_paths(&work);
        for item in &work {
            let WorkItem::Observer { receipt, scope } = item else {
                continue;
            };
            if scope.author_id != session.identity().author_id {
                continue;
            }
            let _owner = atomic::short_lock(
                &operation_dir(&current, &receipt.operation_id)?.join(".cleanup.lock"),
            )?;
            let mut p = progress(&current, &receipt.operation_id, &scope.cleanup_id)?;
            if p.complete {
                continue;
            }
            p.attempting = true;
            match settle_observer(&current, session, receipt, scope, &known) {
                Ok(()) => {
                    p.complete = true;
                    p.error = None;
                }
                Err(error) => {
                    p.error = Some(error);
                }
            }
            save_progress(&current, &receipt.operation_id, &scope.cleanup_id, &p)?;
        }
        current.purge_cleanup_summary(operation)
    }
    pub fn purge_cleanup_summary(&self, operation: &str) -> Result<CleanupSummary> {
        let current = Self::open(&self.root)?;
        let (_, work) = load_work(&current, operation)?;
        let mut result = CleanupSummary {
            operation_id: operation.into(),
            complete: true,
            deleted_audio_bytes: 0,
            pending_count: 0,
            failed_count: 0,
        };
        for item in work {
            let p = progress(&current, &item.receipt().operation_id, item.id())?;
            result.deleted_audio_bytes = result
                .deleted_audio_bytes
                .checked_add(
                    if p.complete
                        && item.kind() == CleanupKind::Audio
                        && item.receipt().operation_id == operation
                    {
                        p.deleted_audio_bytes
                    } else {
                        0
                    },
                )
                .ok_or_else(|| AppError::invalid("Cleanup byte count overflow"))?;
            if !p.complete {
                result.complete = false;
                result.pending_count += 1;
                result.failed_count += usize::from(p.error.is_some());
            }
        }
        Ok(result)
    }
    pub fn purge_cleanup_page(
        &self,
        operation: &str,
        offset: usize,
        limit_value: usize,
    ) -> Result<CleanupPage> {
        require(
            (1..=50).contains(&limit_value),
            "Cleanup page limit must be 1..50",
        )?;
        let current = Self::open(&self.root)?;
        let (_, work) = load_work(&current, operation)?;
        let mut pending = vec![];
        for item in work {
            let p = progress(&current, &item.receipt().operation_id, item.id())?;
            if !p.complete {
                pending.push(item.into_page(p.error));
            }
        }
        Ok(CleanupPage {
            total: pending.len(),
            offset,
            limit: limit_value,
            items: pending.into_iter().skip(offset).take(limit_value).collect(),
        })
    }
    pub fn retry_purge_cleanup(
        &self,
        session: &AuthorSession,
        operation: &str,
    ) -> Result<CleanupSummary> {
        self.retry_purge_cleanup_controlled(
            session,
            operation,
            usize::MAX,
            &AtomicBool::new(false),
            |_, _| Ok(()),
        )
    }
    /// Bounded and cancellable. The caller retires native media tasks before invoking.
    /// Only an operation lock spans the pass; the shared catalog guard spans one unlink.
    pub fn retry_purge_cleanup_controlled(
        &self,
        session: &AuthorSession,
        operation: &str,
        max_items: usize,
        cancel: &AtomicBool,
        mut boundary: impl FnMut(CleanupBoundary, &str) -> Result<()>,
    ) -> Result<CleanupSummary> {
        let current = Self::open(&self.root)?;
        current.session_authority(session)?;
        let (receipt, work) = load_work(&current, operation)?;
        let _operation =
            atomic::short_lock(&operation_dir(&current, operation)?.join(".cleanup.lock"))?;
        let known_paths = known_paths(&work);
        let mut attempted = 0;
        for item in &work {
            let owner_operation = &item.receipt().operation_id;
            // Dependencies point strictly backwards in receipt order. This prevents
            // lock cycles while serializing progress with the original cleanup.
            let _dependency = if owner_operation != operation {
                Some(atomic::short_lock(
                    &operation_dir(&current, owner_operation)?.join(".cleanup.lock"),
                )?)
            } else {
                None
            };
            let mut p = progress(&current, owner_operation, item.id())?;
            if p.complete {
                continue;
            }
            if attempted >= max_items {
                break;
            }
            crate::media::identity::check_cancel(cancel)?;
            attempted += 1;
            if let WorkItem::Observer { receipt, scope } = item {
                p.attempting = true;
                match settle_observer(&current, session, receipt, scope, &known_paths) {
                    Ok(()) => {
                        p.complete = true;
                        p.error = None;
                    }
                    Err(error) => {
                        p.error = Some(error);
                    }
                }
                save_progress(&current, owner_operation, item.id(), &p)?;
                continue;
            }
            let WorkItem::File { target, .. } = item else {
                unreachable!()
            };
            // This boundary is deliberately per-item: diagnostics are persisted and
            // independent paths continue after filesystem/identity failures.
            let outcome = (|| {
                let path = current.root.join(&target.path);
                let fresh = Self::open(&current.root)?;
                fresh.session_authority(session)?;
                unreferenced(&fresh, item.receipt(), target)?;
                require(target.authorized,"Candidate file lacks durable ownership acknowledgement; preserve for diagnostic recovery")?;
                if !exists(&path)? {
                    // The immutable precommit identity/digest and permanent receipt
                    // prove ownership; current non-reference was checked above.
                    // An old prune or external removal may already have removed it.
                    // Absence proves completion, never audio bytes released by us.
                    p.complete = true;
                    p.error = None;
                    return save_progress(&current, owner_operation, &target.cleanup_id, &p);
                }
                let mut held = atomic::cleanup_handle(&path)?;
                require(
                    atomic::file_identity(&held)? == target.identity
                        && held.metadata().map_err(atomic::io)?.len() == target.bytes
                        && hash_file(&mut held)? == target.digest,
                    "Cleanup target was replaced or modified",
                )?;
                p.attempting = true;
                p.error = None;
                save_progress(&current, owner_operation, &target.cleanup_id, &p)?;
                boundary(CleanupBoundary::BeforeUnlink, &target.cleanup_id)?;
                {
                    let _catalog = atomic::short_lock(&current.root.join("catalog/.commit.lock"))?;
                    let fresh = Self::open(&current.root)?;
                    fresh.session_authority(session)?;
                    unreferenced(&fresh, item.receipt(), target)?;
                    atomic::unlink_held(&path, &held)?;
                }
                drop(held);
                boundary(
                    CleanupBoundary::AfterUnlinkBeforeProgress,
                    &target.cleanup_id,
                )?;
                // Preserve acknowledged unlink bytes before any diagnostic/fault boundary.
                // Pending paths contribute zero until durable completion.
                if target.kind == CleanupKind::Audio {
                    p.deleted_audio_bytes = target.bytes;
                }
                save_progress(&current, owner_operation, &target.cleanup_id, &p)?;
                boundary(CleanupBoundary::AfterUnlink, &target.cleanup_id)?;
                p.complete = true;
                p.error = None;
                save_progress(&current, owner_operation, &target.cleanup_id, &p)?;
                boundary(CleanupBoundary::AfterProgress, &target.cleanup_id)
            })();
            if let Err(error) = outcome {
                p.error = Some(error);
                save_progress(&current, owner_operation, &target.cleanup_id, &p)?;
            }
        }
        let summary = current.purge_cleanup_summary(operation)?;
        let dir = operation_dir(&current, operation)?;
        let mut journal =
            PurgeJournal::parse(&atomic::read(&dir.join("purge.json"), MAX_LAYER_BYTES)?)?;
        // Entry authority wins even if the process died before saving Preparing.
        require(
            journal.receipt == receipt,
            "Cleanup candidate differs from committed receipt",
        )?;
        journal.status = if summary.complete {
            JournalStatus::Complete
        } else {
            JournalStatus::CommittedPendingCleanup
        };
        super::transaction::save_journal(&current, &journal)?;
        Ok(summary)
    }
    /// Read-only discovery: accepted requests, rollback maintenance and committed
    /// cleanup remain distinguishable. No open operation performs shared writes.
    pub fn purge_maintenance_operations(&self) -> Result<Vec<MaintenanceOperation>> {
        let current = Self::open(&self.root)?;
        let maintenance = current.root.join("maintenance");
        if !exists(&maintenance)? {
            return Ok(vec![]);
        }
        atomic::safe_existing(&maintenance)?;
        let mut operations = vec![];
        for (index, entry) in fs::read_dir(&maintenance).map_err(atomic::io)?.enumerate() {
            limit(index < MAX_MEDIA)?;
            let dir = entry.map_err(atomic::io)?.path();
            atomic::safe_existing(&dir)?;
            let operation = dir
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| AppError::invalid("Invalid maintenance operation"))?;
            uuid(operation)?;
            let is_committed = if current.manifest.format_version
                == crate::collaboration::consts::GENERATION_COLLABORATION_FORMAT
            {
                let descriptor = GenerationDescriptor::parse(&atomic::read(
                    &current.metadata_root.join("generation.json"),
                    MAX_LAYER_BYTES,
                )?)?;
                descriptor
                    .receipts
                    .iter()
                    .any(|r| r.operation_id == operation)
            } else {
                false
            };
            let cleanup = if is_committed {
                Some(current.purge_cleanup_summary(operation)?)
            } else {
                None
            };
            let legacy_attempt = exists(&dir.join("legacy.json"))?;
            let status = if let Some(summary) = &cleanup {
                if summary.complete {
                    MaintenanceStatus::Complete
                } else {
                    MaintenanceStatus::CommittedPendingCleanup
                }
            } else if legacy_attempt {
                let legacy = LegacyJournal::parse(&atomic::read(
                    &dir.join("legacy.json"),
                    MAX_LAYER_BYTES,
                )?)?;
                require(
                    legacy.project_id == current.manifest.project_id
                        && legacy.operation_id == operation,
                    "Legacy inventory owner mismatch",
                )?;
                if current.manifest.format_version
                    == crate::collaboration::consts::GENERATION_COLLABORATION_FORMAT
                {
                    let descriptor = GenerationDescriptor::parse(&atomic::read(
                        &current.metadata_root.join("generation.json"),
                        MAX_LAYER_BYTES,
                    )?)?;
                    require(
                        descriptor
                            .receipts
                            .iter()
                            .any(|r| r.source_entry_hash == legacy.source_entry_hash),
                        "Legacy attempt has no superseding receipt",
                    )?;
                    if descriptor.receipts.iter().any(|r| {
                        r.legacy_preparation_id.as_deref() == Some(operation)
                            && r.actor_id == legacy.actor_id
                            && r.source_entry_hash == legacy.source_entry_hash
                    }) {
                        MaintenanceStatus::LegacyCommitted
                    } else {
                        MaintenanceStatus::Superseded
                    }
                } else {
                    match legacy.status {
                        LegacyStatus::Preparing => MaintenanceStatus::Preparing,
                        LegacyStatus::RollbackPending => MaintenanceStatus::RollbackPending,
                        LegacyStatus::RolledBack => MaintenanceStatus::RolledBack,
                        LegacyStatus::Committed => {
                            return Err(AppError::invalid("Legacy commit has no permanent receipt"))
                        }
                    }
                }
            } else if exists(&dir.join("purge.json"))? {
                let journal =
                    PurgeJournal::parse(&atomic::read(&dir.join("purge.json"), MAX_LAYER_BYTES)?)?;
                require(
                    journal.project_id == current.manifest.project_id
                        && journal.receipt.operation_id == operation,
                    "Purge inventory owner mismatch",
                )?;
                require(
                    journal.status == JournalStatus::Preparing,
                    "Purge journal has no permanent receipt",
                )?;
                MaintenanceStatus::Preparing
            } else {
                MaintenanceStatus::Accepted
            };
            operations.push(MaintenanceOperation {
                status,
                operation_id: operation.into(),
                committed: is_committed,
                cleanup,
                legacy_attempt,
            });
        }
        operations.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        Ok(operations)
    }
    /// Explicit writable recovery branches on permanent entry authority first.
    /// A request without a receipt is never destructive cleanup authority.
    pub fn recover_purge_maintenance(
        &self,
        session: &AuthorSession,
        operation: &str,
    ) -> Result<MaintenanceOperation> {
        let current = Self::open(&self.root)?;
        current.session_authority(session)?;
        let item = current
            .purge_maintenance_operations()?
            .into_iter()
            .find(|i| i.operation_id == operation)
            .ok_or_else(|| AppError::invalid("Unknown maintenance operation"))?;
        if item.committed {
            current.retry_purge_cleanup(session, operation)?;
        } else if item.legacy_attempt {
            current.recover_legacy_upgrade_drained(operation, session)?;
        }
        current
            .purge_maintenance_operations()?
            .into_iter()
            .find(|i| i.operation_id == operation)
            .ok_or_else(|| AppError::invalid("Maintenance operation disappeared"))
    }
}
