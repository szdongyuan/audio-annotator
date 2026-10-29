//! Native-owned read-only inspection of existing project media.
mod commands;
use super::examples::{
    capture_owner,
    preview::{OpenTicket, Preview},
    Owner,
};
use crate::state::AppState;
use annotator_core::{
    error::{AppError, Result},
    model::{AnalysisSettings, MediaDescriptor, PlaybackMix, ProjectDocument, SpectralEdit},
    project::{LocalProject, ProjectSnapshot},
};
pub use commands::*;
use std::{path::PathBuf, sync::Arc};

fn stale() -> AppError {
    super::collaboration::runtime::stale()
}

#[derive(Clone, PartialEq)]
pub(crate) struct SourceSeed {
    descriptor: MediaDescriptor,
    root: PathBuf,
    edits: Vec<SpectralEdit>,
    mix: PlaybackMix,
}
impl SourceSeed {
    fn capture(project: &LocalProject, media: &str) -> Result<Self> {
        let document = project.snapshot()?.document;
        Ok(Self {
            descriptor: document
                .media
                .into_iter()
                .find(|m| m.id == media)
                .ok_or_else(stale)?,
            root: project.root().to_path_buf(),
            edits: document
                .edits
                .into_iter()
                .filter(|e| e.region.media_id == media)
                .collect(),
            mix: document
                .playback_mix
                .get(media)
                .cloned()
                .unwrap_or_default(),
        })
    }
    fn path(&self) -> PathBuf {
        let path = PathBuf::from(&self.descriptor.source_ref);
        if path.is_absolute() {
            path
        } else {
            self.root.join(path)
        }
    }
    fn verify(&self) -> Result<()> {
        let path = self.path();
        annotator_core::collaboration::atomic::safe_existing(&path)?;
        if annotator_core::media::identity::fingerprint(&path, &Default::default(), |_| {})?
            != self.descriptor.sha256
        {
            return Err(stale());
        }
        Ok(())
    }
    fn document(&self, settings: AnalysisSettings) -> Result<ProjectDocument> {
        let mut document = ProjectDocument::create(self.descriptor.display_name.clone())?;
        let mut descriptor = self.descriptor.clone();
        // Labels remain in the main authority. Clear references in this DSP-only document.
        descriptor.category_ids.clear();
        descriptor
            .channel_category_ids
            .iter_mut()
            .for_each(Vec::clear);
        document.analysis.insert(descriptor.id.clone(), settings);
        document
            .playback_mix
            .insert(descriptor.id.clone(), self.mix.clone());
        document.view_state.active_media_id = Some(descriptor.id.clone());
        document.media.push(descriptor);
        document.edits = self.edits.clone();
        document.validate()?;
        Ok(document)
    }
}

fn start_open(
    state: &AppState,
    nonce: &str,
    project: &str,
    media: &str,
    request: String,
) -> Result<(Owner, OpenTicket, SourceSeed)> {
    let owner = capture_owner(state, nonce, project)?;
    let (ticket, source) = owner.with_project(state, |p| {
        let source = SourceSeed::capture(p, media)?;
        Ok((
            state
                .6
                .inspection
                .begin_open(request, state.3.source_revision())?,
            source,
        ))
    })?;
    Ok((owner, ticket, source))
}
fn finish_open(
    state: &AppState,
    owner: Owner,
    ticket: OpenTicket,
    source: SourceSeed,
    settings: AnalysisSettings,
) -> Result<ProjectSnapshot> {
    state.6.inspection.check_open(&ticket)?;
    let lease = state.6.inspection.admit()?;
    source.verify()?;
    state.6.inspection.check_open(&ticket)?;
    let (preview, snapshot) = Preview::prepare(
        state,
        source.root.clone(),
        source.document(settings)?,
        owner.clone(),
        &ticket,
        lease,
        Some(source.clone()),
    )?;
    owner.with_project(state, |p| {
        if SourceSeed::capture(p, &source.descriptor.id)? != source {
            return Err(stale());
        }
        state.6.inspection.replace(preview.clone(), &ticket)
    })?;
    Ok(snapshot)
}

#[cfg(test)]
fn open_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    media: &str,
    settings: AnalysisSettings,
    request: String,
) -> Result<ProjectSnapshot> {
    annotator_core::model::validation::validate_analysis(&settings)?;
    let (owner, ticket, source) = start_open(state, nonce, project, media, request)?;
    finish_open(state, owner, ticket, source, settings)
}

fn cancel_open_owned(state: &AppState, nonce: &str, project: &str, request: &str) -> Result<()> {
    let owner = capture_owner(state, nonce, project)?;
    owner.with_current(state, || state.6.inspection.cancel_open(request))
}

fn retire_id(state: &AppState, id: &str) {
    if let Ok(mut current) = state.6.inspection.current.lock() {
        if current.as_ref().is_some_and(|p| p.id == id) {
            if let Some(old) = current.take() {
                super::examples::preview::Manager::retire(old);
            }
        }
    }
}

fn with_preview<T>(
    state: &AppState,
    nonce: &str,
    project: &str,
    id: &str,
    f: impl FnOnce(&Arc<Preview>) -> Result<T>,
) -> Result<T> {
    let result = (|| {
        let owner = capture_owner(state, nonce, project)?;
        owner.with_project(state, |main| {
            let current = state.6.inspection.current.lock().map_err(|_| stale())?;
            let p = current.as_ref().ok_or_else(stale)?;
            if p.id != id || p.owner != owner {
                return Err(stale());
            }
            let source = p.source.as_ref().ok_or_else(stale)?;
            if SourceSeed::capture(main, &p.media_id)? != *source {
                return Err(stale());
            }
            f(p)
        })
    })();
    if result.is_err() {
        // Reject a stale caller without disrupting a valid native owner. Retire only
        // when the stored owner/source actually became stale, using native authority.
        let preview = state
            .6
            .inspection
            .current
            .lock()
            .ok()
            .and_then(|p| p.as_ref().filter(|p| p.id == id).cloned());
        if let Some(preview) = preview.filter(|p| p.source.is_some()) {
            let valid = preview.owner.with_project(state, |main| {
                if preview.source.as_ref() != Some(&SourceSeed::capture(main, &preview.media_id)?) {
                    return Err(stale());
                }
                Ok(())
            });
            if valid.is_err() {
                retire_id(state, id);
            }
        }
    }
    result
}

