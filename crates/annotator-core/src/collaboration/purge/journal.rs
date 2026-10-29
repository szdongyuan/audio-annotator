//! Durable operation identities. No filesystem path is accepted by these records.
use crate::{
    collaboration::{
        consts::{PURGE_JOURNAL_KIND, PURGE_REQUEST_KIND},
        validation::*,
    },
    error::{AppError, Result},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JournalStatus {
    Preparing,
    RollbackPending,
    CommittedPendingCleanup,
    Complete,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PurgeBlockReason {
    OtherAuthorAnnotation,
    NotInRecycle,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeRetained {
    pub media_id: String,
    pub reason: PurgeBlockReason,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "mediaIds",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum PurgeSelection {
    Selected(Vec<String>),
    All,
}
/// An accepted confirmation scope, not retirement or successful-result authority.
/// This immutable record precedes any legacy fencing or candidate preparation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeRequestBinding {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub operation_id: String,
    pub actor_id: String,
    pub selection: PurgeSelection,
    pub request_hash: String,
    pub source_entry_hash: String,
    pub state_digest: String,
    pub requested_ids: Vec<String>,
    pub eligible_ids: Vec<String>,
    pub retained: Vec<PurgeRetained>,
}
impl PurgeRequestBinding {
    pub(super) fn request_hash(
        project: &str,
        actor: &str,
        operation: &str,
        selection: &PurgeSelection,
    ) -> Result<String> {
        let bytes = serde_json::to_vec(&(project, actor, operation, selection))
            .map_err(|_| AppError::invalid("Cannot encode purge request"))?;
        limit(bytes.len() <= MAX_LAYER_BYTES)?;
        Ok(hash(&bytes))
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let binding: Self = decode(bytes, MAX_LAYER_BYTES, PURGE_REQUEST_KIND)?;
        uuid(&binding.project_id)?;
        uuid(&binding.operation_id)?;
        uuid(&binding.actor_id)?;
        digest(&binding.request_hash)?;
        digest(&binding.source_entry_hash)?;
        digest(&binding.state_digest)?;
        media_ids(&binding.requested_ids)?;
        media_ids(&binding.eligible_ids)?;
        require(
            binding.requested_ids.windows(2).all(|p| p[0] < p[1])
                && binding.eligible_ids.windows(2).all(|p| p[0] < p[1]),
            "Purge request IDs must be canonical",
        )?;
        if let PurgeSelection::Selected(ids) = &binding.selection {
            require(
                ids == &binding.requested_ids,
                "Selected request does not match accepted scope",
            )?;
        }
        require(
            binding.request_hash
                == Self::request_hash(
                    &binding.project_id,
                    &binding.actor_id,
                    &binding.operation_id,
                    &binding.selection,
                )?,
            "Purge request digest mismatch",
        )?;
        let requested: HashSet<_> = binding.requested_ids.iter().collect();
        let mut covered: HashSet<_> = binding.eligible_ids.iter().collect();
        require(
            covered.iter().all(|id| requested.contains(id)),
            "Purge eligibility exceeds accepted request",
        )?;
        limit(binding.retained.len() <= MAX_MEDIA)?;
        for retained in &binding.retained {
            uuid(&retained.media_id)?;
            require(
                requested.contains(&retained.media_id) && covered.insert(&retained.media_id),
                "Invalid accepted retained ownership",
            )?;
        }
        require(
            covered.len() == requested.len(),
            "Accepted request has incomplete eligibility ownership",
        )?;
        Ok(binding)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeReceipt {
    pub operation_id: String,
    pub cleanup_manifest_hash: String,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub legacy_preparation_id: Option<String>,
    pub actor_id: String,
    pub request_hash: String,
    pub source_entry_hash: String,
    pub generation_id: String,
    pub requested_ids: Vec<String>,
    pub removed_ids: Vec<String>,
    pub retained: Vec<PurgeRetained>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetiredMedia {
    pub media_id: String,
    pub operation_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeJournal {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub status: JournalStatus,
    pub receipt: PurgeReceipt,
}
pub(crate) fn media_ids(ids: &[String]) -> Result<()> {
    limit(ids.len() <= MAX_MEDIA)?;
    let mut seen = HashSet::new();
    for id in ids {
        uuid(id)?;
        require(seen.insert(id), "Duplicate purge media ID")?;
    }
    Ok(())
}
impl PurgeReceipt {
    pub(crate) fn validate(&self) -> Result<()> {
        uuid(&self.operation_id)?;
        digest(&self.cleanup_manifest_hash)?;
        if let Some(attempt) = &self.legacy_preparation_id {
            uuid(attempt)?;
        }
        uuid(&self.actor_id)?;
        uuid(&self.generation_id)?;
        digest(&self.request_hash)?;
        digest(&self.source_entry_hash)?;
        media_ids(&self.requested_ids)?;
        media_ids(&self.removed_ids)?;
        let requested: HashSet<_> = self.requested_ids.iter().collect();
        require(
            !self.removed_ids.is_empty()
                && self.removed_ids.iter().all(|id| requested.contains(id)),
            "Invalid purge result set",
        )?;
        let mut results: HashSet<_> = self.removed_ids.iter().collect();
        limit(self.retained.len() <= MAX_MEDIA)?;
        for item in &self.retained {
            uuid(&item.media_id)?;
            require(
                requested.contains(&item.media_id) && results.insert(&item.media_id),
                "Invalid retained purge result",
            )?;
        }
        require(
            results.len() == requested.len(),
            "Purge result does not cover the fixed request",
        )
    }
}
impl PurgeJournal {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let value: Self = decode(bytes, MAX_LAYER_BYTES, PURGE_JOURNAL_KIND)?;
        uuid(&value.project_id)?;
        value.receipt.validate()?;
        Ok(value)
    }
}

// Preparation never grants the retirement authority of a committed receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyStatus {
    Preparing,
    RollbackPending,
    RolledBack,
    Committed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyBackup {
    pub revision: u64,
    pub byte_hash: String,
    pub byte_length: usize,
}
pub(super) fn validate_legacy_backup_budget(backups: &[LegacyBackup]) -> Result<()> {
    limit(
        backups.iter().fold(0usize, |total, backup| {
            total.saturating_add(backup.byte_length)
        }) <= MAX_TOTAL_LAYER_BYTES,
    )
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyAuthor {
    pub author_id: String,
    pub lease_hash: String,
    pub candidate_revision: u64,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub predecessor: Option<crate::collaboration::Checkpoint>,
    pub fence_hash: String,
    pub backups_ready: bool,
    pub fenced: bool,
    pub retired: bool,
    pub retained: Vec<u64>,
    pub restoration_candidates: Vec<u64>,
    pub backups: Vec<LegacyBackup>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyJournal {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub operation_id: String,
    pub owner_id: String,
    pub actor_id: String,
    pub source_entry_hash: String,
    pub status: LegacyStatus,
    pub authors: Vec<LegacyAuthor>,
}
impl LegacyJournal {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        use crate::{
            collaboration::consts::LEGACY_UPGRADE_KIND, model::validation::MAX_SAFE_INTEGER,
        };
        let value: Self = decode(bytes, MAX_LAYER_BYTES, LEGACY_UPGRADE_KIND)?;
        uuid(&value.project_id)?;
        uuid(&value.operation_id)?;
        uuid(&value.owner_id)?;
        uuid(&value.actor_id)?;
        digest(&value.source_entry_hash)?;
        limit(value.authors.len() <= MAX_AUTHORS)?;
        let mut seen = HashSet::new();
        for author in &value.authors {
            uuid(&author.author_id)?;
            require(seen.insert(&author.author_id), "Duplicate fenced author")?;
            digest(&author.lease_hash)?;
            digest(&author.fence_hash)?;
            require(
                (1..=MAX_SAFE_INTEGER).contains(&author.candidate_revision),
                "Invalid fence revision",
            )?;
            if let Some(predecessor) = &author.predecessor {
                digest(&predecessor.hash)?;
                require(
                    predecessor.revision > 0
                        && predecessor.revision.checked_add(1) == Some(author.candidate_revision),
                    "Invalid fence predecessor",
                )?;
            } else {
                require(author.candidate_revision == 1, "Missing fence predecessor")?;
            }
            limit(author.backups.len() <= 256 && author.retained.len() <= 256)?;
            let mut revisions = HashSet::new();
            for backup in &author.backups {
                require(
                    backup.revision > 0
                        && backup.revision < author.candidate_revision
                        && revisions.insert(backup.revision),
                    "Invalid history backup revision",
                )?;
                digest(&backup.byte_hash)?;
                limit(backup.byte_length <= MAX_LAYER_BYTES)?;
            }
            validate_legacy_backup_budget(&author.backups)?;
            require(
                author
                    .retained
                    .windows(2)
                    .all(|p| p[0].checked_add(1) == Some(p[1]))
                    && author.retained.iter().all(|r| revisions.contains(r)),
                "Invalid retained history",
            )?;
            require(
                author.retained.last().copied() == author.predecessor.as_ref().map(|p| p.revision),
                "History does not reach fence predecessor",
            )?;
            require(
                !author.retired || value.status != LegacyStatus::Preparing,
                "Preparing backup cannot be retired",
            )?;
            require(
                !author.fenced || author.backups_ready,
                "Fence has incomplete backups",
            )?;
            limit(author.restoration_candidates.len() <= 16)?;
            require(
                author.restoration_candidates.is_empty()
                    || (author.fenced
                        && author.backups_ready
                        && matches!(
                            value.status,
                            LegacyStatus::RollbackPending | LegacyStatus::RolledBack
                        )),
                "Restoration has no rollback owner",
            )?;
            let mut restorations = HashSet::new();
            require(
                author.restoration_candidates.iter().all(|r| {
                    restorations.insert(r) && author.retained.iter().rev().take(16).any(|v| v == r)
                }),
                "Invalid restoration ownership",
            )?;
        }
        require(
            value.status != LegacyStatus::RolledBack || value.authors.iter().all(|a| a.retired),
            "Rollback retirement proof is incomplete",
        )?;
        require(
            value.status != LegacyStatus::Committed
                || (!value.authors.is_empty()
                    && value.authors.iter().all(|a| a.fenced && a.backups_ready)),
            "Committed fence preparation is incomplete",
        )?;
        Ok(value)
    }
}
