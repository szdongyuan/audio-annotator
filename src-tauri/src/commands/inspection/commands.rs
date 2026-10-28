//! IPC contracts; work and source verification run on blocking workers.
use super::*;
use crate::commands::{
    analysis::TileProgress,
    playback::{MonitorGainRequest, PlaybackRequest, PlaybackStatus},
};
use annotator_core::analysis::tiles::TileRequest;
use serde::Serialize;
use tauri::{
    ipc::{Channel, Response},
    State,
};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| AppError::invalid("Inspection task interrupted"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionPreview {
    preview_id: String,
    snapshot: ProjectSnapshot,
}

#[tauri::command]
pub async fn inspection_open(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    media_id: String,
    analysis_settings: AnalysisSettings,
    request_id: String,
) -> Result<InspectionPreview> {
    annotator_core::model::validation::validate_analysis(&analysis_settings)?;
    let (owner, ticket, source) =
        start_open(&state, &runtime_nonce, &project_id, &media_id, request_id)?;
    let state = state.inner().clone();
    blocking(move || {
        let snapshot = finish_open(&state, owner, ticket, source, analysis_settings)?;
        Ok(InspectionPreview {
            preview_id: snapshot.document.project_id.clone(),
            snapshot,
        })
    })
    .await
}

#[tauri::command]
pub async fn inspection_cancel_open(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    request_id: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || cancel_open_owned(&state, &runtime_nonce, &project_id, &request_id)).await
}

#[tauri::command]
pub async fn inspection_close(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || close_owned(&state, &runtime_nonce, &project_id, &preview_id)).await
}

#[tauri::command]
pub async fn inspection_configure_analysis(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    analysis_settings: AnalysisSettings,
) -> Result<ProjectSnapshot> {
    let state = state.inner().clone();
    blocking(move || {
        configure_analysis_owned(
            &state,
            &runtime_nonce,
            &project_id,
            &preview_id,
            analysis_settings,
        )
    })
    .await
}

#[tauri::command]
pub async fn inspection_register_view(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<String> {
    let state = state.inner().clone();
    blocking(move || {
        with_preview(&state, &runtime_nonce, &project_id, &preview_id, |p| {
            p.state.2.scheduler.register_view()
        })
    })
    .await
}

fn validate_view(view: &str) -> Result<()> {
    if view.is_empty() || view.len() > 128 {
        Err(AppError::invalid("Invalid inspection view"))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn inspection_retire_view(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    view_id: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || {
        validate_view(&view_id)?;
        with_preview(&state, &runtime_nonce, &project_id, &preview_id, |p| {
            p.state.2.scheduler.retire_view(&view_id)
        })
    })
    .await
}

#[tauri::command]
pub async fn inspection_cancel_generation(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    view_id: String,
    generation: u64,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || {
        validate_view(&view_id)?;
        if generation > annotator_core::model::validation::MAX_SAFE_INTEGER {
            return Err(AppError::invalid("Invalid inspection generation"));
        }
        with_preview(&state, &runtime_nonce, &project_id, &preview_id, |p| {
            p.state.2.scheduler.cancel_generation(&view_id, generation)
        })
    })
    .await
}

#[tauri::command]
pub async fn inspection_request_tile(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    request: TileRequest,
    on_event: Channel<TileProgress>,
) -> Result<Response> {
    let state = state.inner().clone();
    let bytes = blocking(move || {
        tile_owned(
            &state,
            &runtime_nonce,
            &project_id,
            &preview_id,
            request,
            move |event| on_event.send(event).is_ok(),
        )
    })
    .await?;
    Ok(Response::new(bytes))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    media_id: String,
    status: &'static str,
}

#[tauri::command]
pub async fn inspection_media_status(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<Vec<MediaStatus>> {
    let state = state.inner().clone();
    blocking(move || {
        let media_id = with_preview(&state, &runtime_nonce, &project_id, &preview_id, |p| {
            Ok(p.media_id.clone())
        })?;
        let status = media_status_owned(&state, &runtime_nonce, &project_id, &preview_id)?;
        Ok(vec![MediaStatus { media_id, status }])
    })
    .await
}

#[tauri::command]
pub async fn inspection_playback_configure(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    request: PlaybackRequest,
) -> Result<PlaybackStatus> {
    let state = state.inner().clone();
    blocking(move || {
        playback_owned(
            &state,
            &runtime_nonce,
            &project_id,
            &preview_id,
            request,
            |preview, request| {
                crate::commands::playback::configure_owned(preview, None, app, request)
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn inspection_monitor_gain(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    request: MonitorGainRequest,
) -> Result<PlaybackStatus> {
    let state = state.inner().clone();
    blocking(move || monitor_owned(&state, &runtime_nonce, &project_id, &preview_id, &request))
        .await
}

#[tauri::command]
pub async fn inspection_playback_control(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    action: String,
) -> Result<PlaybackStatus> {
    let state = state.inner().clone();
    blocking(move || {
        if !matches!(action.as_str(), "pause" | "stop") {
            return Err(AppError::invalid("Invalid inspection control"));
        }
        with_preview(&state, &runtime_nonce, &project_id, &preview_id, |p| {
            p.state.3.control_source(&p.id, &action)
        })
    })
    .await
}

#[tauri::command]
pub async fn inspection_playback_status(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<PlaybackStatus> {
    let state = state.inner().clone();
    blocking(move || {
        let status = with_preview(&state, &runtime_nonce, &project_id, &preview_id, |p| {
            let status = p.state.3.status()?;
            Ok(if status.project_id.as_deref() == Some(&p.id) {
                status
            } else {
                PlaybackStatus::default()
            })
        })?;
        if status.state == annotator_core::audio::engine::TransportState::Error {
            retire_id(&state, &preview_id);
        }
        Ok(status)
    })
    .await
}
