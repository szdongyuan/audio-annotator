use crate::state::AppState;
use annotator_core::{
    error::{AppError, Result},
    model::Change,
    project::{LoadReport, LocalProject, ProjectSnapshot, RecoverySource},
};
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProject {
    snapshot: Option<ProjectSnapshot>,
    path: String,
    persisted_revision: u64,
    recovery: Option<LoadReport>,
}
pub(crate) fn info(p: &LocalProject) -> OpenProject {
    OpenProject {
        snapshot: p.snapshot().ok(),
        path: p.root().to_string_lossy().into_owned(),
        persisted_revision: p.persisted_revision(),
        recovery: p.recovery().cloned(),
    }
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
    let media = state.1.clone();
    let analysis = state.2.clone();
    let playback = state.3.clone();
    state
        .run(move |s| {
            if s.is_some() {
                return Err(AppError::invalid("请先关闭当前项目"));
            }
            let mut media = media
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            let p = LocalProject::create(Path::new(&path), name)?;
            let result = info(&p);
            *s = Some(p);
            playback.reset();
            media.reset();
            analysis.scheduler.reset();
            Ok(result)
        })
        .await
}
#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, path: String) -> Result<OpenProject> {
    let media = state.1.clone();
    let analysis = state.2.clone();
    let playback = state.3.clone();
    state
        .run(move |s| {
            if s.is_some() {
                return Err(AppError::invalid("请先关闭当前项目"));
            }
            let path = Path::new(&path);
            let root = if path.is_file() {
                path.parent()
                    .ok_or_else(|| AppError::invalid("无效项目路径"))?
            } else {
                path
            };
            let mut media = media
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            let p = LocalProject::open(root)?;
            let result = info(&p);
            *s = Some(p);
            playback.reset();
            media.reset();
            analysis.scheduler.reset();
            Ok(result)
        })
        .await
}
#[tauri::command]
pub async fn resolve_recovery(
    state: State<'_, AppState>,
    source: Option<RecoverySource>,
) -> Result<OpenProject> {
    state
        .run(move |s| {
            let p = active(s)?;
            p.resolve_recovery(source)?;
            Ok(info(p))
        })
        .await
}
#[tauri::command]
pub async fn get_project_snapshot(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectSnapshot> {
    state
        .run(move |s| {
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
    project_id: String,
    expected_revision: u64,
    change: Change,
) -> Result<ProjectSnapshot> {
    let media_tasks = state.1.clone();
    let playback = state.3.clone();
    state
        .run(move |s| {
            let mut tasks = media_tasks
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            let prepared = match &change {
                Change::ImportMedia { media } | Change::RelinkMedia { media } => {
                    Some(tasks.prepared(media)?)
                }
                _ => None,
            };
            let before = active(s)?.snapshot()?.document;
            let snapshot =
                active(s)?
                    .session_mut()?
                    .apply_change(&project_id, expected_revision, change)?;
            playback.changed(&before, &snapshot.document);
            if let Some(media) = prepared {
                tasks.commit(media);
            }
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn undo(
    state: State<'_, AppState>,
    project_id: String,
    expected_revision: u64,
) -> Result<ProjectSnapshot> {
    let playback = state.3.clone();
    state
        .run(move |s| {
            let before = active(s)?.snapshot()?.document;
            let snapshot = active(s)?
                .session_mut()?
                .undo(&project_id, expected_revision)?;
            playback.changed(&before, &snapshot.document);
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn redo(
    state: State<'_, AppState>,
    project_id: String,
    expected_revision: u64,
) -> Result<ProjectSnapshot> {
    let playback = state.3.clone();
    state
        .run(move |s| {
            let before = active(s)?.snapshot()?.document;
            let snapshot = active(s)?
                .session_mut()?
                .redo(&project_id, expected_revision)?;
            playback.changed(&before, &snapshot.document);
            Ok(snapshot)
        })
        .await
}
#[tauri::command]
pub async fn save_project(
    state: State<'_, AppState>,
    project_id: String,
    expected_revision: u64,
) -> Result<u64> {
    state
        .run(move |s| active(s)?.save(&project_id, expected_revision))
        .await
}
#[tauri::command]
pub async fn save_project_as(
    state: State<'_, AppState>,
    path: String,
    project_id: String,
    expected_revision: u64,
) -> Result<OpenProject> {
    let media = state.1.clone();
    let analysis = state.2.clone();
    let playback = state.3.clone();
    state
        .run(move |s| {
            let p = active(s)?;
            let mut media = media
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            playback.reset();
            p.save_as(Path::new(&path), &project_id, expected_revision)?;
            media.reset();
            analysis.scheduler.reset();
            Ok(info(p))
        })
        .await
}
#[tauri::command]
pub async fn close_project(
    state: State<'_, AppState>,
    project_id: Option<String>,
    expected_revision: Option<u64>,
    discard: bool,
) -> Result<()> {
    let media = state.1.clone();
    let analysis = state.2.clone();
    let playback = state.3.clone();
    state
        .run(move |s| {
            let mut media = media
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            if let Some(p) = s {
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
            media.reset();
            analysis.scheduler.reset();
            Ok(())
        })
        .await
}
