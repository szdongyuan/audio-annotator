use crate::state::AppState;
use annotator_core::{
    error::{AppError, ErrorCode, Result},
    media::{decode::decode, identity::SourceStamp, registry::same_identity},
    model::MediaDescriptor,
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MediaEvent {
    Progress {
        task_id: String,
        index: usize,
        path: String,
        phase: String,
        completed: u64,
    },
    Ready {
        task_id: String,
        index: usize,
        media: MediaDescriptor,
    },
    Failed {
        task_id: String,
        index: usize,
        path: String,
        error: AppError,
    },
    Finished {
        task_id: String,
        cancelled: bool,
    },
}

async fn start(
    state: &AppState,
    project_id: String,
    paths: Vec<String>,
    relink: Option<String>,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(AppError::invalid("请选择 1–256 个音频文件"));
    }
    let tasks = state.1.clone();
    let task_id = uuid::Uuid::new_v4().to_string();
    let id = task_id.clone();
    let (generation, cancel, root, expected) = state
        .run(move |s| {
            let project = s
                .as_ref()
                .ok_or_else(|| AppError::invalid("尚未打开项目"))?;
            let snapshot = project.snapshot()?;
            if snapshot.document.project_id != project_id {
                return Err(AppError::invalid("项目身份不匹配"));
            }
            let expected = relink
                .map(|id| {
                    snapshot
                        .document
                        .media
                        .into_iter()
                        .find(|m| m.id == id)
                        .ok_or_else(|| AppError::invalid("未知音频"))
                })
                .transpose()?;
            let (generation, cancel) = tasks
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?
                .begin(id)?;
            Ok((generation, cancel, project.root().to_path_buf(), expected))
        })
        .await?;
    let tasks = state.1.clone();
    let id = task_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // OS temp is independent of the project folder and never becomes project content.
        let cache = std::env::temp_dir().join("audio-annotator-pcm");
        for (index, raw) in paths.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let path = Path::new(raw);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            };
            let mut last = Instant::now() - Duration::from_secs(1);
            let result = decode(&path, &cache, &cancel, |phase, completed| {
                if last.elapsed() >= Duration::from_millis(100) {
                    last = Instant::now();
                    if on_event
                        .send(MediaEvent::Progress {
                            task_id: id.clone(),
                            index,
                            path: raw.clone(),
                            phase: phase.into(),
                            completed,
                        })
                        .is_err()
                    {
                        cancel.store(true, Ordering::Relaxed);
                    }
                }
            })
            .and_then(|mut decoded| {
                if let Some(expected) = &expected {
                    if !same_identity(expected, &decoded.descriptor) {
                        return Err(AppError::new(
                            ErrorCode::IdentityMismatch,
                            "原文件指纹或音频元数据不一致，无法关联",
                        ));
                    }
                    decoded.descriptor.id = expected.id.clone();
                }
                tasks
                    .lock()
                    .map_err(|_| AppError::invalid("媒体服务不可用"))?
                    .prepare_for_task(generation, &id, decoded)
            });
            let event = match result {
                Ok(media) => MediaEvent::Ready {
                    task_id: id.clone(),
                    index,
                    media,
                },
                Err(error) => MediaEvent::Failed {
                    task_id: id.clone(),
                    index,
                    path: raw.clone(),
                    error,
                },
            };
            if on_event.send(event.clone()).is_err() {
                if let MediaEvent::Ready { media, .. } = event {
                    if let Ok(mut tasks) = tasks.lock() {
                        tasks.release_for_task(&id, &media.id);
                    }
                }
                cancel.store(true, Ordering::Relaxed);
                break;
            }
        }
        if let Ok(mut tasks) = tasks.lock() {
            tasks.finish(&id);
        }
        let _ = on_event.send(MediaEvent::Finished {
            task_id: id,
            cancelled: cancel.load(Ordering::Relaxed),
        });
    });
    Ok(task_id)
}

#[tauri::command]
pub async fn import_media(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    start(&state, project_id, paths, None, on_event).await
}
#[tauri::command]
pub async fn relink_media(
    state: State<'_, AppState>,
    project_id: String,
    media_id: String,
    path: String,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    start(&state, project_id, vec![path], Some(media_id), on_event).await
}
#[tauri::command]
pub fn cancel_media_import(state: State<'_, AppState>, task_id: String) -> Result<()> {
    state
        .1
        .lock()
        .map_err(|_| AppError::invalid("媒体服务不可用"))?
        .cancel(&task_id);
    Ok(())
}
#[tauri::command]
pub fn release_media_import(
    state: State<'_, AppState>,
    task_id: String,
    media_id: String,
) -> Result<()> {
    state
        .1
        .lock()
        .map_err(|_| AppError::invalid("媒体服务不可用"))?
        .release_for_task(&task_id, &media_id);
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    media_id: String,
    status: &'static str,
}
#[tauri::command]
pub async fn media_status(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<MediaStatus>> {
    let tasks = state.1.clone();
    state
        .run(move |s| {
            let p = s
                .as_ref()
                .ok_or_else(|| AppError::invalid("尚未打开项目"))?;
            let snapshot = p.snapshot()?;
            if snapshot.document.project_id != project_id {
                return Err(AppError::invalid("项目身份不匹配"));
            }
            let tasks = tasks
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            Ok(snapshot
                .document
                .media
                .iter()
                .map(|m| {
                    let path = PathBuf::from(&m.source_ref);
                    let path = if path.is_absolute() {
                        path
                    } else {
                        p.root().join(path)
                    };
                    let status = match SourceStamp::read(&path) {
                        Err(_) => "missing",
                        Ok(stamp) if stamp.bytes != m.byte_length => "changed",
                        Ok(_) => match tasks.registry.get_checked(m) {
                            Ok(_) => "ready",
                            Err(e) if e.code == ErrorCode::IdentityMismatch => "changed",
                            Err(_) => "unverified",
                        },
                    };
                    MediaStatus {
                        media_id: m.id.clone(),
                        status,
                    }
                })
                .collect())
        })
        .await
}
