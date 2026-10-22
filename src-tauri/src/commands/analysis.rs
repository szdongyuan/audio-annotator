use crate::state::AppState;
use annotator_core::{
    analysis::{
        cache::{TileCache, DISK_CACHE_BYTES, TILE_CACHE_BYTES},
        scheduler::Scheduler,
        tiles::{
            compute_tile, config_hash, decode_cached, encode_cached, encode_tile, TileRequest,
        },
    },
    error::{AppError, ErrorCode, Result},
    media::{
        decode::rehydrate, identity::check_cancel, pcm_cache::PcmCache, registry::same_identity,
    },
    model::MediaDescriptor,
};
use serde::Serialize;
use std::{
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    ipc::{Channel, Response},
    State,
};

pub struct AnalysisRuntime {
    pub scheduler: Scheduler,
    cache: Mutex<Option<TileCache>>,
    pcm: Mutex<PcmCache>,
    // Only analysis workers wait here. Recheck registry after waiting to avoid duplicate decode.
    pub(crate) hydration: Mutex<()>,
}
impl Default for AnalysisRuntime {
    fn default() -> Self {
        Self {
            scheduler: Scheduler::default(),
            cache: Mutex::new(None),
            pcm: Mutex::new(PcmCache::for_analysis()),
            hydration: Mutex::new(()),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileProgress {
    request_id: String,
    view_id: String,
    generation: u64,
    phase: String,
    completed: u64,
    total: u64,
}
fn failure() -> AppError {
    AppError::new(ErrorCode::Cancelled, "项目、媒体或分析设置已更新")
}
fn current(
    state: &AppState,
    request: &TileRequest,
    expected: &MediaDescriptor,
    generation: u64,
) -> Result<()> {
    let project = state.0.lock().map_err(|_| failure())?;
    let project = project.as_ref().ok_or_else(failure)?;
    let snapshot = project.snapshot()?;
    if snapshot.document.project_id != request.project_id {
        return Err(failure());
    }
    let actual = snapshot
        .document
        .media
        .iter()
        .find(|m| m.id == request.media_id)
        .ok_or_else(failure)?;
    let settings = snapshot
        .document
        .analysis
        .get(&request.media_id)
        .cloned()
        .unwrap_or_default();
    if !same_identity(actual, expected)
        || actual.source_ref != expected.source_ref
        || config_hash(&settings) != request.config_hash
    {
        return Err(failure());
    }
    if state.1.lock().map_err(|_| failure())?.generation() != generation {
        return Err(failure());
    }
    Ok(())
}
/// Capture authority and enqueue under the short project lock. All decode/FFT/cache I/O
/// runs on the two scheduler workers after that lock has been released.
fn enqueue(
    state: AppState,
    request: TileRequest,
    send: impl Fn(TileProgress) -> bool + Send + 'static,
) -> Result<mpsc::Receiver<Result<Vec<u8>>>> {
    request.validate()?;
    let lock = state.0.lock().map_err(|_| failure())?;
    let project = lock.as_ref().ok_or_else(failure)?;
    let snapshot = project.snapshot()?;
    if snapshot.document.project_id != request.project_id {
        return Err(failure());
    }
    let descriptor = snapshot
        .document
        .media
        .iter()
        .find(|m| m.id == request.media_id)
        .cloned()
        .ok_or_else(|| AppError::invalid("未知媒体"))?;
    if request.channel_index >= descriptor.channel_count {
        return Err(AppError::invalid("媒体通道越界"));
    }
    if request.start_frame
        >= annotator_core::analysis::stft::frame_count(
            descriptor.frame_count,
            request.settings.hop_size,
        )
    {
        return Err(AppError::invalid("分析帧范围越界"));
    }
    let settings = snapshot
        .document
        .analysis
        .get(&request.media_id)
        .cloned()
        .unwrap_or_default();
    if config_hash(&settings) != request.config_hash {
        return Err(failure());
    }
    let root = project.root().to_path_buf();
    let generation = state.1.lock().map_err(|_| failure())?.generation();
    let scope = request.view_id.clone();
    let worker_state = state.clone();
    state
        .2
        .scheduler
        .submit(&scope, request.generation, request.visible, move |cancel| {
            let state = worker_state;
            let mut last = Instant::now() - Duration::from_secs(1);
            let mut progress = |phase: &str, completed: u64, total: u64| {
                if last.elapsed() >= Duration::from_millis(100) || completed == total {
                    last = Instant::now();
                    if !send(TileProgress {
                        request_id: request.request_id.clone(),
                        view_id: request.view_id.clone(),
                        generation: request.generation,
                        phase: phase.into(),
                        completed,
                        total,
                    }) {
                        cancel.store(true, std::sync::atomic::Ordering::Release);
                    }
                }
            };
            let media = {
                let _hydrate = state.2.hydration.lock().map_err(|_| failure())?;
                check_cancel(cancel)?;
                current(&state, &request, &descriptor, generation)?;
                let existing = state
                    .1
                    .lock()
                    .map_err(|_| failure())?
                    .registry
                    .get_unverified(&descriptor);
                match existing {
                    Ok(media) => {
                        media.verify_source()?;
                        media
                    }
                    Err(_) => {
                        let decoded = rehydrate(
                            &descriptor,
                            &root,
                            &std::env::temp_dir().join("audio-annotator-pcm"),
                            cancel,
                            |phase, n| progress(phase, n, 0),
                        )?;
                        check_cancel(cancel)?;
                        current(&state, &request, &descriptor, generation)?;
                        state
                            .1
                            .lock()
                            .map_err(|_| failure())?
                            .publish_rehydrated(generation, decoded)?
                    }
                }
            };
            check_cancel(cancel)?;
            let key = request.cache_key(
                &descriptor.sha256,
                descriptor.sample_rate,
                descriptor.frame_count,
            );
            let cached = {
                let mut cache = state.2.cache.lock().map_err(|_| failure())?;
                if cache.is_none() {
                    *cache = TileCache::new(
                        std::env::temp_dir().join("audio-annotator-tiles-v1"),
                        TILE_CACHE_BYTES,
                        DISK_CACHE_BYTES,
                    )
                    .ok();
                }
                cache
                    .as_mut()
                    .and_then(|c| c.get(&key).ok().flatten())
                    .and_then(|bytes| decode_cached(&bytes))
            };
            let tile = match cached {
                Some(tile) => tile,
                None => {
                    let tile = compute_tile(
                        &request,
                        descriptor.sample_rate,
                        descriptor.frame_count,
                        cancel,
                        |start, count| {
                            check_cancel(cancel)?;
                            let interleaved = state
                                .2
                                .pcm
                                .lock()
                                .map_err(|_| failure())?
                                .read_frames(&media.pcm, start, count)?;
                            Ok(interleaved
                                .chunks_exact(usize::from(descriptor.channel_count))
                                .map(|frame| frame[usize::from(request.channel_index)])
                                .collect())
                        },
                        |done, total| progress("analysis", done, total),
                    )?;
                    // Cache failures are disposable; a valid computed tile remains usable.
                    if let Ok(bytes) = encode_cached(&tile) {
                        if let Ok(mut cache) = state.2.cache.lock() {
                            if let Some(cache) = cache.as_mut() {
                                let _ = cache.put(&key, bytes);
                            }
                        }
                    }
                    tile
                }
            };
            check_cancel(cancel)?;
            media.verify_source()?;
            current(&state, &request, &descriptor, generation)?;
            progress("ready", tile.source_frames, tile.source_frames);
            check_cancel(cancel)?;
            encode_tile(&request, &tile)
        })
}
#[tauri::command]
pub async fn request_tile(
    state: State<'_, AppState>,
    request: TileRequest,
    on_event: Channel<TileProgress>,
) -> Result<Response> {
    let state = state.inner().clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        enqueue(state, request, move |event| on_event.send(event).is_ok())?
            .recv()
            .map_err(|_| AppError::new(ErrorCode::AnalysisFailed, "分析任务中断"))?
    })
    .await
    .map_err(|_| AppError::new(ErrorCode::AnalysisFailed, "分析服务中断"))??;
    Ok(Response::new(bytes))
}
#[tauri::command]
pub async fn register_analysis_view(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<String> {
    let runtime = state.2.clone();
    state
        .run(move |s| {
            if s.as_ref()
                .ok_or_else(failure)?
                .snapshot()?
                .document
                .project_id
                != project_id
            {
                return Err(failure());
            }
            runtime.scheduler.register_view()
        })
        .await
}
#[tauri::command]
pub async fn retire_analysis_view(
    state: State<'_, AppState>,
    project_id: String,
    view_id: String,
) -> Result<()> {
    if view_id.is_empty() || view_id.len() > 128 {
        return Err(AppError::invalid("无效分析视图"));
    }
    let runtime = state.2.clone();
    state
        .run(move |s| {
            if s.as_ref()
                .ok_or_else(failure)?
                .snapshot()?
                .document
                .project_id
                != project_id
            {
                return Err(failure());
            }
            runtime.scheduler.retire_view(&view_id)
        })
        .await
}
#[tauri::command]
pub async fn cancel_generation(
    state: State<'_, AppState>,
    project_id: String,
    view_id: String,
    generation: u64,
) -> Result<()> {
    if view_id.is_empty() || view_id.len() > 128 || generation > 9_007_199_254_740_991 {
        return Err(AppError::invalid("无效分析视图"));
    }
    let runtime = state.2.clone();
    state
        .run(move |s| {
            let snapshot = s.as_ref().ok_or_else(failure)?.snapshot()?;
            if snapshot.document.project_id != project_id {
                return Err(failure());
            }
            runtime.scheduler.cancel_generation(&view_id, generation)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use annotator_core::{media::decode::decode, model::Change, project::LocalProject};
    use std::sync::atomic::AtomicBool;
    #[test]
    fn native_service_reopens_without_relink_preserves_document_and_checks_current_identity() {
        let root = std::env::temp_dir().join(format!("native-tiles-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let state = AppState::default();
        let mut project = LocalProject::create(&root, "test".into()).unwrap();
        let path = root.join("audio.wav");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio/mono16.wav");
        std::fs::copy(fixture, &path).unwrap();
        let decoded = decode(&path, &root.join("pcm"), &AtomicBool::new(false), |_, _| {}).unwrap();
        let mut descriptor = decoded.descriptor.clone();
        descriptor.source_ref = "audio.wav".into();
        drop(decoded);
        let project_id = project.snapshot().unwrap().document.project_id;
        let snapshot = project
            .session_mut()
            .unwrap()
            .apply_change(
                &project_id,
                0,
                Change::ImportMedia {
                    media: descriptor.clone(),
                },
            )
            .unwrap();
        *state.0.lock().unwrap() = Some(project);
        let settings = snapshot.document.analysis[&descriptor.id].clone();
        let request = TileRequest {
            request_id: "test".into(),
            view_id: state.2.scheduler.register_view().unwrap(),
            project_id: project_id.clone(),
            media_id: descriptor.id.clone(),
            generation: 1,
            config_hash: config_hash(&settings),
            settings,
            channel_index: 0,
            kind: annotator_core::model::SpectrumKind::Stft,
            start_frame: 0,
            frame_count: 256,
            time_lod: 0,
            frequency_start: 0,
            frequency_count: 1025,
            frequency_lod: 0,
            visible: true,
        };
        let bytes = enqueue(state.clone(), request.clone(), |_| true)
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert_eq!(&bytes[..4], b"AT01");
        assert_eq!(
            state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .snapshot()
                .unwrap(),
            snapshot
        );
        assert!(state
            .1
            .lock()
            .unwrap()
            .registry
            .get_checked(&descriptor)
            .is_ok());
        // Exercise the actual native enqueue/cache/encode path beyond the old
        // historical-owner limit, then reopen the SAME project identity.
        for _ in 0..300 {
            let mut churn = request.clone();
            churn.view_id = state.2.scheduler.register_view().unwrap();
            assert_eq!(
                &enqueue(state.clone(), churn.clone(), |_| true)
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                    .unwrap()[..4],
                b"AT01"
            );
            state.2.scheduler.retire_view(&churn.view_id).unwrap();
            assert_eq!(
                enqueue(state.clone(), churn, |_| true).unwrap_err().code,
                ErrorCode::Cancelled
            );
        }
        assert_eq!(state.2.scheduler.live_views(), 1);
        {
            let mut current = state.0.lock().unwrap();
            current
                .as_mut()
                .unwrap()
                .save(&project_id, snapshot.document.revision)
                .unwrap();
            *current = None;
            state.2.scheduler.reset();
            state.1.lock().unwrap().reset();
            *current = Some(LocalProject::open(&root).unwrap());
        }
        assert_eq!(
            enqueue(state.clone(), request.clone(), |_| true)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        let old_view = request.view_id.clone();
        let mut request = request;
        request.view_id = state.2.scheduler.register_view().unwrap();
        assert_ne!(old_view, request.view_id);
        assert!(state.2.scheduler.cancel_generation(&old_view, 999).is_err());
        assert!(state.2.scheduler.retire_view(&old_view).is_err());
        assert!(enqueue(state.clone(), request.clone(), |_| true)
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .is_ok());
        std::fs::write(&path, b"changed").unwrap();
        let error = enqueue(state.clone(), request, |_| true)
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::IdentityMismatch);
        state.2.scheduler.reset();
        state.1.lock().unwrap().reset();
        *state.0.lock().unwrap() = None;
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
