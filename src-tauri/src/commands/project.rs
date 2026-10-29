use crate::state::AppState;
use annotator_core::{
    error::{AppError, Result},
    model::Change,
    project::{LoadReport, LocalProject, ProjectSnapshot, RecoverySource},
};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProject {
    pub(crate) snapshot: Option<ProjectSnapshot>,
    path: String,
    persisted_revision: u64,
    recovery: Option<LoadReport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    collaboration: Option<super::collaboration::runtime::Context>,
}
pub(crate) fn info(p: &LocalProject) -> OpenProject {
    OpenProject {
        snapshot: p.snapshot().ok(),
        path: p.root().to_string_lossy().into_owned(),
        persisted_revision: p.persisted_revision(),
        recovery: p.recovery().cloned(),
        collaboration: None,
    }
}
pub(crate) fn info_shared(
    p: &LocalProject,
    service: &super::collaboration::runtime::Service,
) -> Result<OpenProject> {
    let mut opened = info(p);
    if p.is_shared() {
        let status = super::collaboration::runtime::status(Some(p), service)?;
        opened = info_with_status(p, &status);
    }
    Ok(opened)
}
pub(crate) fn info_with_status(
    p: &LocalProject,
    status: &super::collaboration::runtime::Status,
) -> OpenProject {
    let mut opened = info(p);
    opened.collaboration = Some(super::collaboration::runtime::Context {
        project_flavor: status.project_flavor.clone(),
        identity_mode: status.identity_mode.clone(),
        can_write_annotations: status.can_write_annotations,
        can_import_media: status.can_import_media,
        hidden_media_ids: status.hidden_media_ids.clone(),
        catalog_pending: status.catalog_pending,
        runtime_nonce: status.runtime_nonce.clone(),
        actor: status.actor.clone(),
        preferences: status.preferences.clone(),
    });
    opened
}
fn active(s: &mut Option<LocalProject>) -> Result<&mut LocalProject> {
    s.as_mut().ok_or_else(|| AppError::invalid("尚未打开项目"))
}
#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<OpenProject> {
    super::collaboration::defaults::create(&state, path, name).await
}
#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, path: String) -> Result<OpenProject> {
    super::collaboration::open(&state, path).await
}
#[tauri::command]
pub async fn resolve_recovery(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    source: Option<RecoverySource>,
) -> Result<OpenProject> {
    resolve_recovery_for(&state, runtime_nonce, source).await
}
pub(crate) async fn resolve_recovery_for(
    state: &AppState,
    runtime_nonce: Option<String>,
    source: Option<RecoverySource>,
) -> Result<OpenProject> {
    use super::collaboration::runtime;
    use annotator_core::collaboration::CollaborationRepository;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let captured = {
            let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let p = active(&mut current)?;
            runtime::check_mutation(p, &state.6, runtime_nonce.as_deref())?;
            if p.is_shared() {
                let w = p.workspace()?;
                let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
                Some((
                    r.nonce.clone(),
                    r.repo.clone().ok_or_else(runtime::stale)?,
                    w.catalog_source(),
                    w.envelope().document.project_id.clone(),
                    w.envelope().document.revision,
                ))
            } else {
                // Ordinary recovery keeps its original atomic native lifecycle;
                // only shared recovery needs an off-lock authority preparation.
                p.resolve_recovery(source)?;
                state.6.install(None)?;
                return info_shared(p, &state.6);
            }
        };
        #[cfg(test)]
        {
            let hook = state.6.before_retirement_io.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        // Resolve ancestry and independently project both recovery choices off
        // the application mutex before either choice can be accepted.
        let prepared = if let Some((_, repo, catalog, _, _)) = &captured {
            let fresh = CollaborationRepository::open(repo.root())?;
            if fresh.manifest_identity() != repo.manifest_identity() {
                Some(catalog.clone().prepare_retirement(fresh)?)
            } else {
                None
            }
        } else {
            None
        };
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let p = active(&mut current)?;
        runtime::check_mutation(p, &state.6, runtime_nonce.as_deref())?;
        if let Some((nonce, _, _, project_id, revision)) = captured {
            let mut r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            let w = p.workspace()?;
            if r.nonce != nonce
                || w.envelope().document.project_id != project_id
                || w.envelope().document.revision != revision
                || p.recovery().is_none()
            {
                return Err(runtime::stale());
            }
            if let Some(prepared) = prepared {
                let next = prepared.repository();
                let retired = prepared.retired_media_ids().clone();
                let mut layers = r.layers.clone().ok_or_else(runtime::stale)?;
                layers.adopt_prepared_catalog(&prepared)?;
                let before = p.workspace()?.envelope().document.clone();
                let snapshot = p.adopt_prepared_catalog(&project_id, revision, prepared)?;
                state.retire_media_resources(&retired.iter().cloned().collect::<Vec<_>>())?;
                state.3.changed(&before, &snapshot.document);
                r.repo = Some(next);
                r.layers = Some(layers);
                r.retired_media_ids.extend(retired);
                r.retired_media_ids.sort();
                r.retired_media_ids.dedup();
            }
            p.resolve_recovery(source)?;
            drop(r);
        } else {
            p.resolve_recovery(source)?;
            state.6.install(None)?;
        }
        info_shared(p, &state.6)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn get_project_snapshot(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
) -> Result<ProjectSnapshot> {
    let collaboration = state.6.clone();
    state
        .run(move |s| {
            super::collaboration::runtime::check_mutation(
                active(s)?,
                &collaboration,
                runtime_nonce.as_deref(),
            )?;
            let snapshot = active(s)?.snapshot()?;
            if snapshot.document.project_id != project_id {
                return Err(AppError::invalid("项目身份不匹配"));
            }
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn apply_change(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
    expected_revision: u64,
    change: Change,
) -> Result<ProjectSnapshot> {
    apply(&state, runtime_nonce, project_id, expected_revision, change).await
}
pub(crate) async fn apply(
    state: &AppState,
    runtime_nonce: Option<String>,
    project_id: String,
    expected_revision: u64,
    change: Change,
) -> Result<ProjectSnapshot> {
    if let Change::ImportMediaBatch { items } = &change {
        return super::collaboration::catalog::import_batch(
            state,
            super::collaboration::runtime::Expected {
                runtime_nonce: runtime_nonce.ok_or_else(super::collaboration::runtime::stale)?,
                project_id,
                expected_revision,
            },
            items.clone(),
        )
        .await;
    }
    if let Change::ImportMedia { media } = &change {
        let shared = state
            .0
            .lock()
            .map_err(|_| AppError::invalid("Project unavailable"))?
            .as_ref()
            .is_some_and(|p| p.is_shared());
        if shared {
            return super::collaboration::catalog::import(
                state,
                super::collaboration::runtime::Expected {
                    runtime_nonce: runtime_nonce
                        .ok_or_else(super::collaboration::runtime::stale)?,
                    project_id,
                    expected_revision,
                },
                media.clone(),
            )
            .await;
        }
    }
    let collaboration = state.6.clone();
    let media_tasks = state.1.clone();
    let playback = state.3.clone();
    if matches!(
        &change,
        Change::ImportMedia { .. } | Change::RelinkMedia { .. }
    ) {
        let change = change.clone();
        let service = collaboration.clone();
        let tasks = media_tasks.clone();
        let nonce = runtime_nonce.clone();
        let media = state
            .run(move |s| {
                let p = active(s)?;
                super::collaboration::runtime::check_mutation(p, &service, nonce.as_deref())?;
                if p.is_shared() && matches!(&change, Change::ImportMedia { .. }) {
                    return Err(AppError::invalid("Shared media catalog is immutable"));
                }
                match change {
                    Change::ImportMedia { media } | Change::RelinkMedia { media } => tasks
                        .lock()
                        .map_err(|_| AppError::invalid("Media unavailable"))?
                        .prepared_unverified(&media),
                    _ => unreachable!(),
                }
            })
            .await?;
        tauri::async_runtime::spawn_blocking(move || media.verify_source())
            .await
            .map_err(|_| AppError::invalid("Media verification interrupted"))??;
    }
    state
        .run(move |s| {
            super::collaboration::runtime::check_mutation(
                active(s)?,
                &collaboration,
                runtime_nonce.as_deref(),
            )?;
            let mut tasks = media_tasks
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            let prepared = match &change {
                Change::ImportMedia { media } | Change::RelinkMedia { media } => {
                    Some(tasks.prepared_unverified(media)?)
                }
                _ => None,
            };
            let before = active(s)?.snapshot()?.document;
            let snapshot = active(s)?.apply_change(&project_id, expected_revision, change)?;
            playback.changed(&before, &snapshot.document);
            if let Some(media) = prepared {
                tasks.commit(media)?;
            }
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn undo(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
    expected_revision: u64,
) -> Result<ProjectSnapshot> {
    let collaboration = state.6.clone();
    let playback = state.3.clone();
    state
        .run(move |s| {
            super::collaboration::runtime::check_mutation(
                active(s)?,
                &collaboration,
                runtime_nonce.as_deref(),
            )?;
            let before = active(s)?.snapshot()?.document;
            let snapshot = active(s)?.undo(&project_id, expected_revision)?;
            playback.changed(&before, &snapshot.document);
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn redo(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
    expected_revision: u64,
) -> Result<ProjectSnapshot> {
    let collaboration = state.6.clone();
    let playback = state.3.clone();
    state
        .run(move |s| {
            super::collaboration::runtime::check_mutation(
                active(s)?,
                &collaboration,
                runtime_nonce.as_deref(),
            )?;
            let before = active(s)?.snapshot()?.document;
            let snapshot = active(s)?.redo(&project_id, expected_revision)?;
            playback.changed(&before, &snapshot.document);
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn save_project(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
    expected_revision: u64,
) -> Result<u64> {
    let collaboration = state.6.clone();
    let saved = state
        .run(move |s| {
            super::collaboration::runtime::check_mutation(
                active(s)?,
                &collaboration,
                runtime_nonce.as_deref(),
            )?;
            active(s)?.save(&project_id, expected_revision)
        })
        .await?;
    super::collaboration::schedule(state.inner().clone());
    Ok(saved)
}
#[tauri::command]
pub async fn save_project_as(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    path: String,
    project_id: String,
    expected_revision: u64,
) -> Result<OpenProject> {
    super::collaboration::defaults::save_as(
        &state,
        runtime_nonce,
        path,
        project_id,
        expected_revision,
    )
    .await
}
#[tauri::command]
pub async fn save_project_as_controlled(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    path: String,
    project_id: String,
    expected_revision: u64,
    operation_id: String,
    on_progress: tauri::ipc::Channel<super::collaboration::CopyProgress>,
) -> Result<OpenProject> {
    super::collaboration::defaults::save_as_controlled(
        &state,
        runtime_nonce,
        path,
        project_id,
        expected_revision,
        Some(operation_id),
        Some(on_progress),
    )
    .await
}

#[tauri::command]
pub async fn close_project(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: Option<String>,
    expected_revision: Option<u64>,
    discard: bool,
) -> Result<()> {
    let media = state.1.clone();
    let analysis = state.2.clone();
    let folders = state.5.clone();
    let playback = state.3.clone();
    let collaboration = state.6.clone();
    state
        .run(move |s| {
            let mut media = media
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            if let Some(p) = s {
                super::collaboration::runtime::check_mutation(
                    p,
                    &collaboration,
                    runtime_nonce.as_deref(),
                )?;
                if p.recovery().is_none() {
                    p.prepare_close(
                        project_id
                            .as_deref()
                            .ok_or_else(|| AppError::invalid("缺少项目 ID"))?,
                        expected_revision.ok_or_else(|| AppError::invalid("缺少版本号"))?,
                        discard,
                    )?;
                }
            }
            playback.reset();
            *s = None;
            collaboration.retire();
            media.reset();
            folders
                .lock()
                .map_err(|_| AppError::invalid("扫描服务不可用"))?
                .reset();
            analysis.reset();
            Ok(())
        })
        .await
}
