//! Shared layout state is independent from the private editor and catalog adoption.
use super::collaboration::runtime;
use crate::state::AppState;
use annotator_core::{
    collaboration::{
        recycle::{Recycle, RecycleOperation},
        CollaborationRepository,
    },
    error::{AppError, Result},
    media::identity::check_cancel,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub runtime_nonce: String,
    pub project_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub runtime_nonce: String,
    pub project_id: String,
    pub recycle: Recycle,
}
fn bound<'a>(
    state: &'a AppState,
    binding: &Binding,
    project: &'a annotator_core::project::LocalProject,
) -> Result<Arc<CollaborationRepository>> {
    let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
    if runtime.nonce != binding.runtime_nonce
        || project.workspace()?.manifest().project_id != binding.project_id
    {
        return Err(runtime::stale());
    }
    runtime.repo.clone().ok_or_else(runtime::stale)
}
pub(crate) async fn get(state: &AppState, binding: Binding) -> Result<Snapshot> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repo = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            bound(
                &state,
                &binding,
                current.as_ref().ok_or_else(runtime::stale)?,
            )?
        };
        let recycle = repo.read_recycle()?;
        let current = state.0.lock().map_err(|_| runtime::unavailable())?;
        bound(
            &state,
            &binding,
            current.as_ref().ok_or_else(runtime::stale)?,
        )?;
        Ok(Snapshot {
            runtime_nonce: binding.runtime_nonce,
            project_id: binding.project_id,
            recycle,
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
pub(crate) async fn apply(
    state: &AppState,
    binding: Binding,
    expected_revision: u64,
    operation: RecycleOperation,
) -> Result<Snapshot> {
    let permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (repo, actor) = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let project = current.as_ref().ok_or_else(runtime::stale)?;
            let repo = bound(&state, &binding, project)?;
            if project.recovery().is_some() {
                return Err(AppError::invalid(
                    "Resolve project recovery before editing recycle bin",
                ));
            }
            let actor = project
                .workspace()?
                .author_session()
                .ok_or_else(|| AppError::invalid("Recycle editing requires a writable author"))?;
            (repo, actor)
        };
        let recycle = repo.apply_recycle_controlled(
            &actor,
            expected_revision,
            operation,
            &permit.cancel,
            || {
                #[cfg(test)]
                state.6.run_hook();
                check_cancel(&permit.cancel)?;
                let current = state.0.lock().map_err(|_| runtime::unavailable())?;
                let project = current.as_ref().ok_or_else(runtime::stale)?;
                bound(&state, &binding, project)?;
                if project.recovery().is_some() {
                    return Err(AppError::invalid(
                        "Resolve project recovery before editing recycle bin",
                    ));
                }
                let live_actor = project
                    .workspace()?
                    .author_session()
                    .ok_or_else(runtime::stale)?;
                if !Arc::ptr_eq(&actor, &live_actor) {
                    return Err(runtime::stale());
                }
                // Retain this guard only for the final bounded atomic metadata write.
                Ok(current)
            },
        )?;
        #[cfg(test)]
        {
            if let Some(hook) = state.6.after_io.lock().unwrap().take() {
                hook();
            }
        }
        // A committed head remains authoritative after late cancellation.
        Ok(Snapshot {
            runtime_nonce: binding.runtime_nonce,
            project_id: binding.project_id,
            recycle,
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn recycle_get(state: State<'_, AppState>, binding: Binding) -> Result<Snapshot> {
    get(&state, binding).await
}
#[tauri::command]
pub async fn recycle_apply(
    state: State<'_, AppState>,
    binding: Binding,
    expected_revision: u64,
    operation: RecycleOperation,
) -> Result<Snapshot> {
    apply(&state, binding, expected_revision, operation).await
}
