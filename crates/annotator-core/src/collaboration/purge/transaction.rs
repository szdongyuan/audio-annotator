//! Native fixed-scope capabilities and the single logical purge commit boundary.
use super::{
    generation::{GenerationDescriptor, GenerationEntry},
    journal::{
        JournalStatus, PurgeBlockReason, PurgeJournal, PurgeReceipt, PurgeRequestBinding,
        PurgeRetained, RetiredMedia,
    },
    legacy::LegacyUpgrade,
    projection, Eligibility, PurgeAuthority,
};
use crate::{
    collaboration::{atomic, consts::*, validation::*, AuthorSession, CollaborationRepository},
    error::{AppError, ErrorCode, Result},
    media::identity::check_cancel,
};
use serde::Serialize;
use std::{collections::HashSet, fs, path::PathBuf, sync::atomic::AtomicBool};

pub use super::journal::PurgeSelection;

/// Native-only permission capability. No Deserialize or public constructor.
pub struct PurgePreview {
    root: PathBuf,
    project_id: String,
    actor_id: String,
    runtime: String,
    operation: String,
    request_hash: String,
    selection: PurgeSelection,
    source_entry_hash: String,
    state_digest: String,
    requested_ids: Vec<String>,
    eligible: HashSet<String>,
    retained: Vec<PurgeRetained>,
    media: Vec<crate::collaboration::PublicMedia>,
    source_format: u32,
}
impl PurgePreview {
    pub fn media(&self) -> &[crate::collaboration::PublicMedia] {
        &self.media
    }
    pub fn source_format(&self) -> u32 {
        self.source_format
    }
    pub fn requested_ids(&self) -> &[String] {
        &self.requested_ids
    }
    pub fn eligible_count(&self) -> usize {
        self.eligible.len()
    }
    pub fn state_digest(&self) -> &str {
        &self.state_digest
    }
    pub fn operation_id(&self) -> &str {
        &self.operation
    }
    pub fn project_id(&self) -> &str {
        &self.project_id
    }
    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }
    pub fn runtime(&self) -> &str {
        &self.runtime
    }
    pub fn retained(&self) -> &[PurgeRetained] {
        &self.retained
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct PurgeResult {
    pub operation_id: String,
    pub removed_ids: Vec<String>,
    pub retained_ids: Vec<String>,
    pub retained: Vec<PurgeRetained>,
    /// An authoritative receipt exists even when postcommit maintenance failed.
    pub committed: bool,
    pub maintenance_error: Option<AppError>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurgeBoundary {
    BeforePrepare,
    AfterCandidatePartialWrite,
    AfterCandidateStaged,
    AfterCandidatePublication,
    BeforeSync,
    BeforeEntryReplace,
    AfterEntryReplace,
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| AppError::invalid("Cannot encode purge metadata"))?;
    limit(bytes.len() <= MAX_LAYER_BYTES)?;
    Ok(bytes)
}
fn descriptor(repo: &CollaborationRepository) -> Result<Option<GenerationDescriptor>> {
    if repo.manifest.format_version == GENERATION_COLLABORATION_FORMAT {
        Ok(Some(GenerationDescriptor::parse(&atomic::read(
            &repo.metadata_root.join("generation.json"),
            MAX_LAYER_BYTES,
        )?)?))
    } else {
        Ok(None)
    }
}
fn result(
    operation: &str,
    removed: &[String],
    retained: &[PurgeRetained],
    committed: bool,
) -> PurgeResult {
    PurgeResult {
        operation_id: operation.into(),
        removed_ids: removed.to_vec(),
        retained_ids: retained.iter().map(|r| r.media_id.clone()).collect(),
        retained: retained.to_vec(),
        committed,
        maintenance_error: None,
    }
}
fn retentions(
    preview: &PurgePreview,
    authority: &PurgeAuthority,
    removed: &[String],
) -> Result<Vec<PurgeRetained>> {
    preview
        .requested_ids
        .iter()
        .filter(|id| !removed.contains(id))
        .map(|id| {
            Ok(PurgeRetained {
                media_id: id.clone(),
                reason: match authority.classify(id) {
                    Eligibility::NotInRecycle => PurgeBlockReason::NotInRecycle,
                    Eligibility::OtherAuthorAnnotation => PurgeBlockReason::OtherAuthorAnnotation,
                    Eligibility::Allowed => preview
                        .retained
                        .iter()
                        .find(|r| &r.media_id == id)
                        .map(|r| r.reason)
                        .ok_or_else(|| {
                            AppError::invalid("Purge retained target has no preview ownership")
                        })?,
                },
            })
        })
        .collect()
}
fn receipt_result(
    repo: &CollaborationRepository,
    operation: &str,
    actor: &str,
    request_hash: &str,
) -> Result<Option<PurgeResult>> {
    let Some(generation) = descriptor(repo)? else {
        return Ok(None);
    };
    if let Some(receipt) = generation
        .receipts
        .iter()
        .find(|r| r.operation_id == operation)
    {
        require(
            receipt.actor_id == actor && receipt.request_hash == request_hash,
            "Purge operation ID reused with another request or actor",
        )?;
        return Ok(Some(result(
            operation,
            &receipt.removed_ids,
            &receipt.retained,
            true,
        )));
    }
    Ok(None)
}
pub(super) fn save_journal(repo: &CollaborationRepository, journal: &PurgeJournal) -> Result<()> {
    let bytes = encode(journal)?;
    PurgeJournal::parse(&bytes)?;
    atomic::ensure_dir(&repo.root.join("maintenance"))?;
    let dir = repo
        .root
        .join("maintenance")
        .join(&journal.receipt.operation_id);
    atomic::ensure_dir(&dir)?;
    let path = dir.join("purge.json");
    if path.try_exists().map_err(atomic::io)? {
        let old = PurgeJournal::parse(&atomic::read(&path, MAX_LAYER_BYTES)?)?;
        require(
            old.project_id == journal.project_id
                && old.receipt.actor_id == journal.receipt.actor_id
                && old.receipt.operation_id == journal.receipt.operation_id
                && old.receipt.request_hash == journal.receipt.request_hash
                && old.receipt.requested_ids == journal.receipt.requested_ids,
            "Purge journal operation identity mismatch",
        )?;
        require(
            old.status == JournalStatus::Preparing || old.receipt == journal.receipt,
            "Cannot replace a committed purge journal",
        )?;
        atomic::replace_metadata(&path, &bytes)
    } else {
        atomic::publish_new(&path, &bytes, None, None)
    }
}
fn pending_journal(
    repo: &CollaborationRepository,
    operation: &str,
    actor: &str,
    request_hash: &str,
) -> Result<Option<PurgeJournal>> {
    let path = repo
        .root
        .join("maintenance")
        .join(operation)
        .join("purge.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(atomic::io(error)),
        Ok(_) => (),
    }
    let journal = PurgeJournal::parse(&atomic::read(&path, MAX_LAYER_BYTES)?)?;
    require(
        journal.project_id == repo.manifest.project_id
            && journal.receipt.operation_id == operation
            && journal.receipt.actor_id == actor
            && journal.receipt.request_hash == request_hash,
        "Purge operation ID reused with another request or actor",
    )?;
    require(
        journal.status == JournalStatus::Preparing,
        "Committed purge journal has no authoritative receipt",
    )?;
    require(
        journal.receipt.source_entry_hash == repo.manifest_hash,
        "Pending purge source entry changed",
    )?;
    Ok(Some(journal))
}

fn request_binding(
    repo: &CollaborationRepository,
    operation: &str,
    actor: &str,
    request_hash: &str,
) -> Result<Option<PurgeRequestBinding>> {
    let path = repo
        .root
        .join("maintenance")
        .join(operation)
        .join("request.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(atomic::io(error)),
        Ok(_) => (),
    }
    let binding = PurgeRequestBinding::parse(&atomic::read(&path, MAX_LAYER_BYTES)?)?;
    require(
        binding.project_id == repo.manifest.project_id
            && binding.operation_id == operation
            && binding.actor_id == actor
            && binding.request_hash == request_hash,
        "Purge operation ID reused with another request or actor",
    )?;
    require(
        binding.source_entry_hash == repo.manifest_hash,
        "Accepted purge source entry changed",
    )?;
    Ok(Some(binding))
}

fn accept_request(repo: &CollaborationRepository, preview: &PurgePreview) -> Result<()> {
    let binding = PurgeRequestBinding {
        kind: PURGE_REQUEST_KIND.into(),
        format_version: 1,
        project_id: preview.project_id.clone(),
        operation_id: preview.operation.clone(),
        actor_id: preview.actor_id.clone(),
        selection: preview.selection.clone(),
        request_hash: preview.request_hash.clone(),
        source_entry_hash: preview.source_entry_hash.clone(),
        state_digest: preview.state_digest.clone(),
        requested_ids: preview.requested_ids.clone(),
        eligible_ids: preview
            .requested_ids
            .iter()
            .filter(|id| preview.eligible.contains(*id))
            .cloned()
            .collect(),
        retained: preview.retained.clone(),
    };
    let bytes = encode(&binding)?;
    PurgeRequestBinding::parse(&bytes)?;
    atomic::ensure_dir(&repo.root.join("maintenance"))?;
    let dir = repo.root.join("maintenance").join(&preview.operation);
    atomic::ensure_dir(&dir)?;
    // Immutable compare-create decides the accepted confirmation when two native
    // previews race. A conflicting or broader preview can never replace it.
    match atomic::publish_new(&dir.join("request.json"), &bytes, None, None) {
        Ok(()) => (),
        Err(error) if error.code == ErrorCode::RevisionConflict => (),
        Err(error) => return Err(error),
    }
    let accepted = request_binding(
        repo,
        &preview.operation,
        &preview.actor_id,
        &preview.request_hash,
    )?
    .ok_or_else(|| AppError::invalid("Accepted purge request disappeared"))?;
    require(
        accepted.requested_ids == preview.requested_ids
            && preview
                .eligible
                .iter()
                .all(|id| accepted.eligible_ids.contains(id)),
        "Purge preview exceeds the accepted confirmation; refresh it",
    )
}

impl CollaborationRepository {
    /// Read the immutable result from current verified entry authority. A
    /// standalone maintenance journal never proves a logical commit.
    pub fn purge_committed_result(&self, operation: &str) -> Result<Option<PurgeResult>> {
        uuid(operation)?;
        let current = Self::open(&self.root)?;
        require(
            current.manifest.project_id == self.manifest.project_id,
            "Purge project identity changed",
        )?;
        Ok(descriptor(&current)?
            .and_then(|g| g.receipts.into_iter().find(|r| r.operation_id == operation))
            .map(|r| result(operation, &r.removed_ids, &r.retained, true)))
    }
    pub fn preview_purge(
        &self,
        session: &AuthorSession,
        runtime: &str,
        operation: &str,
        selection: PurgeSelection,
    ) -> Result<PurgePreview> {
        uuid(operation)?;
        require(
            !runtime.is_empty() && runtime.len() <= 1024,
            "Invalid purge runtime binding",
        )?;
        let current = Self::open(&self.root)?;
        require(
            current.manifest.project_id == self.manifest.project_id
                && current.manifest.name == self.manifest.name
                && current.manifest.created_at == self.manifest.created_at,
            "Purge project identity changed",
        )?;
        current.session_authority(session)?;
        let selection = match selection {
            PurgeSelection::Selected(mut ids) => {
                super::journal::media_ids(&ids)?;
                ids.sort();
                PurgeSelection::Selected(ids)
            }
            PurgeSelection::All => PurgeSelection::All,
        };
        let actor = session.identity().author_id.clone();
        let request_hash = PurgeRequestBinding::request_hash(
            &current.manifest.project_id,
            &actor,
            operation,
            &selection,
        )?;
        let (requested_ids, eligible, state_digest, retained) =
            if let Some(existing) = receipt_result(&current, operation, &actor, &request_hash)? {
                let mut ids = existing.removed_ids.clone();
                ids.extend(existing.retained_ids);
                ids.sort();
                (
                    ids,
                    existing.removed_ids.into_iter().collect(),
                    current.manifest_hash.clone(),
                    existing.retained,
                )
            } else {
                let binding = request_binding(&current, operation, &actor, &request_hash)?;
                let authority = current.purge_authority(session)?;
                let pending = pending_journal(&current, operation, &actor, &request_hash)?;
                require(
                    pending.as_ref().is_none_or(|j| {
                        binding
                            .as_ref()
                            .is_some_and(|b| b.requested_ids == j.receipt.requested_ids)
                    }),
                    "Purge candidate has no accepted request binding",
                )?;
                let mut ids = if let Some(binding) = &binding {
                    binding.requested_ids.clone()
                } else {
                    match &selection {
                        PurgeSelection::Selected(ids) => ids.clone(),
                        PurgeSelection::All => authority
                            .recycle
                            .trashed
                            .iter()
                            .map(|m| m.media_id.clone())
                            .collect(),
                    }
                };
                ids.sort();
                super::journal::media_ids(&ids)?;
                let eligible: HashSet<_> = ids
                    .iter()
                    .filter(|id| {
                        authority.classify(id) == Eligibility::Allowed
                            && binding.as_ref().is_none_or(|b| b.eligible_ids.contains(id))
                    })
                    .cloned()
                    .collect();
                let retained = ids
                    .iter()
                    .filter(|id| !eligible.contains(*id))
                    .map(|id| PurgeRetained {
                        media_id: id.clone(),
                        reason: if authority.classify(id) == Eligibility::NotInRecycle {
                            PurgeBlockReason::NotInRecycle
                        } else {
                            binding
                                .as_ref()
                                .and_then(|b| b.retained.iter().find(|r| &r.media_id == id))
                                .map(|r| r.reason)
                                .unwrap_or(PurgeBlockReason::OtherAuthorAnnotation)
                        },
                    })
                    .collect();
                (ids, eligible, authority.state_digest().into(), retained)
            };
        Ok(PurgePreview {
            media: current
                .manifest
                .media
                .iter()
                .filter(|m| requested_ids.contains(&m.id))
                .cloned()
                .collect(),
            source_format: current.manifest.format_version,
            root: current.root,
            project_id: current.manifest.project_id,
            actor_id: actor,
            runtime: runtime.into(),
            operation: operation.into(),
            request_hash,
            selection,
            source_entry_hash: current.manifest_hash,
            state_digest,
            requested_ids,
            eligible,
            retained,
        })
    }
    pub fn commit_purge(
        &self,
        session: &AuthorSession,
        runtime: &str,
        preview: &PurgePreview,
        cancel: &AtomicBool,
    ) -> Result<PurgeResult> {
        self.commit_purge_controlled(session, runtime, preview, cancel, |_| Ok(()))
    }
    pub fn commit_purge_controlled(
        &self,
        session: &AuthorSession,
        runtime: &str,
        preview: &PurgePreview,
        cancel: &AtomicBool,
        boundary: impl FnMut(PurgeBoundary) -> Result<()>,
    ) -> Result<PurgeResult> {
        self.commit_purge_guarded_controlled(
            session,
            runtime,
            preview,
            cancel,
            boundary,
            |_| Ok(()),
            || Ok(()),
        )
    }
    /// Native lifecycle validation returns a guard held only over the final
    /// entry switch. Preparation never holds the application state mutex.
    #[allow(clippy::too_many_arguments)]
    pub fn commit_purge_guarded_controlled<Guard>(
        &self,
        session: &AuthorSession,
        runtime: &str,
        preview: &PurgePreview,
        cancel: &AtomicBool,
        mut boundary: impl FnMut(PurgeBoundary) -> Result<()>,
        legacy_boundary: impl FnMut(super::legacy::LegacyBoundary) -> Result<()>,
        before_commit: impl FnOnce() -> Result<Guard>,
    ) -> Result<PurgeResult> {
        require(
            preview.root == self.root
                && preview.project_id == self.manifest.project_id
                && preview.actor_id == session.identity().author_id
                && preview.runtime == runtime,
            "Purge capability binding mismatch",
        )?;
        let current = Self::open(&self.root)?;
        current.session_authority(session)?;
        if let Some(existing) = receipt_result(
            &current,
            &preview.operation,
            &preview.actor_id,
            &preview.request_hash,
        )? {
            return Ok(existing);
        }
        require(
            current.manifest_hash == preview.source_entry_hash,
            "Purge source generation changed; refresh the preview",
        )?;
        check_cancel(cancel)?;
        // Acceptance is durable before complete-author reads, legacy fences,
        // retained-history validation, or any candidate-generation I/O can fail.
        // It constrains retries only and grants no committed retirement authority.
        accept_request(&current, preview)?;
        let initial = current.purge_authority(session)?;
        if !preview
            .requested_ids
            .iter()
            .any(|id| preview.eligible.contains(id) && initial.classify(id) == Eligibility::Allowed)
        {
            return Ok(result(
                &preview.operation,
                &[],
                &retentions(preview, &initial, &[])?,
                false,
            ));
        }
        if current.manifest.format_version == crate::collaboration::CURRENT_COLLABORATION_FORMAT {
            let attempt = uuid::Uuid::new_v4().to_string();
            let upgrade = current.prepare_legacy_upgrade_controlled(
                session,
                &attempt,
                cancel,
                legacy_boundary,
            )?;
            let outcome = current.prepare_purge_generation(
                session,
                preview,
                upgrade.authority(),
                Some(&upgrade),
                cancel,
                &mut boundary,
                before_commit,
            );
            match outcome {
                Ok(mut outcome) if outcome.committed => {
                    // Receipt authority precedes maintenance; never rollback.
                    if let Err(error) = upgrade.record_committed() {
                        outcome.maintenance_error = Some(error);
                    }
                    Ok(outcome)
                }
                Ok(outcome) => {
                    upgrade.rollback()?;
                    Ok(outcome)
                }
                Err(mut error) => {
                    if let Err(rollback) = upgrade.rollback() {
                        error.details = Some(
                            serde_json::json!({"rollbackError":rollback,"operationId":preview.operation}),
                        );
                    }
                    Err(error)
                }
            }
        } else {
            let _catalog = atomic::short_lock(&current.root.join("catalog/.commit.lock"))?;
            let _registration =
                atomic::short_lock(&current.root.join("authors/.registration.lock"))?;
            current.session_authority(session)?;
            let authority = current.purge_authority(session)?;
            current.prepare_purge_generation(
                session,
                preview,
                &authority,
                None,
                cancel,
                &mut boundary,
                before_commit,
            )
        }
    }

    /// Caller owns catalog then registration locks, directly or via LegacyUpgrade.
    #[allow(clippy::too_many_arguments)]
    fn prepare_purge_generation<Guard>(
        &self,
        session: &AuthorSession,
        preview: &PurgePreview,
        authority: &PurgeAuthority,
        legacy: Option<&LegacyUpgrade<'_>>,
        cancel: &AtomicBool,
        boundary: &mut impl FnMut(PurgeBoundary) -> Result<()>,
        before_commit: impl FnOnce() -> Result<Guard>,
    ) -> Result<PurgeResult> {
        let removed: Vec<_> = preview
            .requested_ids
            .iter()
            .filter(|id| {
                preview.eligible.contains(*id) && authority.classify(id) == Eligibility::Allowed
            })
            .cloned()
            .collect();
        let retained = retentions(preview, authority, &removed)?;
        if removed.is_empty() {
            return Ok(result(&preview.operation, &[], &retained, false));
        }
        check_cancel(cancel)?;
        boundary(PurgeBoundary::BeforePrepare)?;
        let source = self.reload_catalog()?;
        let source_bytes = atomic::read(&self.root.join("collaboration.json"), MAX_LAYER_BYTES)?;
        require(
            hash(&source_bytes) == preview.source_entry_hash,
            "Purge source entry changed",
        )?;
        let prior = descriptor(&source)?;
        let generation_id = uuid::Uuid::new_v4().to_string();
        let removed_set: HashSet<_> = removed.iter().cloned().collect();
        let mut manifest = source.manifest.clone();
        manifest.format_version = GENERATION_COLLABORATION_FORMAT;
        manifest.media.retain(|m| !removed_set.contains(&m.id));
        manifest.validate()?;
        let mut organization = source.organization.clone();
        organization
            .media
            .retain(|m| !removed_set.contains(&m.media_id));
        organization.revision += 1;
        organization.validate()?;
        let mut recycle = authority.recycle.clone();
        recycle
            .trashed
            .retain(|m| !removed_set.contains(&m.media_id));
        recycle.revision += 1;
        recycle.validate(&manifest.project_id)?;
        let mut receipts = prior
            .as_ref()
            .map(|g| g.receipts.clone())
            .unwrap_or_default();
        let mut retired = prior
            .as_ref()
            .map(|g| g.retired.clone())
            .unwrap_or_default();
        let receipt = PurgeReceipt {
            operation_id: preview.operation.clone(),
            cleanup_manifest_hash: super::cleanup::capture(
                &source,
                &preview.operation,
                &removed,
                &generation_id,
                legacy.map(|upgrade| upgrade.operation_id()),
            )?,
            legacy_preparation_id: legacy.map(|u| u.operation_id().to_owned()),
            actor_id: preview.actor_id.clone(),
            request_hash: preview.request_hash.clone(),
            source_entry_hash: hash(&source_bytes),
            generation_id: generation_id.clone(),
            requested_ids: preview.requested_ids.clone(),
            removed_ids: removed.clone(),
            retained: retained.clone(),
        };
        receipt.validate()?;
        let mut journal = PurgeJournal {
            kind: PURGE_JOURNAL_KIND.into(),
            format_version: 1,
            project_id: manifest.project_id.clone(),
            status: JournalStatus::Preparing,
            receipt: receipt.clone(),
        };
        receipts.push(receipt);
        retired.extend(removed.iter().map(|id| RetiredMedia {
            media_id: id.clone(),
            operation_id: preview.operation.clone(),
        }));
        // Validate all historical payloads before creating generation files.
        let mut histories = vec![];
        let mut budget = MAX_TOTAL_LAYER_BYTES;
        for author in &authority.snapshot.authors {
            let id = &author.identity.author_id;
            let history = if let Some(legacy) = legacy {
                let history = legacy.retained_history(id)?;
                for layer in &history {
                    let size = encode(layer)?.len();
                    limit(size <= budget)?;
                    budget -= size;
                }
                history
            } else {
                projection::retained_history(&source, id, &mut budget)?
            };
            require(
                history.last().map(|l| l.checkpoint())
                    == author.layer.as_ref().map(|l| l.checkpoint()),
                "History does not match frozen authority",
            )?;
            histories.push((id.clone(), history));
        }
        save_journal(self, &journal)?;
        atomic::ensure_dir(&self.root.join("state"))?;
        let dir = self.root.join("state").join(&generation_id);
        fs::create_dir(&dir).map_err(atomic::io)?;
        super::cleanup::register_candidate(&source, &preview.operation, &generation_id)?;
        for name in ["catalog", "annotations", "provenance"] {
            fs::create_dir(dir.join(name)).map_err(atomic::io)?;
        }
        let mut mappings = vec![];
        for (author, history) in histories {
            let author_dir = dir.join("annotations").join(&author);
            fs::create_dir(&author_dir).map_err(atomic::io)?;
            let (layers, map) = projection::project_history(history, &manifest, &removed_set)?;
            mappings.extend(map);
            for layer in layers {
                super::cleanup::publish_candidate(
                    &source,
                    &preview.operation,
                    &generation_id,
                    &author_dir.join(format!("{:020}.json", layer.revision)),
                    &encode(&layer)?,
                    cancel,
                    boundary,
                )?;
            }
        }
        for media in &manifest.media {
            let filename = format!("{}.json", media.id);
            let bytes = atomic::read(&source.metadata_root.join("catalog").join(&filename), 65536)?;
            super::cleanup::publish_candidate(
                &source,
                &preview.operation,
                &generation_id,
                &dir.join("catalog").join(filename),
                &bytes,
                cancel,
                boundary,
            )?;
        }
        super::cleanup::publish_candidate(
            &source,
            &preview.operation,
            &generation_id,
            &dir.join("organization.json"),
            &crate::collaboration::organization::encode(&organization)?,
            cancel,
            boundary,
        )?;
        super::cleanup::publish_candidate(
            &source,
            &preview.operation,
            &generation_id,
            &dir.join("recycle.json"),
            &encode(&recycle)?,
            cancel,
            boundary,
        )?;
        super::cleanup::publish_candidate(
            &source,
            &preview.operation,
            &generation_id,
            &dir.join("source-entry.json"),
            &source_bytes,
            cancel,
            boundary,
        )?;
        projection::preserve_provenance(&source, &dir, &source_bytes, cancel)?;
        let descriptor = GenerationDescriptor {
            kind: GENERATION_KIND.into(),
            format_version: 1,
            project_id: manifest.project_id.clone(),
            generation_id: generation_id.clone(),
            source_entry_hash: hash(&source_bytes),
            source_generation: prior.map(|g| g.generation_id),
            checkpoint_map: mappings,
            receipts,
            retired,
        };
        let descriptor_bytes = encode(&descriptor)?;
        GenerationDescriptor::parse(&descriptor_bytes)?;
        boundary(PurgeBoundary::BeforeSync)?;
        check_cancel(cancel)?;
        super::cleanup::publish_candidate(
            &source,
            &preview.operation,
            &generation_id,
            &dir.join("generation.json"),
            &descriptor_bytes,
            cancel,
            boundary,
        )?;
        // Immutable publication syncs each file; validate through the real resolver.
        let entry = GenerationEntry {
            kind: manifest.kind,
            format_version: GENERATION_COLLABORATION_FORMAT,
            project_id: manifest.project_id,
            name: manifest.name,
            created_at: manifest.created_at,
            catalog_version: 2,
            metadata_generation: generation_id,
            generation_hash: hash(&descriptor_bytes),
        };
        entry.resolve(&self.root)?;
        crate::collaboration::catalog::load(&self.root, &encode(&entry)?, &mut |_| Ok(()))?;
        self.session_authority(session)?;
        boundary(PurgeBoundary::BeforeEntryReplace)?;
        check_cancel(cancel)?;
        let mut outcome = result(&preview.operation, &removed, &retained, true);
        let entry_bytes = encode(&entry)?;
        {
            let _guard = before_commit()?;
            require(
                atomic::read(&self.root.join("collaboration.json"), MAX_LAYER_BYTES)?
                    == source_bytes,
                "Purge entry changed before commit",
            )?;
            if let Err(error) = atomic::replace_metadata_controlled(
                &self.root.join("collaboration.json"),
                &entry_bytes,
                None,
                Some(cancel),
            ) {
                // At this external I/O boundary an acknowledgement can be lost.
                // Exact entry bytes plus the verified descriptor decide whether
                // rollback remains legal; never infer failure from I/O alone.
                if atomic::read(&self.root.join("collaboration.json"), MAX_LAYER_BYTES)?
                    == entry_bytes
                {
                    entry.resolve(&self.root)?;
                    outcome.maintenance_error = Some(error);
                } else {
                    return Err(error);
                }
            }
        }
        if let Err(error) = boundary(PurgeBoundary::AfterEntryReplace) {
            outcome.maintenance_error = Some(error);
        }
        journal.status = JournalStatus::CommittedPendingCleanup;
        if let Err(error) = save_journal(self, &journal) {
            outcome.maintenance_error = Some(error);
        }
        Ok(outcome)
    }
}
