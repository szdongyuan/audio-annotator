use crate::state::AppState;
use annotator_core::{
    error::{AppError, Result},
    media::folder_scan::{self, FolderEvent, Limits, Page, PageKind, ScanToken},
};
use std::{
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};

#[tauri::command]
pub async fn scan_folder(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
    path: String,
    recursive: bool,
    on_event: Channel<FolderEvent>,
) -> Result<ScanToken> {
    start(&state, runtime_nonce, project_id, path, recursive, on_event).await
}
pub(crate) async fn start(
    state: &AppState,
    runtime_nonce: Option<String>,
    project_id: String,
    path: String,
    recursive: bool,
    on_event: Channel<FolderEvent>,
) -> Result<ScanToken> {
    let service = state.6.clone();
    let tasks = state.5.clone();
    let (token, cancel, root, existing) = state
        .run(move |s| {
            let project = s
                .as_ref()
                .ok_or_else(|| AppError::invalid("尚未打开项目"))?;
            super::collaboration::runtime::check_mutation(
                project,
                &service,
                runtime_nonce.as_deref(),
            )?;
            if !super::collaboration::catalog::can_import(project) {
                return Err(AppError::invalid("Shared media catalog is immutable"));
            }
            let snapshot = project.snapshot()?;
            if snapshot.document.project_id != project_id {
                return Err(AppError::invalid("项目身份不匹配"));
            }
            let (token, cancel) = tasks
                .lock()
                .map_err(|_| AppError::invalid("扫描服务不可用"))?
                .begin()?;
            Ok((
                token,
                cancel,
                project.root().to_path_buf(),
                snapshot
                    .document
                    .media
                    .into_iter()
                    .map(|m| m.source_ref)
                    .collect::<Vec<_>>(),
            ))
        })
        .await?;
    let tasks = state.5.clone();
    let worker_token = token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        // The project authority lock is deliberately absent throughout filesystem traversal.
        let result = folder_scan::scan(
            Path::new(&path),
            &root,
            &existing,
            recursive,
            &cancel,
            Limits::default(),
            |counts| {
                if last.elapsed() >= Duration::from_millis(100) {
                    last = Instant::now();
                    if let Ok(tasks) = tasks.lock() {
                        if tasks.is_current(&worker_token)
                            && on_event
                                .send(FolderEvent::Progress {
                                    token: worker_token.clone(),
                                    counts: counts.clone(),
                                })
                                .is_err()
                        {
                            cancel.store(true, Ordering::Relaxed);
                        }
                    }
                }
            },
        );
        // Serialize publication with reset; a released/reset owner cannot publish a terminal result.
        if let Ok(mut tasks) = tasks.lock() {
            if let Ok(event) = tasks.complete(&worker_token, result) {
                if on_event.send(event).is_err() {
                    let _ = tasks.release(&worker_token);
                }
            }
        }
    });
    Ok(token)
}

#[tauri::command]
pub fn folder_scan_page(
    state: State<'_, AppState>,
    token: ScanToken,
    kind: PageKind,
    offset: usize,
    limit: usize,
) -> Result<Page> {
    state
        .5
        .lock()
        .map_err(|_| AppError::invalid("扫描服务不可用"))?
        .page(&token, kind, offset, limit)
}
#[tauri::command]
pub fn cancel_folder_scan(state: State<'_, AppState>, token: ScanToken) -> Result<()> {
    state
        .5
        .lock()
        .map_err(|_| AppError::invalid("扫描服务不可用"))?
        .cancel(&token)
}
#[tauri::command]
pub fn release_folder_scan(state: State<'_, AppState>, token: ScanToken) -> Result<()> {
    state
        .5
        .lock()
        .map_err(|_| AppError::invalid("扫描服务不可用"))?
        .release(&token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use annotator_core::project::LocalProject;
    use std::{fs, sync::mpsc};
    use tauri::ipc::InvokeResponseBody;

    #[test]
    fn background_channel_reports_terminal_without_holding_project_lock() {
        let root =
            std::env::temp_dir().join(format!("annotator-folder-host-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let project_root = root.join("project");
        fs::create_dir(&project_root).unwrap();
        let audio = root.join("audio");
        fs::create_dir(&audio).unwrap();
        fs::write(audio.join("a.WAV"), b"discovery").unwrap();
        let state = AppState::default();
        let project = LocalProject::create(&project_root, "scan".into()).unwrap();
        let id = project.snapshot().unwrap().document.project_id;
        *state.0.lock().unwrap() = Some(project);
        let captured = state.clone();
        let (send, receive) = mpsc::channel();
        let channel = Channel::new(move |body| {
            assert!(
                captured.0.try_lock().is_ok(),
                "walking/publication must not hold project authority"
            );
            let InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON")
            };
            send.send(serde_json::from_str::<serde_json::Value>(&json).unwrap())
                .unwrap();
            Ok(())
        });
        let token = tauri::async_runtime::block_on(start(
            &state,
            None,
            id,
            audio.to_string_lossy().into_owned(),
            false,
            channel,
        ))
        .unwrap();
        let progress = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(progress["type"], "progress");
        let terminal = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(terminal["type"], "result");
        assert_eq!(terminal["counts"]["candidates"], 1);
        assert_eq!(
            state
                .5
                .lock()
                .unwrap()
                .page(&token, PageKind::Candidates, 0, 256)
                .unwrap()
                .candidates
                .len(),
            1
        );
        state.5.lock().unwrap().release(&token).unwrap();
        *state.0.lock().unwrap() = None;
        let owned = fs::canonicalize(&root).unwrap();
        assert!(owned.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
        assert!(owned
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("annotator-folder-host-"));
        fs::remove_dir_all(owned).unwrap();
    }
}