fn configure_analysis_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    id: &str,
    settings: AnalysisSettings,
) -> Result<ProjectSnapshot> {
    annotator_core::model::validation::validate_analysis(&settings)?;
    with_preview(state, nonce, project, id, |p| {
        let mut guard = p.state.0.lock().map_err(|_| stale())?;
        let current = guard.as_ref().ok_or_else(stale)?;
        let root = current.root().to_path_buf();
        let mut document = current.snapshot()?.document;
        document.analysis.insert(p.media_id.clone(), settings);
        let replacement = LocalProject::transient(root, document)?;
        let snapshot = replacement.snapshot()?;
        // Configuration explicitly retires view leases. The next transport registers anew.
        p.state.2.scheduler.reset();
        *guard = Some(replacement);
        Ok(snapshot)
    })
}

fn tile_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    id: &str,
    request: annotator_core::analysis::tiles::TileRequest,
    send: impl Fn(super::analysis::TileProgress) -> bool + Send + 'static,
) -> Result<Vec<u8>> {
    let p = with_preview(state, nonce, project, id, |p| Ok(p.clone()))?;
    if request.project_id != p.id || request.media_id != p.media_id {
        return Err(stale());
    }
    let result: Result<Vec<u8>> = (|| {
        // The analysis path verifies rehydrated fingerprints and cached PCM source
        // stamps before/after even a warm tile. Do not hash the whole file per tile.
        let receiver = super::analysis::enqueue_owned(p.state.clone(), None, request, send)?;
        // Decode, FFT, cache I/O and waiting never hold the parent authority/manager locks.
        let bytes = receiver.recv().map_err(|_| stale())??;
        with_preview(state, nonce, project, id, |_| Ok(()))?;
        Ok(bytes)
    })();
    if result.as_ref().is_err_and(|error| {
        !matches!(
            error.code,
            annotator_core::error::ErrorCode::Cancelled
                | annotator_core::error::ErrorCode::InvalidInput
                | annotator_core::error::ErrorCode::ResourceLimit
        )
    }) {
        retire_id(state, id);
    }
    result
}

fn close_owned(state: &AppState, nonce: &str, project: &str, id: &str) -> Result<()> {
    with_preview(state, nonce, project, id, |_| Ok(()))?;
    retire_id(state, id);
    Ok(())
}

fn media_status_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    id: &str,
) -> Result<&'static str> {
    let p = with_preview(state, nonce, project, id, |p| Ok(p.clone()))?;
    let source = p.source.as_ref().ok_or_else(stale)?;
    let path = source.path();
    let status = if annotator_core::collaboration::atomic::safe_existing(&path).is_err() {
        "missing"
    } else {
        match annotator_core::media::identity::fingerprint(&path, &Default::default(), |_| {}) {
            Ok(hash) if hash == source.descriptor.sha256 => "ready",
            Ok(_) => "changed",
            Err(_) => "missing",
        }
    };
    with_preview(state, nonce, project, id, |_| Ok(()))?;
    if status != "ready" {
        retire_id(state, id);
    }
    Ok(status)
}
fn verified_preview(
    state: &AppState,
    nonce: &str,
    project: &str,
    id: &str,
) -> Result<Arc<Preview>> {
    let p = with_preview(state, nonce, project, id, |p| Ok(p.clone()))?;
    if let Err(error) = p.source.as_ref().ok_or_else(stale)?.verify() {
        retire_id(state, id);
        return Err(error);
    }
    with_preview(state, nonce, project, id, |_| Ok(()))?;
    Ok(p)
}
fn playback_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    id: &str,
    request: super::playback::PlaybackRequest,
    configure: impl FnOnce(
        AppState,
        super::playback::PlaybackRequest,
    ) -> Result<super::playback::PlaybackStatus>,
) -> Result<super::playback::PlaybackStatus> {
    let p = verified_preview(state, nonce, project, id)?;
    if request.project_id != p.id || request.media_id != p.media_id {
        return Err(stale());
    }
    let result = configure(p.state.clone(), request);
    if result.as_ref().is_err_and(|error| {
        !matches!(
            error.code,
            annotator_core::error::ErrorCode::InvalidInput
                | annotator_core::error::ErrorCode::Cancelled
                | annotator_core::error::ErrorCode::RevisionConflict
                | annotator_core::error::ErrorCode::ResourceLimit
        )
    }) {
        retire_id(state, id);
        return result;
    }
    // Rejected parameters and stale requests never acquired output ownership.
    // Keep a valid preview usable, but still retire a genuinely replaced owner.
    with_preview(state, nonce, project, id, |_| Ok(()))?;
    result
}
fn monitor_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    id: &str,
    request: &super::playback::MonitorGainRequest,
) -> Result<super::playback::PlaybackStatus> {
    with_preview(state, nonce, project, id, |p| {
        if request.project_id != p.id || request.media_id != p.media_id {
            return Err(stale());
        }
        super::playback::monitor_owned(&p.state, None, request)
    })
}

#[cfg(test)]
mod tests;
