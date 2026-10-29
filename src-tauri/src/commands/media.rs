use crate::state::AppState;
use annotator_core::{
    error::{AppError, ErrorCode, Result},
    media::{decode::decode, identity::SourceStamp, registry::same_identity},
    model::MediaDescriptor,
};
use serde::{Deserialize, Serialize};
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

fn required_nullable<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectTarget {
    #[serde(deserialize_with = "required_nullable")]
    pub folder_id: Option<String>,
    pub layout_revision: u64,
}
mod placement;
enum Inputs {
    Paths(Vec<String>, Option<DirectTarget>),
    Sources(super::source_import::Token, Vec<usize>),
    PreparedSources(super::source_import::PreparedBatch),
    PreparedPaths(
        Vec<String>,
        Vec<annotator_core::collaboration::organization::NativePlacementPlan>,
    ),
}
pub(crate) async fn start_sources(
    state: &AppState,
    token: super::source_import::Token,
    indices: Vec<usize>,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    start_inner(
        state,
        Some(token.runtime_nonce.clone()),
        token.project_id.clone(),
        Inputs::Sources(token, indices),
        None,
        on_event,
    )
    .await
}
pub(crate) async fn start(
    state: &AppState,
    runtime_nonce: Option<String>,
    project_id: String,
    paths: Vec<String>,
    relink: Option<String>,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    start_inner(
        state,
        runtime_nonce,
        project_id,
        Inputs::Paths(paths, None),
        relink,
        on_event,
    )
    .await
}
pub(crate) async fn start_targeted(
    state: &AppState,
    runtime_nonce: Option<String>,
    project_id: String,
    paths: Vec<String>,
    target: Option<DirectTarget>,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    start_inner(
        state,
        runtime_nonce,
        project_id,
        Inputs::Paths(paths, target),
        None,
        on_event,
    )
    .await
}
async fn start_inner(
    state: &AppState,
    runtime_nonce: Option<String>,
    project_id: String,
    inputs: Inputs,
    relink: Option<String>,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    let count = match &inputs {
        Inputs::Paths(p, _) => p.len(),
        Inputs::Sources(_, i) => i.len(),
        Inputs::PreparedSources(batch) => batch.indices.len(),
        Inputs::PreparedPaths(paths, _) => paths.len(),
    };
    if count == 0 || count > 256 {
        return Err(AppError::invalid("请选择 1–256 个音频文件"));
    }
    let inputs = match inputs {
        Inputs::Sources(token, indices) => Inputs::PreparedSources(
            super::source_import::prepare_batch(state, token, indices).await?,
        ),
        Inputs::Paths(paths, target) if relink.is_none() => {
            match placement::prepare_direct(
                state,
                runtime_nonce.clone(),
                project_id.clone(),
                paths.clone(),
                target,
            )
            .await?
            {
                Some(placements) => Inputs::PreparedPaths(paths, placements),
                None => Inputs::Paths(paths, None),
            }
        }
        other => other,
    };
    let service = state.6.clone();
    let tasks = state.1.clone();
    let task_id = uuid::Uuid::new_v4().to_string();
    let id = task_id.clone();
    let (
        generation,
        cancel,
        root,
        expected,
        catalog,
        preparation,
        paths,
        sources,
        direct_placements,
    ) = state
        .run(move |s| {
            let project = s
                .as_ref()
                .ok_or_else(|| AppError::invalid("尚未打开项目"))?;
            super::collaboration::runtime::check_mutation(
                project,
                &service,
                runtime_nonce.as_deref(),
            )?;
            let snapshot = project.snapshot()?;
            if snapshot.document.project_id != project_id {
                return Err(AppError::invalid("项目身份不匹配"));
            }
            if !super::collaboration::catalog::can_import(project) && relink.is_none() {
                return Err(AppError::invalid("Shared media catalog is immutable"));
            }
            let (paths, sources, direct_placements) = {
                let registry = service
                    .sources
                    .lock()
                    .map_err(|_| super::collaboration::runtime::unavailable())?;
                match inputs {
                    Inputs::Paths(paths, _) => {
                        if registry.active() {
                            return Err(AppError::invalid("请先关闭当前导入预览"));
                        }
                        (paths, None, vec![])
                    }
                    Inputs::PreparedPaths(paths, placements) => {
                        if registry.active() {
                            return Err(AppError::invalid("请先关闭当前导入预览"));
                        }
                        (paths, None, placements)
                    }
                    Inputs::PreparedSources(batch) => {
                        let current = registry.result(&batch.token)?;
                        if !std::sync::Arc::ptr_eq(&current, &batch.scan) {
                            return Err(super::collaboration::runtime::stale());
                        }
                        let paths = batch
                            .indices
                            .iter()
                            .map(|i| batch.scan.candidates()[*i].display_name.clone())
                            .collect();
                        (
                            paths,
                            Some((batch.scan, batch.indices, batch.placements)),
                            vec![],
                        )
                    }
                    Inputs::Sources(_, _) => {
                        unreachable!("native source preflight precedes admission")
                    }
                }
            };
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
            let catalog = if project.is_shared() && expected.is_none() {
                let runtime = service
                    .current
                    .lock()
                    .map_err(|_| super::collaboration::runtime::unavailable())?;
                Some((
                    runtime
                        .repo
                        .clone()
                        .ok_or_else(super::collaboration::runtime::stale)?,
                    runtime.nonce.clone(),
                ))
            } else {
                None
            };
            let mut tasks = tasks
                .lock()
                .map_err(|_| AppError::invalid("媒体服务不可用"))?;
            let (generation, cancel) = tasks.begin(id.clone())?;
            if let Some(expected) = &expected {
                if let Err(error) = tasks.bind_media(&id, &expected.id) {
                    tasks.finish(&id);
                    return Err(error);
                }
            }
            let preparation = if catalog.is_some() {
                match service.begin_preparation(id.clone(), cancel.clone()) {
                    Ok(permit) => Some(permit),
                    Err(error) => {
                        tasks.finish(&id);
                        return Err(error);
                    }
                }
            } else {
                None
            };
            Ok((
                generation,
                cancel,
                project.root().to_path_buf(),
                expected,
                catalog,
                preparation,
                paths,
                sources,
                direct_placements,
            ))
        })
        .await?;
    let tasks = state.1.clone();
    let service = state.6.clone();
    let id = task_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A runtime reset cancels this token; admission stays held through all preparation work.
        // OS temp is independent of the project folder and never becomes project content.
        let cache = std::env::temp_dir().join("audio-annotator-pcm");
        #[cfg(test)]
        service.run_hook();
        let (sources, mut placements) = match sources {
            Some((scan, indices, placements)) => (Some((scan, indices)), placements.into_iter()),
            None => (None, direct_placements.into_iter()),
        };
        let mut staging = sources.as_ref().map(|(scan, _)| scan.staging_session());
        for (index, raw) in paths.iter().enumerate() {
            let placement = placements.next();
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
            let mut progress = |phase: &str, completed| {
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
            };
            let staged = if let Some((_, indices)) = &sources {
                staging
                    .as_mut()
                    .unwrap()
                    .stage(indices[index], &std::env::temp_dir(), &cancel, |n| {
                        progress("extract", n)
                    })
                    .map(Some)
            } else {
                Ok(None)
            };
            let result = staged.and_then(|staged| {
                let path = staged.as_ref().map_or(path.as_path(), |s| s.path());
                if let Some((repo, nonce)) = &catalog {
                    let prepared = if let Some(placement) = placement {
                        repo.prepare_media_with_placement(
                            path, &cache, &cancel, placement, progress,
                        )
                    } else {
                        repo.prepare_media_with_progress(path, &cache, &cancel, progress)
                    };
                    prepared.and_then(|prepared| {
                        let prepared = if sources.is_some() {
                            prepared.with_display_name(raw.clone())?
                        } else {
                            prepared
                        };
                        annotator_core::media::identity::check_cancel(&cancel)?;
                        if staged.is_some() {
                            super::collaboration::catalog::store_prepared_source(
                                &service, nonce, &id, prepared, staged,
                            )
                        } else {
                            super::collaboration::catalog::store_prepared(
                                &service, nonce, &id, prepared,
                            )
                        }
                    })
                } else {
                    decode(path, &cache, &cancel, progress).and_then(|mut decoded| {
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
                    })
                }
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
                        let _ = super::collaboration::catalog::release(&service, &id, &media.id);
                    }
                }
                cancel.store(true, Ordering::Relaxed);
                break;
            }
        }
        if let Ok(mut tasks) = tasks.lock() {
            tasks.finish(&id);
        }
        // Finished is the next-batch barrier, including a synchronous channel callback.
        drop(preparation);
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
    runtime_nonce: Option<String>,
    project_id: String,
    paths: Vec<String>,
    target: Option<DirectTarget>,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    start_targeted(&state, runtime_nonce, project_id, paths, target, on_event).await
}
#[tauri::command]
pub async fn relink_media(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
    media_id: String,
    path: String,
    on_event: Channel<MediaEvent>,
) -> Result<String> {
    start(
        &state,
        runtime_nonce,
        project_id,
        vec![path],
        Some(media_id),
        on_event,
    )
    .await
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
    release(&state, &task_id, &media_id)
}
pub(crate) fn release(state: &AppState, task_id: &str, media_id: &str) -> Result<()> {
    state
        .1
        .lock()
        .map_err(|_| AppError::invalid("媒体服务不可用"))?
        .release_for_task(task_id, media_id);
    super::collaboration::catalog::release(&state.6, task_id, media_id)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    media_id: String,
    status: &'static str,
}
// Filter before registry capture or filesystem work. Explicit empty/unknown
// selections must never silently fall back to a whole-project source scan.
fn selected_media(
    media: Vec<MediaDescriptor>,
    ids: Option<Vec<String>>,
) -> Result<Vec<MediaDescriptor>> {
    let Some(ids) = ids else { return Ok(media) };
    let requested: std::collections::HashSet<_> = ids.into_iter().collect();
    if requested.contains("") {
        return Err(AppError::invalid("未知音频"));
    }
    let selected: Vec<_> = media
        .into_iter()
        .filter(|m| requested.contains(&m.id))
        .collect();
    if selected.len() != requested.len() {
        return Err(AppError::invalid("未知音频"));
    }
    Ok(selected)
}

