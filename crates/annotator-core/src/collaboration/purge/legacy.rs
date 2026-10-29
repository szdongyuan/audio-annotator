//! Numeric collision fences for publishers which do not participate in the new
//! commit lock. User history is copied and synced before any fence can appear.
use super::{
    journal::{
        validate_legacy_backup_budget, LegacyAuthor, LegacyBackup, LegacyJournal, LegacyStatus,
    },
    PurgeAuthority,
};
use crate::{
    collaboration::{
        atomic, consts::*, validation::*, AuthorLayer, AuthorSession, AuthorSnapshot, Checkpoint,
        CollaborationRepository, CollaborationSnapshot, CURRENT_COLLABORATION_FORMAT,
    },
    error::{AppError, ErrorCode, Result},
    model::validation::MAX_SAFE_INTEGER,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fence {
    kind: String,
    format_version: u32,
    project_id: String,
    operation_id: String,
    owner_id: String,
    author_id: String,
    revision: u64,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    predecessor: Option<Checkpoint>,
}
fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| AppError::invalid("Cannot encode legacy upgrade"))?;
    limit(bytes.len() <= MAX_LAYER_BYTES)?;
    Ok(bytes)
}
fn fence_bytes(journal: &LegacyJournal, author: &LegacyAuthor) -> Result<Vec<u8>> {
    encoded(&Fence {
        kind: LEGACY_FENCE_KIND.into(),
        format_version: 1,
        project_id: journal.project_id.clone(),
        operation_id: journal.operation_id.clone(),
        owner_id: journal.owner_id.clone(),
        author_id: author.author_id.clone(),
        revision: author.candidate_revision,
        predecessor: author.predecessor.clone(),
    })
}
fn operation_dir(root: &Path, operation: &str) -> Result<PathBuf> {
    uuid(operation)?;
    Ok(root.join("maintenance").join(operation))
}
fn history_path(root: &Path, author: &str, revision: u64) -> PathBuf {
    root.join("annotations")
        .join(author)
        .join(format!("{revision:020}.json"))
}
fn backup_path(dir: &Path, author: &str, revision: u64) -> PathBuf {
    dir.join("rollback")
        .join(author)
        .join(format!("{revision:020}.json"))
}
fn save(dir: &Path, journal: &LegacyJournal) -> Result<()> {
    let bytes = encoded(journal)?;
    LegacyJournal::parse(&bytes)?;
    let path = dir.join("legacy.json");
    if path.try_exists().map_err(atomic::io)? {
        atomic::replace_metadata(&path, &bytes)
    } else {
        atomic::publish_new(&path, &bytes, None, None)
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(AppError::new(
            ErrorCode::Cancelled,
            "Legacy upgrade cancelled",
        ))
    } else {
        Ok(())
    }
}
/// Deterministic boundaries around real journal sync and compare-and-create.
/// Carries no caller-selected filesystem path and is never exposed through IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyBoundary {
    BeforeJournal,
    AfterBackup { author_id: String, revision: u64 },
    AfterBackupStaged { author_id: String, revision: u64 },
    BeforeFence { author_id: String, revision: u64 },
    AfterFencePublication { author_id: String, revision: u64 },
    AfterFence { author_id: String, revision: u64 },
    Frozen,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyRecovery {
    RollbackPending,
    RolledBack,
    Committed,
    /// Another preparation won the same source entry. This attempt's backups
    /// remain owned for cleanup, but can never restore pre-purge user content.
    Superseded,
}
/// Holds both existing migration locks through preparation and commit. Dropping
/// this capability simulates a crash; recovery must reacquire both locks.
pub struct LegacyUpgrade<'a> {
    repo: &'a CollaborationRepository,
    _catalog: File,
    _registration: File,
    journal: LegacyJournal,
    authority: PurgeAuthority,
}
impl LegacyUpgrade<'_> {
    pub fn authority(&self) -> &PurgeAuthority {
        &self.authority
    }
    pub fn operation_id(&self) -> &str {
        &self.journal.operation_id
    }
    pub fn retained_history(&self, author: &str) -> Result<Vec<AuthorLayer>> {
        uuid(author)?;
        let record = self
            .journal
            .authors
            .iter()
            .find(|a| a.author_id == author)
            .ok_or_else(|| AppError::invalid("Author was not frozen by this upgrade"))?;
        let source = self.repo.reload_catalog()?;
        let dir = operation_dir(&self.repo.root, &self.journal.operation_id)?;
        source.validate_legacy_backups(&dir, record)?;
        let mut history = vec![];
        for revision in record.retained.iter().rev().take(16).rev() {
            let bytes = atomic::read(&backup_path(&dir, author, *revision), MAX_LAYER_BYTES)?;
            let layer = AuthorLayer::parse(&bytes, &source.manifest, author)?;
            if let Some(previous) = history.last() {
                require(
                    layer.parent.as_ref() == Some(&AuthorLayer::checkpoint(previous)),
                    "Invalid retained backup chain",
                )?;
            }
            history.push(layer);
        }
        Ok(history)
    }
    /// Cancel or finish preparation without waiting for another author's lease.
    /// Committed entry authority always takes precedence over cancellation.
    pub fn rollback(mut self) -> Result<LegacyRecovery> {
        self.repo.settle_legacy_locked(&mut self.journal)
    }
    /// Deterministic recovery boundary after the source-head check and before
    /// restoring a missing original history file.
    pub fn rollback_interleaved(
        mut self,
        mut before_restore: impl FnMut(&str, u64) -> Result<()>,
    ) -> Result<LegacyRecovery> {
        self.repo
            .settle_legacy_controlled(&mut self.journal, None, &mut before_restore)
    }
    pub fn rollback_with_drained_session(
        mut self,
        session: &AuthorSession,
    ) -> Result<LegacyRecovery> {
        self.repo.session_authority(session)?;
        let _drain = match session.try_drain_publications() {
            Ok(drain) => drain,
            // Drain proof is only a cleanup optimization. Cancellation must
            // still remove its fences and preserve pending backups when busy.
            Err(error) if error.code == ErrorCode::ProjectLocked => {
                return self.repo.settle_legacy_locked(&mut self.journal)
            }
            Err(error) => return Err(error),
        };
        self.repo
            .settle_legacy_with_drain(&mut self.journal, Some(session))
    }
    /// Called after the transaction's entry replacement. This method observes
    /// strict generation/receipt authority; it cannot itself commit a purge.
    pub fn record_committed(mut self) -> Result<LegacyRecovery> {
        require(
            self.repo.legacy_is_committed(&self.journal)?,
            "Legacy upgrade has no committed receipt",
        )?;
        self.repo.settle_legacy_locked(&mut self.journal)
    }
}

