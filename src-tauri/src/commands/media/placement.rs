use super::DirectTarget;
use crate::{
    commands::collaboration::{catalog, runtime},
    state::AppState,
};
use annotator_core::{
    collaboration::organization::NativePlacementPlan,
    error::{AppError, Result},
};
use std::path::Path;
pub(super) async fn prepare_direct(
    state: &AppState,
    nonce: Option<String>,
    project_id: String,
    paths: Vec<String>,
    target: Option<DirectTarget>,
) -> Result<Option<Vec<NativePlacementPlan>>> {
    let explicit_target = target.is_some();
    let service = state.6.clone();
    let repo = state
        .run(move |current| {
            let project = current.as_ref().ok_or_else(runtime::stale)?;
            runtime::check_mutation(project, &service, nonce.as_deref())?;
            if project.snapshot()?.document.project_id != project_id {
                return Err(runtime::stale());
            }
            if !project.is_shared() && !explicit_target {
                return Ok(None);
            }
            if !project.is_shared() || !catalog::can_import(project) {
                return Err(AppError::invalid("目录目标仅适用于当前可写协作项目"));
            }
            if service
                .sources
                .lock()
                .map_err(|_| runtime::unavailable())?
                .active()
            {
                return Err(AppError::invalid("请先关闭当前导入预览"));
            }
            service
                .current
                .lock()
                .map_err(|_| runtime::unavailable())?
                .repo
                .clone()
                .ok_or_else(runtime::stale)
                .map(Some)
        })
        .await?;
    let Some(repo) = repo else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let capture =
            repo.capture_media_placement(target.as_ref().and_then(|t| t.folder_id.clone()))?;
        if target.is_some_and(|t| capture.layout_revision() != t.layout_revision) {
            return Err(runtime::stale());
        }
        paths
            .iter()
            .map(|raw| {
                let name = Path::new(raw)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| AppError::invalid("无效源文件名"))?;
                capture.seal(vec![], name.into())
            })
            .collect::<Result<Vec<_>>>()
            .map(Some)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