fn source_status(
    media: &MediaDescriptor,
    source: &Path,
    entry: Option<SourceStamp>,
) -> MediaStatus {
    let status = match SourceStamp::read(source) {
        Err(_) => "missing",
        Ok(stamp) if stamp.bytes != media.byte_length => "changed",
        Ok(stamp) => match entry {
            Some(verified) if verified == stamp => "ready",
            Some(_) => "changed",
            None => "unverified",
        },
    };
    MediaStatus {
        media_id: media.id.clone(),
        status,
    }
}
#[tauri::command]
pub async fn media_status(
    state: State<'_, AppState>,
    runtime_nonce: Option<String>,
    project_id: String,
    media_ids: Option<Vec<String>>,
) -> Result<Vec<MediaStatus>> {
    let tasks = state.1.clone();
    let service = state.6.clone();
    let capture = state
        .run(move |s| {
            let p = s
                .as_ref()
                .ok_or_else(|| AppError::invalid("No active project"))?;
            super::collaboration::runtime::check_mutation(p, &service, runtime_nonce.as_deref())?;
            let d = p.snapshot()?.document;
            if d.project_id != project_id {
                return Err(AppError::invalid("Project identity mismatch"));
            }
            let media = selected_media(d.media, media_ids)?;
            let tasks = tasks
                .lock()
                .map_err(|_| AppError::invalid("Media unavailable"))?;
            let entries = media
                .iter()
                .map(|m| tasks.registry.verified_stamp(m))
                .collect::<Vec<_>>();
            Ok((media, p.root().to_path_buf(), entries, tasks.generation()))
        })
        .await?;
    let generation = capture.3;
    let statuses = tauri::async_runtime::spawn_blocking(move || {
        capture
            .0
            .iter()
            .zip(capture.2)
            .map(|(m, entry)| {
                let source = PathBuf::from(&m.source_ref);
                let source = if source.is_absolute() {
                    source
                } else {
                    capture.1.join(source)
                };
                source_status(m, &source, entry)
            })
            .collect()
    })
    .await
    .map_err(|_| AppError::invalid("Media task interrupted"))?;
    if state
        .1
        .lock()
        .map_err(|_| AppError::invalid("Media unavailable"))?
        .generation()
        != generation
    {
        return Err(super::collaboration::runtime::stale());
    }
    Ok(statuses)
}

