use super::{runtime, Candidate, Token};
use crate::state::AppState;
use annotator_core::{
    collaboration::{
        organization::{NativePlacementCapture, NativePlacementPlan},
        CollaborationRepository,
    },
    error::{AppError, Result},
    media::import_source::ScanResult,
};
use std::sync::Arc;
#[derive(Clone)]
pub(crate) struct CapturedLayout {
    pub layout_revision: u64,
    pub target_folder_id: Option<String>,
    pub target_path: Vec<String>,
}
impl CapturedLayout {
    pub(crate) fn from_capture(
        capture: &NativePlacementCapture,
        target_folder_id: Option<String>,
    ) -> Self {
        Self {
            layout_revision: capture.layout_revision(),
            target_folder_id,
            target_path: capture.target_path().to_vec(),
        }
    }
    fn fresh(&self, repo: &CollaborationRepository) -> Result<NativePlacementCapture> {
        let capture = repo.capture_media_placement(self.target_folder_id.clone())?;
        if capture.layout_revision() != self.layout_revision {
            return Err(runtime::stale());
        }
        Ok(capture)
    }
    pub(crate) fn check(&self, repo: &CollaborationRepository) -> Result<()> {
        self.fresh(repo).map(|_| ())
    }
    fn seal(&self, capture: &NativePlacementCapture, c: &Candidate) -> Result<NativePlacementPlan> {
        capture.seal(
            c.resulting_folder_path[self.target_path.len()..].to_vec(),
            c.original_filename.clone(),
        )
    }
}
pub(crate) struct PreparedBatch {
    pub token: Token,
    pub scan: Arc<ScanResult>,
    pub indices: Vec<usize>,
    pub placements: Vec<NativePlacementPlan>,
}
/// Read one fresh native head for the whole batch outside project/registry locks.
/// The ordinary media admission checks token/runtime/cancellation again before decoding.
pub(crate) async fn prepare_batch(
    state: &AppState,
    token: Token,
    indices: Vec<usize>,
) -> Result<PreparedBatch> {
    let service = state.6.clone();
    let t = token.clone();
    let selected = indices.clone();
    let (repo, layout, scan) = state
        .run(move |current| {
            let project = current.as_ref().ok_or_else(runtime::stale)?;
            super::check(project, &service, &t.runtime_nonce, &t.project_id)?;
            let registry = service.sources.lock().map_err(|_| runtime::unavailable())?;
            let scan = registry.result(&t)?;
            let mut seen = std::collections::HashSet::new();
            for index in &selected {
                if !seen.insert(*index) || *index >= scan.candidates().len() {
                    return Err(AppError::invalid("重复或越界的候选索引"));
                }
            }
            let layout = registry.layout(&t)?;
            let repo = service
                .current
                .lock()
                .map_err(|_| runtime::unavailable())?
                .repo
                .clone()
                .ok_or_else(runtime::stale)?;
            Ok((repo, layout, scan))
        })
        .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let capture = layout.fresh(&repo)?;
        let placements = indices
            .iter()
            .map(|i| layout.seal(&capture, &scan.candidates()[*i]))
            .collect::<Result<Vec<_>>>()?;
        Ok(PreparedBatch {
            token,
            scan,
            indices,
            placements,
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
