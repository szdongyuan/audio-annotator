//! App-local durable personal projections. No save/capture/ack method accesses the share.
use super::{atomic, validation::*, *};
use crate::{
    error::{AppError, ErrorCode, Result},
    model::{validation::MAX_SAFE_INTEGER, ProjectDocument},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use crate::project::{LoadReport, RecoveryCandidate, RecoverySource};

const CACHE_KIND: &str = "audio-annotator-private-workspace";
const MAX_CACHE_BYTES: usize = 96 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSource {
    Original,
    Processed,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackPreferences {
    pub volume: f64,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub device_id: Option<String>,
    pub loop_enabled: bool,
    pub source: WorkspaceSource,
}
impl Default for PlaybackPreferences {
    fn default() -> Self {
        Self {
            volume: 0.75,
            device_id: None,
            loop_enabled: false,
            source: WorkspaceSource::Processed,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingPayload {
    pub generation: u64,
    pub hash: String,
    pub payload: LayerPayload,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateEnvelope {
    kind: String,
    format_version: u32,
    root_key: String,
    manifest_hash: String,
    actor: String,
    pub sequence: u64,
    pub generation: u64,
    pub document: ProjectDocument,
    pub preferences: PlaybackPreferences,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub base: Option<Checkpoint>,
    pub confirmed: LayerPayload,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub pending: Option<PendingPayload>,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    in_flight: Option<PendingPayload>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceFault {
    RecoveryWrite,
    RecoverySync,
    RecoveryReplace,
    MainWrite,
    MainSync,
    MainReplace,
}

struct PrivateRecovery {
    primary: Option<PrivateEnvelope>,
    candidate: PrivateEnvelope,
    primary_error: Option<AppError>,
}

pub struct PrivateWorkspace {
    repo: Arc<CollaborationRepository>,
    actor: Option<Arc<AuthorSession>>,
    root: PathBuf,
    _lock: File,
    envelope: PrivateEnvelope,
    fault: Option<WorkspaceFault>,
    pub(crate) sync_error: Option<AppError>,
    nonce: uuid::Uuid,
    recovery: Option<PrivateRecovery>,
}
impl PrivateWorkspace {
    /// Captures only durable local state. NAS I/O occurs later in PublicationCapture::publish.
    pub fn prepare_publication(&mut self) -> Result<Option<PublicationCapture>> {
        self.require_ready()?;
        let Some(actor) = self.actor.clone() else {
            return Ok(None);
        };
        if let Some(error) = &self.sync_error {
            return Err(error.clone());
        }
        let Some(pending) = self
            .envelope
            .in_flight
            .clone()
            .or_else(|| self.envelope.pending.clone())
        else {
            return Ok(None);
        };
        if self.envelope.in_flight.is_none() && pending.payload == self.envelope.confirmed {
            let mut next = self.envelope.clone();
            next.pending = None;
            self.commit(next)?;
            return Ok(None);
        }
        if self.envelope.in_flight.is_none() {
            let mut next = self.envelope.clone();
            next.in_flight = Some(pending.clone());
            self.commit(next)?;
        }
        Ok(Some(PublicationCapture {
            repo: self.repo.clone(),
            actor,
            nonce: self.nonce,
            base: self.envelope.base.clone(),
            pending,
        }))
    }
    pub fn acknowledge(&mut self, ack: PublicationAck) -> Result<()> {
        self.require_ready()?;
        require(
            ack.nonce == self.nonce
                && ack.base == self.envelope.base
                && self.envelope.in_flight.as_ref() == Some(&ack.pending),
            "Stale publication acknowledgement",
        )?;
        self.confirm(&ack.pending, ack.checkpoint)
    }
    fn confirm(&mut self, pending: &PendingPayload, checkpoint: Checkpoint) -> Result<()> {
        let mut next = self.envelope.clone();
        next.base = Some(checkpoint);
        next.confirmed = pending.payload.clone();
        next.in_flight = None;
        if next.pending.as_ref() == Some(pending) {
            next.pending = None;
        }
        self.commit(next)?;
        self.sync_error = None;
        Ok(())
    }
    /// Preparation performs share I/O; callers install the result only after success.
    pub fn open(
        repo: Arc<CollaborationRepository>,
        actor: Option<Arc<AuthorSession>>,
        app_local: &Path,
    ) -> Result<Self> {
        if let Some(actor) = &actor {
            require(
                actor.belongs_to(&repo),
                "Author capability belongs to another shared project",
            )?;
        }
        atomic::safe_existing(app_local)?;
        let app_local = app_local.canonicalize().map_err(atomic::io)?;
        require(
            !app_local.starts_with(repo.root()),
            "Private data root must be outside the shared project",
        )?;
        let root_key = hash(repo.root().to_string_lossy().as_bytes());
        let actor_id = actor
            .as_ref()
            .map_or("guest", |a| a.identity().author_id.as_str())
            .to_owned();
        let mut root = app_local;
        for segment in [
            "collaboration",
            &root_key,
            &repo.manifest().project_id,
            &actor_id,
        ] {
            root.push(segment);
            atomic::ensure_dir(&root)?;
        }
        let lock = atomic::lock(&root.join(".workspace.lock"))?;
        let manifest_hash = hash(
            &serde_json::to_vec(repo.manifest())
                .map_err(|_| AppError::invalid("Cannot encode manifest"))?,
        );
        let initial = repo.manifest().base_document()?;
        let empty = LayerPayload::from_document(&initial)?;
        let mut envelope = PrivateEnvelope {
            kind: CACHE_KIND.into(),
            format_version: 1,
            root_key,
            manifest_hash,
            actor: actor_id,
            sequence: 0,
            generation: 0,
            document: initial,
            preferences: PlaybackPreferences::default(),
            base: None,
            confirmed: empty,
            pending: None,
            in_flight: None,
        };
        let mut any_cache = false;
        let mut primary = None;
        let mut candidate = None;
        let mut primary_error = None;
        let mut last_error = None;
        for (name, is_primary) in [("workspace.json", true), ("workspace.recovery.json", false)] {
            let path = root.join(name);
            if path.try_exists().map_err(atomic::io)? {
                any_cache = true;
                let result = atomic::read(&path, MAX_CACHE_BYTES)
                    .and_then(|b| decode::<PrivateEnvelope>(&b, MAX_CACHE_BYTES, CACHE_KIND))
                    .and_then(|candidate| {
                        validate_envelope(&candidate, &envelope, repo.manifest())?;
                        Ok(candidate)
                    });
                match result {
                    Ok(value) => {
                        if is_primary {
                            primary = Some(value);
                        } else {
                            candidate = Some(value);
                        }
                    }
                    Err(error) => {
                        if is_primary {
                            primary_error = Some(error.clone());
                        }
                        last_error = Some(error);
                    }
                }
            }
        }
        if any_cache && primary.is_none() && candidate.is_none() {
            return Err(
                last_error.unwrap_or_else(|| AppError::invalid("No valid private checkpoint"))
            );
        }
        // The primary is the last accepted checkpoint. A newer recovery is only a
        // recoverable proposal: its failed save may have been explicitly discarded.
        let needs_choice = candidate.as_ref().is_some_and(|candidate| {
            primary.as_ref().is_none_or(|primary| {
                candidate.sequence > primary.sequence
                    || (candidate.sequence == primary.sequence && candidate != primary)
            })
        });
        if let Some(selected) = primary.as_ref().or(candidate.as_ref()) {
            envelope = selected.clone();
        }
        let recovery = if needs_choice {
            Some(PrivateRecovery {
                primary,
                candidate: candidate.unwrap(),
                primary_error,
            })
        } else {
            None
        };
        let mut workspace = Self {
            repo,
            actor,
            root,
            _lock: lock,
            envelope,
            fault: None,
            sync_error: None,
            nonce: uuid::Uuid::new_v4(),
            recovery,
        };
        if workspace.recovery.is_none() {
            if let Some(actor) = &workspace.actor {
                match workspace.repo.read_author(&actor.identity().author_id) {
                    Ok(remote) => workspace.reconcile_remote(remote.as_ref())?,
                    Err(error) => workspace.sync_error = Some(error),
                }
            }
        }
        if !any_cache {
            workspace.commit(workspace.envelope.clone())?;
        }
        Ok(workspace)
    }
    fn require_ready(&self) -> Result<()> {
        require(
            self.recovery.is_none(),
            "Choose a private recovery checkpoint before editing or publishing",
        )
    }
    pub fn persisted_revision(&self) -> u64 {
        self.recovery
            .as_ref()
            .map_or(self.envelope.document.revision, |r| {
                r.primary.as_ref().map_or(0, |p| p.document.revision)
            })
    }
    pub(crate) fn recovery_report(&self) -> Option<LoadReport> {
        self.recovery.as_ref().map(|r| LoadReport {
            primary: r.primary.as_ref().map(|p| p.document.clone()),
            primary_error: r.primary_error.clone(),
            candidates: vec![RecoveryCandidate {
                source: RecoverySource::Recovery,
                document: r.candidate.document.clone(),
            }],
        })
    }
    pub(crate) fn resolve_recovery(
        &mut self,
        source: Option<RecoverySource>,
    ) -> Result<ProjectDocument> {
        let recovery = self
            .recovery
            .as_ref()
            .ok_or_else(|| AppError::invalid("No private recovery choice pending"))?;
        let mut selected = match source {
            None => recovery.primary.clone(),
            Some(RecoverySource::Recovery) => Some(recovery.candidate.clone()),
            Some(RecoverySource::Backup) => None,
        }
        .ok_or_else(|| AppError::invalid("Selected private checkpoint unavailable"))?;
        // Preserve every selected field, including its base, in-flight admission and
        // preferences. Advance only the envelope sequence beyond both candidates.
        selected.sequence = selected.sequence.max(recovery.candidate.sequence);
        self.commit(selected)?;
        self.recovery = None;
        self.nonce = uuid::Uuid::new_v4();
        Ok(self.envelope.document.clone())
    }
    pub(crate) fn suppress_recovery(&self) -> Result<()> {
        self.require_ready()?;
        let bytes = serde_json::to_vec(&self.envelope)
            .map_err(|_| AppError::invalid("Cannot encode accepted checkpoint"))?;
        self.write(
            "workspace.recovery.json",
            &bytes,
            [
                WorkspaceFault::RecoveryWrite,
                WorkspaceFault::RecoverySync,
                WorkspaceFault::RecoveryReplace,
            ],
        )
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn shared_root(&self) -> &Path {
        self.repo.root()
    }
    pub fn manifest(&self) -> &CollaborationManifest {
        self.repo.manifest()
    }
    pub fn envelope(&self) -> &PrivateEnvelope {
        &self.envelope
    }
    pub fn preferences(&self) -> &PlaybackPreferences {
        &self.envelope.preferences
    }
    pub fn sync_error(&self) -> Option<&AppError> {
        self.sync_error.as_ref()
    }
    pub fn actor(&self) -> Option<&AuthorIdentity> {
        self.actor.as_ref().map(|a| a.identity())
    }
    pub fn inject_fault(&mut self, fault: Option<WorkspaceFault>) {
        self.fault = fault;
    }
    pub fn save_preferences(&mut self, preferences: PlaybackPreferences) -> Result<()> {
        self.require_ready()?;
        let mut next = self.envelope.clone();
        next.preferences = preferences;
        self.commit(next)
    }
    pub fn save(&mut self, document: &ProjectDocument) -> Result<()> {
        self.require_ready()?;
        require(
            document.revision >= self.envelope.document.revision,
            "Cannot save an older personal document",
        )?;
        let mut next = self.envelope.clone();
        next.document = document.clone();
        next.generation = increment(next.generation)?;
        let payload = LayerPayload::from_document(document)?;
        // An in-flight A must be acknowledged before a saved revert to the old base can publish.
        next.pending = if payload != next.confirmed || next.in_flight.is_some() {
            Some(PendingPayload {
                generation: next.generation,
                hash: payload.hash()?,
                payload,
            })
        } else {
            None
        };
        self.commit(next)
    }
    fn commit(&mut self, mut next: PrivateEnvelope) -> Result<()> {
        next.sequence = increment(self.envelope.sequence.max(next.sequence))?;
        validate_envelope(&next, &self.envelope, self.repo.manifest())?;
        let bytes = serde_json::to_vec(&next)
            .map_err(|_| AppError::invalid("Cannot encode private workspace"))?;
        limit(bytes.len() <= MAX_CACHE_BYTES)?;
        self.write(
            "workspace.recovery.json",
            &bytes,
            [
                WorkspaceFault::RecoveryWrite,
                WorkspaceFault::RecoverySync,
                WorkspaceFault::RecoveryReplace,
            ],
        )?;
        self.write(
            "workspace.json",
            &bytes,
            [
                WorkspaceFault::MainWrite,
                WorkspaceFault::MainSync,
                WorkspaceFault::MainReplace,
            ],
        )?;
        self.envelope = next;
        Ok(())
    }
    fn write(&self, name: &str, bytes: &[u8], faults: [WorkspaceFault; 3]) -> Result<()> {
        let tmp = self
            .root
            .join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(atomic::io)?;
            let split = bytes.len() / 2;
            file.write_all(&bytes[..split]).map_err(atomic::io)?;
            self.check_fault(faults[0])?;
            file.write_all(&bytes[split..]).map_err(atomic::io)?;
            file.flush().map_err(atomic::io)?;
            self.check_fault(faults[1])?;
            file.sync_all().map_err(atomic::io)?;
            drop(file);
            self.check_fault(faults[2])?;
            crate::project::store::atomic_replace(&tmp, &self.root.join(name)).map_err(atomic::io)
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
        }
        result
    }
    fn check_fault(&self, fault: WorkspaceFault) -> Result<()> {
        if self.fault == Some(fault) {
            Err(AppError::new(
                ErrorCode::SaveFailed,
                format!("Injected {fault:?}"),
            ))
        } else {
            Ok(())
        }
    }
    pub fn reconcile_remote(&mut self, remote: Option<&AuthorLayer>) -> Result<()> {
        self.require_ready()?;
        self.validate_remote(remote)?;
        let checkpoint = remote.map(AuthorLayer::checkpoint);
        if checkpoint == self.envelope.base {
            self.sync_error = None;
            return Ok(());
        }
        if let (Some(pending), Some(remote)) = (self.envelope.in_flight.clone(), remote) {
            let expected = AuthorLayer {
                kind: LAYER_KIND.into(),
                format_version: 1,
                project_id: self.repo.manifest().project_id.clone(),
                author_id: self.envelope.actor.clone(),
                revision: self.envelope.base.as_ref().map_or(1, |b| b.revision + 1),
                parent: self.envelope.base.clone(),
                payload: pending.payload.clone(),
                hash: String::new(),
            };
            if remote.hash == expected.computed_hash()? {
                return self.confirm(&pending, remote.checkpoint());
            }
        }
        if self.envelope.pending.is_some()
            || self.envelope.base.as_ref().is_some_and(|base| {
                checkpoint
                    .as_ref()
                    .is_none_or(|c| c.revision <= base.revision)
            })
        {
            self.sync_error = Some(AppError::new(
                ErrorCode::RevisionConflict,
                "Shared author baseline changed; local content retained",
            ));
            return Ok(());
        }
        let mut next = self.envelope.clone();
        let payload = remote.map_or_else(
            || LayerPayload::from_document(&self.repo.manifest().base_document()?),
            |r| Ok(r.payload.clone()),
        )?;
        install_payload(&mut next.document, &payload, self.repo.manifest())?;
        next.document.revision = increment(next.document.revision)?;
        next.base = checkpoint;
        next.confirmed = LayerPayload::from_document(&next.document)?;
        self.commit(next)
    }
    /// Polling may acknowledge our admitted write, but must never replace live session content.
    /// A divergent own layer requires the explicit load-remote lifecycle action.
    pub fn observe_remote(&mut self, remote: Option<&AuthorLayer>) -> Result<()> {
        self.require_ready()?;
        self.validate_remote(remote)?;
        if remote.map(AuthorLayer::checkpoint) == self.envelope.base {
            self.sync_error = None;
            return Ok(());
        }
        if let (Some(pending), Some(remote)) = (self.envelope.in_flight.clone(), remote) {
            let expected = AuthorLayer {
                kind: LAYER_KIND.into(),
                format_version: 1,
                project_id: self.repo.manifest().project_id.clone(),
                author_id: self.envelope.actor.clone(),
                revision: self.envelope.base.as_ref().map_or(1, |b| b.revision + 1),
                parent: self.envelope.base.clone(),
                payload: pending.payload.clone(),
                hash: String::new(),
            };
            if remote.hash == expected.computed_hash()? {
                return self.confirm(&pending, remote.checkpoint());
            }
        }
        self.sync_error = Some(AppError::new(
            ErrorCode::RevisionConflict,
            "Shared author baseline changed; load shared version explicitly",
        ));
        Ok(())
    }
    fn validate_remote(&self, remote: Option<&AuthorLayer>) -> Result<()> {
        require(self.actor.is_some(), "Guest has no shared author layer")?;
        if let Some(remote) = remote {
            AuthorLayer::parse(
                &serde_json::to_vec(remote)
                    .map_err(|_| AppError::invalid("Invalid remote layer"))?,
                self.repo.manifest(),
                &self.envelope.actor,
            )?;
        }
        Ok(())
    }
    /// Explicit user conflict resolution. Callers fetch the layer outside their app mutex.
    pub fn load_remote(&mut self, remote: Option<&AuthorLayer>) -> Result<ProjectDocument> {
        self.require_ready()?;
        self.validate_remote(remote)?;
        // Missing/regressed authority is an error, never an implicit author deletion.
        if let Some(base) = &self.envelope.base {
            require(
                remote.is_some_and(|r| r.revision >= base.revision),
                "Missing or regressed shared layer",
            )?;
        }
        let mut next = self.envelope.clone();
        let payload = remote.map_or_else(
            || LayerPayload::from_document(&self.repo.manifest().base_document()?),
            |r| Ok(r.payload.clone()),
        )?;
        install_payload(&mut next.document, &payload, self.repo.manifest())?;
        next.document.revision = increment(next.document.revision)?;
        next.base = remote.map(AuthorLayer::checkpoint);
        next.confirmed = LayerPayload::from_document(&next.document)?;
        next.pending = None;
        next.in_flight = None;
        self.commit(next)?;
        self.sync_error = None;
        self.nonce = uuid::Uuid::new_v4();
        Ok(self.envelope.document.clone())
    }
}
fn increment(n: u64) -> Result<u64> {
    limit(n < MAX_SAFE_INTEGER)?;
    Ok(n + 1)
}
fn validate_envelope(
    e: &PrivateEnvelope,
    identity: &PrivateEnvelope,
    manifest: &CollaborationManifest,
) -> Result<()> {
    require(
        e.kind == CACHE_KIND
            && e.format_version == 1
            && e.root_key == identity.root_key
            && e.manifest_hash == identity.manifest_hash
            && e.actor == identity.actor,
        "Private cache identity mismatch",
    )?;
    limit(e.sequence <= MAX_SAFE_INTEGER && e.generation <= MAX_SAFE_INTEGER)?;
    e.document.validate()?;
    require(
        e.document.project_id == manifest.project_id
            && e.document.name == manifest.name
            && e.document.created_at == manifest.created_at
            && e.document.media.len() == manifest.media.len(),
        "Private catalog identity mismatch",
    )?;
    for (local, public) in e.document.media.iter().zip(&manifest.media) {
        require(
            local.id == public.id
                && local.display_name == public.display_name
                && crate::media::registry::same_identity(local, &public.descriptor()),
            "Private media catalog changed",
        )?;
    }
    require(
        e.preferences.volume.is_finite()
            && (0.0..=1.0).contains(&e.preferences.volume)
            && e.preferences
                .device_id
                .as_ref()
                .is_none_or(|d| d.len() <= 4096 && !d.contains('\0')),
        "Invalid private playback preferences",
    )?;
    e.confirmed.project(manifest)?;
    e.confirmed.hash()?;
    if let Some(base) = &e.base {
        require(
            base.revision > 0 && base.revision <= MAX_SAFE_INTEGER,
            "Invalid private base",
        )?;
        digest(&base.hash)?;
    }
    for pending in [&e.pending, &e.in_flight].into_iter().flatten() {
        require(
            pending.generation <= e.generation
                && pending.generation > 0
                && pending.hash == pending.payload.hash()?,
            "Invalid pending generation/hash",
        )?;
        pending.payload.project(manifest)?;
    }
    let current_payload = LayerPayload::from_document(&e.document)?;
    if let Some(pending) = &e.pending {
        require(
            pending.generation == e.generation && pending.payload == current_payload,
            "Pending does not match latest personal document",
        )?;
    } else {
        require(
            e.in_flight.is_none() && current_payload == e.confirmed,
            "Changed personal content is missing its pending checkpoint",
        )?;
    }
    Ok(())
}
pub(crate) fn install_payload(
    document: &mut ProjectDocument,
    payload: &LayerPayload,
    manifest: &CollaborationManifest,
) -> Result<()> {
    let projected = payload.project(manifest)?;
    document.categories = projected.categories;
    document.annotations = projected.annotations;
    for (media, labels) in document.media.iter_mut().zip(projected.media) {
        media.note = labels.note;
        media.category_id = labels.category_id;
        media.channel_notes = labels.channel_notes;
        media.channel_category_ids = labels.channel_category_ids;
    }
    document.validate()
}

/// Build the whole proposed merge before changing the session or history.
pub(crate) fn merge_guest(
    current: &ProjectDocument,
    guest: &LayerPayload,
    manifest: &CollaborationManifest,
) -> Result<ProjectDocument> {
    let guest = guest.project(manifest)?;
    let mut next = current.clone();
    let mut remap = std::collections::HashMap::new();
    for mut category in guest.categories {
        let id = uuid::Uuid::new_v4().to_string();
        remap.insert(category.id, id.clone());
        category.id = id;
        next.categories.push(category);
    }
    let category = |id: Option<String>| -> Option<String> { id.map(|id| remap[&id].clone()) };
    for mut annotation in guest.annotations {
        annotation.id = uuid::Uuid::new_v4().to_string();
        annotation.category_id = category(annotation.category_id);
        next.annotations.push(annotation);
    }
    for (own, foreign) in next.media.iter_mut().zip(guest.media) {
        merge_note(&mut own.note, foreign.note)?;
        merge_category(&mut own.category_id, category(foreign.category_id))?;
        for (own, foreign) in own.channel_notes.iter_mut().zip(foreign.channel_notes) {
            merge_note(own, foreign)?;
        }
        for (own, foreign) in own
            .channel_category_ids
            .iter_mut()
            .zip(foreign.channel_category_ids)
        {
            merge_category(own, category(foreign))?;
        }
    }
    next.validate()?;
    Ok(next)
}
fn merge_note(own: &mut String, foreign: String) -> Result<()> {
    if !foreign.is_empty() {
        require(
            own.is_empty() || *own == foreign,
            "Guest file/channel note conflicts with your layer",
        )?;
        *own = foreign;
    }
    Ok(())
}
fn merge_category(own: &mut Option<String>, foreign: Option<String>) -> Result<()> {
    if foreign.is_some() {
        require(
            own.is_none() || *own == foreign,
            "Guest file/channel category conflicts with your layer",
        )?;
        *own = foreign;
    }
    Ok(())
}