#[cfg(test)]
mod status_tests {
    use super::*;

    fn descriptor() -> MediaDescriptor {
        let document: annotator_core::model::ProjectDocument =
            serde_json::from_str(include_str!("../../../tests/fixtures/document-v3.json")).unwrap();
        document.media[0].clone()
    }

    #[test]
    fn scoped_status_selects_only_requested_descriptors_without_full_scan_fallback() {
        let first = descriptor();
        let mut other = first.clone();
        other.id = "another".into();
        other.source_ref = "unrelated/source/must/not/be/checked.wav".into();
        let all = vec![first.clone(), other];
        let selected =
            selected_media(all.clone(), Some(vec![first.id.clone(), first.id.clone()])).unwrap();
        assert_eq!(selected, vec![first]);
        assert!(selected_media(all.clone(), Some(vec![]))
            .unwrap()
            .is_empty());
        assert_eq!(selected_media(all.clone(), None).unwrap(), all);
        for ids in [
            vec!["unknown".into()],
            vec!["".into()],
            vec![all[0].id.clone(), "unknown".into()],
        ] {
            assert!(selected_media(all.clone(), Some(ids)).is_err());
        }
    }

    #[test]
    fn scoped_source_verification_preserves_missing_changed_and_unverified_states() {
        let root = std::env::temp_dir().join(format!("annotator-status-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source.wav");
        let mut media = descriptor();
        std::fs::write(&source, b"source").unwrap();
        media.byte_length = 6;
        let stamp = SourceStamp::read(&source).unwrap();
        assert_eq!(
            source_status(&media, &source, Some(stamp.clone())).status,
            "ready"
        );
        assert_eq!(source_status(&media, &source, None).status, "unverified");
        let mut old_stamp = stamp.clone();
        old_stamp.modified = std::time::UNIX_EPOCH;
        assert_eq!(
            source_status(&media, &source, Some(old_stamp)).status,
            "changed"
        );
        std::fs::write(&source, b"changed source bytes").unwrap();
        assert_eq!(
            source_status(&media, &source, Some(stamp)).status,
            "changed"
        );
        std::fs::remove_file(&source).unwrap();
        assert_eq!(source_status(&media, &source, None).status, "missing");
        std::fs::remove_dir(root).unwrap();
    }
}