impl CollaborationRepository {
    pub fn prepare_legacy_upgrade<'a>(
        &'a self,
        session: &AuthorSession,
        operation: &str,
        cancel: &AtomicBool,
    ) -> Result<LegacyUpgrade<'a>> {
        self.prepare_legacy_upgrade_controlled(session, operation, cancel, |_| Ok(()))
    }
    pub fn prepare_legacy_upgrade_controlled<'a>(
        &'a self,
        session: &AuthorSession,
        operation: &str,
        cancel: &AtomicBool,
        mut boundary: impl FnMut(LegacyBoundary) -> Result<()>,
    ) -> Result<LegacyUpgrade<'a>> {
        uuid(operation)?;
        cancelled(cancel)?;
        let catalog = atomic::short_lock(&self.root.join("catalog/.commit.lock"))?;
        let registration = atomic::short_lock(&self.root.join("authors/.registration.lock"))?;
        self.session_authority(session)?;
        require(
            self.manifest.format_version == CURRENT_COLLABORATION_FORMAT,
            "Legacy upgrade requires format 5",
        )?;
        let current = self.reload_catalog()?;
        let protected = current.pending_legacy_histories()?;
        current.complete_author_snapshot()?;
        let accounts = current.authors()?;
        let dir = operation_dir(&self.root, operation)?;
        atomic::ensure_dir(&self.root.join("maintenance"))?;
        fs::create_dir(&dir).map_err(atomic::io)?;
        atomic::safe_existing(&dir)?;
        atomic::ensure_dir(&dir.join("rollback"))?;
        let mut journal = LegacyJournal {
            kind: LEGACY_UPGRADE_KIND.into(),
            format_version: 1,
            project_id: self.manifest.project_id.clone(),
            operation_id: operation.into(),
            owner_id: uuid::Uuid::new_v4().to_string(),
            actor_id: session.identity().author_id.clone(),
            source_entry_hash: self.manifest_hash.clone(),
            status: LegacyStatus::Preparing,
            authors: vec![],
        };
        boundary(LegacyBoundary::BeforeJournal)?;
        save(&dir, &journal)?;
        let result = (|| {
            let mut frozen = Vec::new();
            for account in accounts {
                let author = &account.identity.author_id;
                atomic::ensure_dir(&self.root.join("annotations").join(author))?;
                atomic::ensure_dir(&dir.join("rollback").join(author))?;
                let mut backed_up = vec![];
                let mut done = false;
                for _ in 0..32 {
                    cancelled(cancel)?;
                    let history = current.legacy_history_with_pending(author, &protected)?;
                    let layer = history.last().map(|(layer, _)| layer.clone());
                    let predecessor = layer.as_ref().map(AuthorLayer::checkpoint);
                    let revision = predecessor.as_ref().map_or(1, |p| p.revision + 1);
                    limit(revision <= MAX_SAFE_INTEGER)?;
                    let mut total = 0usize;
                    for (layer, bytes) in &history {
                        total = total.saturating_add(bytes.len());
                        limit(total <= MAX_TOTAL_LAYER_BYTES)?;
                        let backup = LegacyBackup {
                            revision: layer.revision,
                            byte_hash: hash(bytes),
                            byte_length: bytes.len(),
                        };
                        if !backed_up
                            .iter()
                            .any(|b: &LegacyBackup| b.revision == backup.revision)
                        {
                            backed_up.push(backup);
                        }
                    }
                    // A winning legacy layer can advance the retained window
                    // without shrinking backups owned by an earlier attempt.
                    // Reject before changing durable ownership: every emitted
                    // journal must remain within recovery's full-backup budget.
                    validate_legacy_backup_budget(&backed_up)?;
                    let mut record = LegacyAuthor {
                        author_id: author.clone(),
                        lease_hash: atomic::lock_identity(
                            &self
                                .root
                                .join("annotations")
                                .join(author)
                                .join(".writer.lock"),
                        )?,
                        candidate_revision: revision,
                        predecessor,
                        fence_hash: String::new(),
                        backups_ready: false,
                        fenced: false,
                        retired: false,
                        retained: history.iter().map(|(layer, _)| layer.revision).collect(),
                        restoration_candidates: vec![],
                        backups: backed_up.clone(),
                    };
                    let marker = fence_bytes(&journal, &record)?;
                    record.fence_hash = hash(&marker);
                    if let Some(existing) =
                        journal.authors.iter_mut().find(|a| a.author_id == *author)
                    {
                        *existing = record;
                    } else {
                        journal.authors.push(record);
                    }
                    save(&dir, &journal)?; // even a partially written backup has durable ownership
                    for (layer, bytes) in &history {
                        let path = backup_path(&dir, author, layer.revision);
                        if path.try_exists().map_err(atomic::io)? {
                            require(
                                atomic::read(&path, MAX_LAYER_BYTES)? == *bytes,
                                "History changed at immutable revision",
                            )?;
                        } else {
                            super::cleanup::publish_legacy_backup(
                                &current,
                                operation,
                                &path,
                                bytes,
                                |point| {
                                    if point == atomic::PublishFault::Sync {
                                        boundary(LegacyBoundary::AfterBackupStaged {
                                            author_id: author.clone(),
                                            revision: layer.revision,
                                        })?;
                                    }
                                    Ok(())
                                },
                            )?;
                        }
                        boundary(LegacyBoundary::AfterBackup {
                            author_id: author.clone(),
                            revision: layer.revision,
                        })?;
                    }
                    // Legacy publish/prune during backup invalidates this attempt.
                    if current.legacy_history_with_pending(author, &protected)? != history {
                        continue;
                    }
                    journal
                        .authors
                        .iter_mut()
                        .find(|a| a.author_id == *author)
                        .unwrap()
                        .backups_ready = true;
                    save(&dir, &journal)?;
                    boundary(LegacyBoundary::BeforeFence {
                        author_id: author.clone(),
                        revision,
                    })?;
                    cancelled(cancel)?;
                    match atomic::publish_new(
                        &history_path(&self.root, author, revision),
                        &marker,
                        None,
                        Some(cancel),
                    ) {
                        Ok(()) => (),
                        Err(error) if error.code == ErrorCode::RevisionConflict => {
                            current.legacy_history_with_pending(author, &protected)?;
                            continue;
                        }
                        Err(error) => return Err(error),
                    }
                    boundary(LegacyBoundary::AfterFencePublication {
                        author_id: author.clone(),
                        revision,
                    })?;
                    journal
                        .authors
                        .iter_mut()
                        .find(|a| a.author_id == *author)
                        .unwrap()
                        .fenced = true;
                    save(&dir, &journal)?;
                    boundary(LegacyBoundary::AfterFence {
                        author_id: author.clone(),
                        revision,
                    })?;
                    frozen.push(AuthorSnapshot {
                        identity: account.identity.clone(),
                        layer,
                        error: None,
                    });
                    done = true;
                    break;
                }
                if !done {
                    let mut conflict = AppError::new(
                        ErrorCode::RevisionConflict,
                        "Legacy publication changed repeatedly; retry upgrade",
                    );
                    conflict.retryable = true;
                    return Err(conflict);
                }
            }
            cancelled(cancel)?;
            boundary(LegacyBoundary::Frozen)?;
            cancelled(cancel)?;
            current.session_authority(session)?;
            let recycle = current.read_recycle()?;
            let snapshot = CollaborationSnapshot {
                project_id: current.manifest.project_id.clone(),
                authors: frozen,
            };
            let state = encoded(&(
                &current.manifest_hash,
                &current.catalog_revision,
                &current.organization,
                &recycle,
                &snapshot,
            ))?;
            Ok(PurgeAuthority {
                actor_id: session.identity().author_id.clone(),
                state_digest: hash(&state),
                snapshot,
                recycle,
            })
        })();
        let authority = match result {
            Ok(authority) => authority,
            Err(mut error) => {
                // This is the preparation recovery boundary: keep the original
                // failure and persist actionable rollback diagnostics.
                let rollback = self.settle_legacy_locked(&mut journal);
                let preparation_details = error.details.take();
                error.details = Some(serde_json::json!({"legacyOperationId": operation,
                    "preparation": preparation_details,
                    "rollback": match rollback { Ok(status) => serde_json::json!({"status":status}), Err(failure) => serde_json::json!({"error":failure}) }}));
                return Err(error);
            }
        };
        Ok(LegacyUpgrade {
            repo: self,
            _catalog: catalog,
            _registration: registration,
            journal,
            authority,
        })
    }

    /// Called only while catalog then registration locks exclude other migration
    /// and recovery owners. Older workers can still prune root history, so their
    /// durable pending backups must remain inputs to every preparation reread.
    fn pending_legacy_histories(&self) -> Result<Vec<(PathBuf, LegacyJournal)>> {
        let maintenance = self.root.join("maintenance");
        if !maintenance.try_exists().map_err(atomic::io)? {
            return Ok(vec![]);
        }
        atomic::safe_existing(&maintenance)?;
        let mut pending = vec![];
        let mut budget = MAX_TOTAL_LAYER_BYTES;
        for (index, entry) in fs::read_dir(&maintenance).map_err(atomic::io)?.enumerate() {
            limit(index < MAX_MEDIA)?;
            let entry = entry.map_err(atomic::io)?;
            let dir = entry.path();
            atomic::safe_existing(&dir)?;
            require(
                entry.file_type().map_err(atomic::io)?.is_dir(),
                "Invalid maintenance operation directory",
            )?;
            let operation = entry.file_name();
            let operation = operation
                .to_str()
                .ok_or_else(|| AppError::invalid("Invalid maintenance operation identity"))?;
            uuid(operation)?;
            let path = dir.join("legacy.json");
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(atomic::io(error)),
                Ok(_) => (),
            }
            let bytes = atomic::read(&path, MAX_LAYER_BYTES.min(budget))?;
            budget -= bytes.len();
            let journal = LegacyJournal::parse(&bytes)?;
            require(
                journal.project_id == self.manifest.project_id && journal.operation_id == operation,
                "Pending legacy operation identity mismatch",
            )?;
            if journal.source_entry_hash != self.manifest_hash
                || journal.status != LegacyStatus::RollbackPending
            {
                continue;
            }
            for author in &journal.authors {
                require(
                    hash(&fence_bytes(&journal, author)?) == author.fence_hash,
                    "Pending legacy fence ownership mismatch",
                )?;
            }
            pending.push((dir, journal));
        }
        Ok(pending)
    }

    fn legacy_history_with_pending(
        &self,
        author: &str,
        pending: &[(PathBuf, LegacyJournal)],
    ) -> Result<Vec<(AuthorLayer, Vec<u8>)>> {
        let history = self.legacy_history(author)?;
        let head = history.last().map(|(layer, _)| layer.checkpoint());
        let mut total = history.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        let mut merged: std::collections::BTreeMap<_, _> = history
            .into_iter()
            .map(|entry| (entry.0.revision, entry))
            .collect();
        for (dir, journal) in pending {
            let Some(record) = journal
                .authors
                .iter()
                .find(|a| a.author_id == author && a.fenced && a.backups_ready && !a.retired)
            else {
                continue;
            };
            if head != record.predecessor {
                // A genuinely newer normal publication owns its newer retention
                // window. Never bring an old attempt's pruned prefix back into it.
                require(
                    head.as_ref()
                        .is_some_and(|h| h.revision >= record.candidate_revision),
                    "Pending legacy source checkpoint changed",
                )?;
                continue;
            }
            require(
                atomic::lock_identity(
                    &self
                        .root
                        .join("annotations")
                        .join(author)
                        .join(".writer.lock"),
                )? == record.lease_hash,
                "Pending legacy writer lease identity changed",
            )?;
            self.validate_legacy_backups(dir, record)?;
            for revision in record.retained.iter().rev().take(16).rev() {
                let expected = record
                    .backups
                    .iter()
                    .find(|b| b.revision == *revision)
                    .ok_or_else(|| {
                        AppError::invalid("Pending retained history has no backup owner")
                    })?;
                if let Some((_, bytes)) = merged.get(revision) {
                    require(
                        bytes.len() == expected.byte_length && hash(bytes) == expected.byte_hash,
                        "Pending history differs from immutable source",
                    )?;
                    continue;
                }
                // The inherited window participates in the same 64MiB budget
                // before this attempt writes any backup or fence ownership.
                total = total.saturating_add(expected.byte_length);
                limit(total <= MAX_TOTAL_LAYER_BYTES)?;
                let bytes = atomic::read(&backup_path(dir, author, *revision), MAX_LAYER_BYTES)?;
                require(
                    bytes.len() == expected.byte_length && hash(&bytes) == expected.byte_hash,
                    "Pending inherited backup digest mismatch",
                )?;
                let layer = AuthorLayer::parse(&bytes, &self.manifest, author)?;
                require(
                    layer.revision == *revision,
                    "Pending inherited backup revision mismatch",
                )?;
                merged.insert(*revision, (layer, bytes));
            }
        }
        let history: Vec<_> = merged.into_values().collect();
        for pair in history.windows(2) {
            require(
                pair[1].0.parent.as_ref() == Some(&pair[0].0.checkpoint()),
                "Invalid protected retained history chain",
            )?;
        }
        require(
            history.last().map(|(layer, _)| layer.checkpoint()) == head,
            "Protected history does not reach current author head",
        )?;
        Ok(history)
    }

    fn legacy_history(&self, author: &str) -> Result<Vec<(AuthorLayer, Vec<u8>)>> {
        self.legacy_history_for_restore(author, None)
    }
    fn legacy_history_for_restore(
        &self,
        author: &str,
        candidate: Option<u64>,
    ) -> Result<Vec<(AuthorLayer, Vec<u8>)>> {
        let dir = self.root.join("annotations").join(author);
        atomic::safe_existing(&dir)?;
        let mut revisions = vec![];
        for (index, entry) in fs::read_dir(&dir).map_err(atomic::io)?.enumerate() {
            limit(index < 256)?;
            let entry = entry.map_err(atomic::io)?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| AppError::invalid("Invalid history filename"))?;
            if name == ".writer.lock" || (name.starts_with('.') && name.ends_with(".tmp")) {
                continue;
            }
            require(
                name.len() == 25
                    && name.ends_with(".json")
                    && name[..20].bytes().all(|b| b.is_ascii_digit()),
                "Invalid history filename",
            )?;
            let revision = name[..20]
                .parse::<u64>()
                .map_err(|_| AppError::invalid("Invalid history revision"))?;
            require(
                (1..=MAX_SAFE_INTEGER).contains(&revision),
                "Unsafe history revision",
            )?;
            revisions.push(revision);
        }
        revisions.sort_unstable();
        // Our own interrupted restoration can leave an older prefix while a
        // newer normal prune removes the next file. Validate the full newest
        // retention window before reconciling only durable restoration owners.
        let first = match (candidate, revisions.last().copied()) {
            (Some(candidate), Some(head)) if head >= candidate => head.saturating_sub(15).max(1),
            _ => 0,
        };
        require(
            revisions
                .windows(2)
                .all(|p| p[0] < first || p[0] + 1 == p[1]),
            "Missing published author revision",
        )?;
        if first > 0 {
            require(
                revisions.iter().filter(|r| **r >= first).count() as u64
                    == revisions.last().unwrap() - first + 1,
                "Incomplete normal retention window",
            )?;
        }
        let mut history: Vec<(AuthorLayer, Vec<u8>)> = vec![];
        let mut total = 0usize;
        for revision in revisions {
            let bytes = atomic::read(&history_path(&self.root, author, revision), MAX_LAYER_BYTES)?;
            total = total.saturating_add(bytes.len());
            limit(total <= MAX_TOTAL_LAYER_BYTES)?;
            let layer = AuthorLayer::parse(&bytes, &self.manifest, author)?;
            require(
                layer.revision == revision,
                "Layer filename revision mismatch",
            )?;
            if let Some((previous, _)) = history.last() {
                require(
                    previous.revision < first
                        || layer.parent.as_ref() == Some(&previous.checkpoint()),
                    "Invalid retained parent chain",
                )?;
            }
            history.push((layer, bytes));
        }
        Ok(history)
    }

    /// Crash recovery is nonblocking with respect to an active upgrader. Taking
    /// both original locks first prevents adopting another process's live log.
    pub fn recover_legacy_upgrade(&self, operation: &str) -> Result<LegacyRecovery> {
        self.recover_legacy_with_drain(operation, None)
    }
    /// The exclusive local publication gate and this exact held stable lease
    /// together prove this process has no old in-flight publish/prune phase.
    pub fn recover_legacy_upgrade_drained(
        &self,
        operation: &str,
        session: &AuthorSession,
    ) -> Result<LegacyRecovery> {
        let _drain = session.try_drain_publications()?;
        self.session_authority(session)?;
        self.recover_legacy_with_drain(operation, Some(session))
    }
    fn recover_legacy_with_drain(
        &self,
        operation: &str,
        drained: Option<&AuthorSession>,
    ) -> Result<LegacyRecovery> {
        let _catalog = atomic::lock(&self.root.join("catalog/.commit.lock"))?;
        let _registration = atomic::lock(&self.root.join("authors/.registration.lock"))?;
        let dir = operation_dir(&self.root, operation)?;
        let mut journal =
            LegacyJournal::parse(&atomic::read(&dir.join("legacy.json"), MAX_LAYER_BYTES)?)?;
        require(
            journal.operation_id == operation && journal.project_id == self.manifest.project_id,
            "Legacy operation identity mismatch",
        )?;
        self.settle_legacy_with_drain(&mut journal, drained)
    }

    fn legacy_is_committed(&self, journal: &LegacyJournal) -> Result<bool> {
        let current = Self::open(&self.root)?;
        require(
            current.manifest.project_id == journal.project_id,
            "Legacy project identity mismatch",
        )?;
        if current.manifest.format_version == CURRENT_COLLABORATION_FORMAT {
            require(
                current.manifest_hash == journal.source_entry_hash,
                "Legacy source entry changed",
            )?;
            return Ok(false);
        }
        let descriptor = super::generation::GenerationDescriptor::parse(&atomic::read(
            &current.metadata_root.join("generation.json"),
            MAX_LAYER_BYTES,
        )?)?;
        if descriptor.receipts.iter().any(|receipt| {
            receipt.legacy_preparation_id.as_deref() == Some(journal.operation_id.as_str())
                && receipt.actor_id == journal.actor_id
                && receipt.source_entry_hash == journal.source_entry_hash
        }) {
            return Ok(true);
        }
        require(
            descriptor
                .receipts
                .iter()
                .any(|receipt| receipt.source_entry_hash == journal.source_entry_hash),
            "Generation has no matching legacy upgrade source receipt",
        )?;
        Ok(false)
    }

    fn settle_legacy_locked(&self, journal: &mut LegacyJournal) -> Result<LegacyRecovery> {
        self.settle_legacy_with_drain(journal, None)
    }
    fn settle_legacy_with_drain(
        &self,
        journal: &mut LegacyJournal,
        drained: Option<&AuthorSession>,
    ) -> Result<LegacyRecovery> {
        self.settle_legacy_controlled(journal, drained, &mut |_, _| Ok(()))
    }
    fn settle_legacy_controlled(
        &self,
        journal: &mut LegacyJournal,
        drained: Option<&AuthorSession>,
        before_restore: &mut impl FnMut(&str, u64) -> Result<()>,
    ) -> Result<LegacyRecovery> {
        let dir = operation_dir(&self.root, &journal.operation_id)?;
        // Revalidate durable owner identity even when called with a live capability.
        let durable =
            LegacyJournal::parse(&atomic::read(&dir.join("legacy.json"), MAX_LAYER_BYTES)?)?;
        require(
            durable.owner_id == journal.owner_id
                && durable.project_id == journal.project_id
                && durable.operation_id == journal.operation_id
                && durable.source_entry_hash == journal.source_entry_hash,
            "Legacy journal ownership changed",
        )?;
        *journal = durable;
        for author in &journal.authors {
            require(
                hash(&fence_bytes(journal, author)?) == author.fence_hash,
                "Legacy fence ownership digest mismatch",
            )?;
        }
        if self.legacy_is_committed(journal)? {
            for author in &journal.authors {
                require(
                    atomic::read(
                        &history_path(&self.root, &author.author_id, author.candidate_revision),
                        MAX_LAYER_BYTES,
                    )? == fence_bytes(journal, author)?,
                    "Committed collision fence changed",
                )?;
            }
            journal.status = LegacyStatus::Committed;
            save(&dir, journal)?;
            // User-data cleanup belongs to the later committed cleanup phase.
            // The numeric collision fence and payload-free owner log stay forever.
            return Ok(LegacyRecovery::Committed);
        }
        if Self::open(&self.root)?.manifest.format_version == GENERATION_COLLABORATION_FORMAT {
            // legacy_is_committed already verified an authoritative receipt
            // for this exact source entry. Preserve older pending ownership;
            // no backup restoration is legal after any winning entry switch.
            return Ok(LegacyRecovery::Superseded);
        }
        require(
            journal.status != LegacyStatus::Committed,
            "Cannot roll back committed legacy upgrade",
        )?;
        if journal.status == LegacyStatus::RolledBack {
            return Ok(LegacyRecovery::RolledBack);
        }
        let source = Self::open(&self.root)?;
        // Validate every backup before removing any marker. Never use a corrupt
        // or caller-edited recovery record to authorize a destructive action.
        for author in &journal.authors {
            if !author.retired {
                source.validate_legacy_backups(&dir, author)?;
            }
        }
        journal.status = LegacyStatus::RollbackPending;
        save(&dir, journal)?;
        for index in 0..journal.authors.len() {
            let author = &journal.authors[index];
            let path = history_path(&self.root, &author.author_id, author.candidate_revision);
            let marker = fence_bytes(journal, author)?;
            if path.try_exists().map_err(atomic::io)? {
                let bytes = atomic::read(&path, MAX_LAYER_BYTES)?;
                if bytes == marker {
                    require(
                        author.backups_ready,
                        "Fence was published before backup sync",
                    )?;
                    journal.authors[index].fenced = true;
                    save(&dir, journal)?; // persist restoration responsibility before unlink
                    atomic::safe_existing(&path)?;
                    fs::remove_file(&path).map_err(atomic::io)?;
                } else {
                    // A genuine layer won compare-create, or was published after
                    // rollback released the path. Preserve and validate it.
                    let layer = AuthorLayer::parse(&bytes, &source.manifest, &author.author_id)?;
                    require(
                        layer.revision == author.candidate_revision,
                        "Recovery candidate revision mismatch",
                    )?;
                }
            }
        }
        for index in 0..journal.authors.len() {
            if !journal.authors[index].retired {
                source.restore_legacy_history(&dir, journal, index, before_restore)?;
                let author = journal.authors[index].clone();
                let lease = self
                    .root
                    .join("annotations")
                    .join(&author.author_id)
                    .join(".writer.lock");
                if author.backups.is_empty()
                    || drained
                        .is_some_and(|session| session.identity().author_id == author.author_id)
                {
                    if !author.backups.is_empty() {
                        source.session_authority(drained.unwrap())?;
                        require(
                            atomic::lock_identity(&lease)? == author.lease_hash,
                            "Stable writer lease identity changed",
                        )?;
                        source.restore_legacy_history(&dir, journal, index, before_restore)?;
                    }
                    journal.authors[index].retired = true;
                    save(&dir, journal)?;
                    self.remove_legacy_backups(&dir, &journal.authors[index])?;
                    continue;
                }
                match atomic::lock(&lease) {
                    Ok(proof) => {
                        atomic::verify_lock_path(&lease, &proof)?;
                        require(
                            atomic::lock_identity(&lease)? == author.lease_hash,
                            "Stable writer lease identity changed",
                        )?;
                        // A prune may have completed after the first restoration.
                        // Under this lifetime lease no old worker remains.
                        source.restore_legacy_history(&dir, journal, index, before_restore)?;
                        journal.authors[index].retired = true;
                        save(&dir, journal)?;
                        self.remove_legacy_backups(&dir, &journal.authors[index])?;
                    }
                    Err(error) if error.code == ErrorCode::ProjectLocked => (),
                    Err(error) => return Err(error),
                }
            } else {
                self.remove_legacy_backups(&dir, &journal.authors[index])?;
            }
        }
        if journal.authors.iter().all(|a| a.retired) {
            journal.status = LegacyStatus::RolledBack;
            save(&dir, journal)?;
            Ok(LegacyRecovery::RolledBack)
        } else {
            Ok(LegacyRecovery::RollbackPending)
        }
    }

    fn validate_legacy_backups(&self, dir: &Path, author: &LegacyAuthor) -> Result<()> {
        let mut head = None;
        let mut total = 0usize;
        let mut layers = std::collections::HashMap::new();
        for backup in &author.backups {
            let path = backup_path(dir, &author.author_id, backup.revision);
            if !author.backups_ready && !path.try_exists().map_err(atomic::io)? {
                continue;
            }
            let bytes = atomic::read(&path, MAX_LAYER_BYTES)?;
            total = total.saturating_add(bytes.len());
            limit(total <= MAX_TOTAL_LAYER_BYTES)?;
            require(
                bytes.len() == backup.byte_length && hash(&bytes) == backup.byte_hash,
                "Legacy history backup digest mismatch",
            )?;
            let layer = AuthorLayer::parse(&bytes, &self.manifest, &author.author_id)?;
            require(
                layer.revision == backup.revision,
                "Legacy history backup revision mismatch",
            )?;
            if Some(backup.revision) == author.predecessor.as_ref().map(|p| p.revision) {
                head = Some(layer.checkpoint());
            }
            layers.insert(layer.revision, layer);
        }
        for pair in author.retained.windows(2) {
            if let (Some(previous), Some(next)) = (layers.get(&pair[0]), layers.get(&pair[1])) {
                require(
                    next.parent.as_ref() == Some(&previous.checkpoint()),
                    "Legacy backup parent chain mismatch",
                )?;
            }
        }
        require(
            !author.backups_ready || head == author.predecessor,
            "Legacy backup predecessor mismatch",
        )
    }
    fn restore_legacy_history(
        &self,
        dir: &Path,
        journal: &mut LegacyJournal,
        index: usize,
        before_restore: &mut impl FnMut(&str, u64) -> Result<()>,
    ) -> Result<()> {
        let author = journal.authors[index].clone();
        if !author.fenced {
            return Ok(());
        }
        let history =
            self.legacy_history_for_restore(&author.author_id, Some(author.candidate_revision))?;
        let head = history.last().map(|(layer, _)| layer.checkpoint());
        if head
            .as_ref()
            .is_some_and(|head| head.revision >= author.candidate_revision)
        {
            // Normal publications after rollback own their own retention policy;
            // do not resurrect history they legitimately pruned.
            return self.reconcile_legacy_restorations(&author, head.as_ref().unwrap().revision);
        }
        require(
            head == author.predecessor,
            "Legacy rollback source head changed",
        )?;
        for revision in author.retained.iter().rev().take(16).rev() {
            let path = history_path(&self.root, &author.author_id, *revision);
            before_restore(&author.author_id, *revision)?;
            let bytes = atomic::read(
                &backup_path(dir, &author.author_id, *revision),
                MAX_LAYER_BYTES,
            )?;
            if path.try_exists().map_err(atomic::io)? {
                require(
                    atomic::read(&path, MAX_LAYER_BYTES)? == bytes,
                    "Cannot overwrite different rollback history",
                )?;
                continue;
            }
            if !journal.authors[index]
                .restoration_candidates
                .contains(revision)
            {
                journal.authors[index]
                    .restoration_candidates
                    .push(*revision);
                save(dir, journal)?;
            }
            match atomic::publish_new(&path, &bytes, None, None) {
                Ok(()) => (),
                Err(error) if error.code == ErrorCode::RevisionConflict => {
                    require(
                        atomic::read(&path, MAX_LAYER_BYTES)? == bytes,
                        "Cannot overwrite different rollback history",
                    )?;
                }
                Err(error) => return Err(error),
            }
        }
        if !journal.authors[index].restoration_candidates.is_empty() {
            let after = self
                .legacy_history_for_restore(&author.author_id, Some(author.candidate_revision))?;
            if let Some((head, _)) = after.last() {
                if head.revision >= author.candidate_revision {
                    // A new normal publication can start after our source-head
                    // check. Reconcile only files this restoration created, and
                    // only those outside that newer head's normal 16-layer window.
                    self.reconcile_legacy_restorations(&journal.authors[index], head.revision)?;
                }
            }
        }
        Ok(())
    }
    fn reconcile_legacy_restorations(&self, author: &LegacyAuthor, head: u64) -> Result<()> {
        let first_retained = head.saturating_sub(15).max(1);
        for revision in &author.restoration_candidates {
            if *revision >= first_retained {
                continue;
            }
            let path = history_path(&self.root, &author.author_id, *revision);
            if !path.try_exists().map_err(atomic::io)? {
                continue;
            }
            let expected = author
                .backups
                .iter()
                .find(|b| b.revision == *revision)
                .unwrap();
            let bytes = atomic::read(&path, MAX_LAYER_BYTES)?;
            require(
                bytes.len() == expected.byte_length && hash(&bytes) == expected.byte_hash,
                "Restored history ownership changed",
            )?;
            fs::remove_file(path).map_err(atomic::io)?;
        }
        self.legacy_history(&author.author_id)?;
        Ok(())
    }
    fn remove_legacy_backups(&self, dir: &Path, author: &LegacyAuthor) -> Result<()> {
        for backup in &author.backups {
            let path = backup_path(dir, &author.author_id, backup.revision);
            if !path.try_exists().map_err(atomic::io)? {
                continue;
            }
            let bytes = atomic::read(&path, MAX_LAYER_BYTES)?;
            require(
                bytes.len() == backup.byte_length && hash(&bytes) == backup.byte_hash,
                "Cannot remove foreign rollback backup",
            )?;
            fs::remove_file(path).map_err(atomic::io)?;
        }
        Ok(())
    }
}
