//! Native-owned admission for paths received from the desktop file-drop event.
use super::{
    collaboration::{catalog, runtime},
    media::DirectTarget,
};
use crate::state::AppState;
use annotator_core::{
    collaboration::CollaborationRepository,
    error::{AppError, ErrorCode, Result},
    media::import_source::validate_source_ancestors,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Arc};
use tauri::State;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DropSession {
    project_id: String,
    runtime_nonce: String,
    shared: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DropKind {
    Audio,
    Zip,
    Folder,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropPreflight {
    session: DropSession,
    kind: DropKind,
    paths: Vec<String>,
    target: Option<DirectTarget>,
}

fn session_for(state: &AppState, project_id: &str) -> Result<DropSession> {
    let current = state.0.lock().map_err(|_| runtime::unavailable())?;
    let project = current
        .as_ref()
        .ok_or_else(|| AppError::invalid("请先打开或新建项目"))?;
    if project.snapshot()?.document.project_id != project_id {
        return Err(drop_stale());
    }
    let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
    Ok(DropSession {
        project_id: project_id.into(),
        runtime_nonce: runtime.nonce.clone(),
        shared: project.is_shared(),
    })
}

// Hold the project authority throughout capability and task-admission checks. The
// probe is deliberately not a reservation: actual import admission repeats it.
fn check(
    state: &AppState,
    session: &DropSession,
    target: &Option<DirectTarget>,
) -> Result<Option<Arc<CollaborationRepository>>> {
    let current = state.0.lock().map_err(|_| runtime::unavailable())?;
    let project = current.as_ref().ok_or_else(drop_stale)?;
    runtime::check_mutation(project, &state.6, Some(&session.runtime_nonce)).map_err(|error| {
        if error.code == ErrorCode::RevisionConflict {
            drop_stale()
        } else {
            error
        }
    })?;
    if project.snapshot()?.document.project_id != session.project_id
        || project.is_shared() != session.shared
    {
        return Err(drop_stale());
    }
    if !catalog::can_import(project) {
        return Err(AppError::invalid("当前项目只读，无法导入音频"));
    }
    if project.recovery().is_some() {
        return Err(AppError::invalid("请先处理项目恢复"));
    }
    if state
        .6
        .sources
        .lock()
        .map_err(|_| runtime::unavailable())?
        .active()
    {
        return Err(AppError::invalid("请先关闭当前导入预览"));
    }
    if state.6.preparing()? {
        return Err(AppError::invalid("请等待当前导入完成"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut tasks = state.1.lock().map_err(|_| runtime::unavailable())?;
    tasks.begin(id.clone())?;
    tasks.finish(&id);
    drop(tasks);
    match (session.shared, target) {
        (false, None) => Ok(None),
        (true, Some(_)) => state
            .6
            .current
            .lock()
            .map_err(|_| runtime::unavailable())?
            .repo
            .clone()
            .ok_or_else(drop_stale)
            .map(Some),
        _ => Err(AppError::invalid("请重新核对当前项目的导入目标")),
    }
}

fn drop_stale() -> AppError {
    AppError::new(ErrorCode::RevisionConflict, "项目会话已变化，请重新拖入")
}

fn source_path_length(raw: &str, kind: DropKind) -> Result<()> {
    // SourceConfig's frontend parser counts UTF-16 code units, matching JS string.length.
    if kind != DropKind::Audio && raw.encode_utf16().count() > 16_384 {
        return Err(AppError::invalid("来源路径过长，请移动来源后重新拖入"));
    }
    Ok(())
}

fn classify(paths: &[String], shared: bool) -> Result<DropKind> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(AppError::invalid(
            "请选择 1–256 个音频文件、最多 32 个 ZIP 或一个文件夹",
        ));
    }
    let mut kind = None;
    for raw in paths {
        if raw.is_empty()
            || raw.encode_utf16().count() > 32768
            || raw.contains('\0')
            || !Path::new(raw).is_absolute()
        {
            return Err(AppError::invalid("来源路径无效，请重新拖入"));
        }
        let path = Path::new(raw);
        // Ordinary direct audio follows links, just like its existing decoder.
        // Shared and scanned sources retain the stricter import-source policy.
        if shared {
            validate_source_ancestors(path).map_err(|_| {
                AppError::invalid("来源不存在、无法读取或包含链接，请检查后重新拖入")
            })?;
        }
        let metadata = fs::metadata(path)
            .map_err(|_| AppError::invalid("来源不存在或无法读取，请检查后重新拖入"))?;
        let this = if metadata.is_dir() {
            DropKind::Folder
        } else if metadata.is_file() {
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or_else(|| AppError::invalid("无效来源文件名"))?
                .to_ascii_lowercase();
            if name.ends_with(".audioproj.zip") {
                return Err(AppError::invalid("项目分享包请使用「导入分享文件…」入口"));
            }
            let extension = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let result = match extension.as_str() {
                "wav" | "flac" | "mp3" => DropKind::Audio,
                "zip" => DropKind::Zip,
                _ => {
                    return Err(AppError::invalid(
                        "仅支持 WAV、FLAC、MP3、ZIP 或文件夹，请分开拖入支持的来源",
                    ))
                }
            };
            result
        } else {
            return Err(AppError::invalid("来源不是普通文件或文件夹，请重新拖入"));
        };
        if !shared && this != DropKind::Audio {
            validate_source_ancestors(path).map_err(|_| {
                AppError::invalid("来源不存在、无法读取或包含链接，请检查后重新拖入")
            })?;
        }
        source_path_length(raw, this)?;
        if this == DropKind::Folder {
            let mut entries = fs::read_dir(path)
                .map_err(|_| AppError::invalid("文件夹无法读取，请检查权限后重新拖入"))?;
            if let Some(entry) = entries.next() {
                entry.map_err(|_| AppError::invalid("文件夹无法读取，请检查权限后重新拖入"))?;
            }
        } else {
            fs::File::open(path)
                .map_err(|_| AppError::invalid("来源文件无法读取，请检查权限后重新拖入"))?;
        }
        if kind.is_some_and(|previous| previous != this) {
            return Err(AppError::invalid("请将音频、ZIP 和文件夹分开拖入"));
        }
        kind = Some(this);
    }
    match kind.expect("nonempty paths") {
        DropKind::Folder if paths.len() != 1 => Err(AppError::invalid("一次只能拖入一个文件夹")),
        DropKind::Zip if paths.len() > 32 => Err(AppError::invalid("一次最多拖入 32 个 ZIP")),
        other => Ok(other),
    }
}

async fn preflight(
    state: &AppState,
    session: DropSession,
    paths: Vec<String>,
    target: Option<DirectTarget>,
) -> Result<DropPreflight> {
    let state_before = state.clone();
    let session_before = session.clone();
    let target_before = target.clone();
    let repo = tauri::async_runtime::spawn_blocking(move || {
        check(&state_before, &session_before, &target_before)
    })
    .await
    .map_err(|_| runtime::unavailable())??;
    let state_worker = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let classified = (|| {
            let kind = classify(&paths, session.shared)?;
            if kind != DropKind::Audio && !session.shared {
                return Err(AppError::invalid("文件夹和 ZIP 导入需要可写的协作项目"));
            }
            if let (Some(repo), Some(target)) = (repo, &target) {
                let capture = repo
                    .capture_media_placement(target.folder_id.clone())
                    .map_err(target_error)?;
                if capture.layout_revision() != target.layout_revision {
                    return Err(AppError::new(
                        ErrorCode::RevisionConflict,
                        "目录布局已变化，请核对目标后重新拖入",
                    ));
                }
            }
            Ok(kind)
        })();
        complete_preflight(&state_worker, session, paths, target, classified)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}

fn complete_preflight(
    state: &AppState,
    session: DropSession,
    paths: Vec<String>,
    target: Option<DirectTarget>,
    classified: Result<DropKind>,
) -> Result<DropPreflight> {
    // Even a failed filesystem inspection must not return into a replaced session.
    check(state, &session, &target)?;
    Ok(DropPreflight {
        session,
        kind: classified?,
        paths,
        target,
    })
}

pub(super) fn target_error(mut error: AppError) -> AppError {
    if error.message == "Target folder no longer exists" {
        error.message = "目标文件夹已不存在，请核对目标后重新拖入或扫描".into();
        error.details = Some(serde_json::json!({ "droppedLayoutConflict": true }));
    }
    error
}

pub(super) fn layout_conflict() -> AppError {
    let mut error = AppError::new(
        ErrorCode::RevisionConflict,
        "目录布局已变化，请核对目标后重新扫描",
    );
    error.details = Some(serde_json::json!({ "droppedLayoutConflict": true }));
    error
}

#[tauri::command]
pub async fn capture_drop_session(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<DropSession> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || session_for(&state, &project_id))
        .await
        .map_err(|_| runtime::unavailable())?
}

#[tauri::command]
pub async fn preflight_drop(
    state: State<'_, AppState>,
    session: DropSession,
    paths: Vec<String>,
    target: Option<DirectTarget>,
) -> Result<DropPreflight> {
    preflight(&state, session, paths, target).await
}

#[cfg(test)]
mod tests;
