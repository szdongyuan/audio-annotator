//! Read-only, generation-bound authority. Only the audio output runtime is shared.
use super::*;
use crate::commands::{
    analysis::TileProgress,
    playback::{PlaybackRequest, PlaybackStatus},
};
use annotator_core::{
    analysis::{source::AnalysisSource, tiles::TileRequest},
    audio::PlaybackMode,
    model::{AnalysisSettings, ProjectDocument},
    project::ProjectSnapshot,
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::ipc::{Channel, Response};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPreview {
    preview_id: String,
    snapshot: ProjectSnapshot,
}
pub(crate) struct Preview {
    pub(crate) id: String,
    pub(crate) request_id: String,
    pub(crate) owner: Owner,
    pub(crate) state: AppState,
    pub(crate) media_id: String,
    pub(crate) source: Option<crate::commands::inspection::SourceSeed>,
    _lease: PreviewLease,
}
impl Preview {
    pub(crate) fn prepare(
        state: &AppState,
        root: std::path::PathBuf,
        document: ProjectDocument,
        owner: Owner,
        ticket: &OpenTicket,
        lease: PreviewLease,
        source: Option<crate::commands::inspection::SourceSeed>,
    ) -> Result<(Arc<Self>, ProjectSnapshot)> {
        let id = document.project_id.clone();
        let media_id = document.media.first().ok_or_else(stale)?.id.clone();
        let transient = LocalProject::transient(root, document)?;
        let snapshot = transient.snapshot()?;
        let preview = Arc::new(Self {
            id,
            request_id: ticket.request_id.clone(),
            owner,
            state: AppState(
                Arc::new(Mutex::new(Some(transient))),
                Default::default(),
                Default::default(),
                state.3.clone(),
                Default::default(),
                Default::default(),
                Default::default(),
            ),
            media_id,
            source,
            _lease: lease,
        });
        Ok((preview, snapshot))
    }
    pub(crate) fn shutdown(&self) {
        if let Ok(mut project) = self.state.0.lock() {
            *project = None;
            self.state.2.scheduler.reset();
            if let Ok(mut media) = self.state.1.lock() {
                media.reset();
            }
            self.state.3.reset_source(&self.id);
        }
    }
}
#[derive(Default)]
pub struct Manager {
    pub(crate) current: Mutex<Option<Arc<Preview>>>,
    opening: Mutex<Opening>,
    live: Arc<AtomicUsize>,
    #[cfg(test)]
    opening_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
#[derive(Default)]
struct Opening {
    epoch: u64,
    pending: Option<String>,
    cancelled_before_start: std::collections::HashSet<String>,
}
pub(crate) struct OpenTicket {
    epoch: u64,
    pub(crate) request_id: String,
    source_revision: u64,
}
fn cancelled_open() -> AppError {
    AppError::new(
        annotator_core::error::ErrorCode::Cancelled,
        "示例打开请求已取消或被较新请求替代",
    )
}
fn validate_request_id(id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id) {
        Ok(())
    } else {
        Err(AppError::invalid("Invalid preview opening request UUID"))
    }
}
pub(crate) struct PreviewLease(Arc<AtomicUsize>);
impl Drop for PreviewLease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
impl Manager {
    pub(crate) fn check_open(&self, ticket: &OpenTicket) -> Result<()> {
        let mut opening = self.opening.lock().map_err(|_| cancelled_open())?;
        if opening.epoch == ticket.epoch
            && opening.pending.as_deref() == Some(ticket.request_id.as_str())
        {
            Ok(())
        } else {
            opening.cancelled_before_start.remove(&ticket.request_id);
            Err(cancelled_open())
        }
    }
    pub(crate) fn begin_open(
        &self,
        request_id: String,
        source_revision: u64,
    ) -> Result<OpenTicket> {
        validate_request_id(&request_id)?;
        let mut opening = self.opening.lock().map_err(|_| cancelled_open())?;
        if opening.cancelled_before_start.remove(&request_id) {
            return Err(cancelled_open());
        }
        opening.epoch = opening.epoch.checked_add(1).ok_or_else(cancelled_open)?;
        opening.pending = Some(request_id.clone());
        Ok(OpenTicket {
            epoch: opening.epoch,
            request_id,
            source_revision,
        })
    }
    pub(crate) fn cancel_open(&self, request_id: &str) -> Result<()> {
        validate_request_id(request_id)?;
        let current = self.current.lock().map_err(|_| cancelled_open())?;
        if current.as_ref().is_some_and(|p| p.request_id == request_id) {
            return Ok(());
        }
        let mut opening = self.opening.lock().map_err(|_| cancelled_open())?;
        if opening.pending.as_deref() == Some(request_id) {
            opening.epoch = opening.epoch.saturating_add(1);
            opening.pending = None;
        } else if !opening.cancelled_before_start.contains(request_id) {
            if opening.cancelled_before_start.len() >= 256 {
                let mut error=AppError::new(annotator_core::error::ErrorCode::ResourceLimit,"Pending preview cancellation limit reached; retry after opening tasks complete");
                error.retryable = true;
                return Err(error);
            }
            opening.cancelled_before_start.insert(request_id.into());
        }
        Ok(())
    }
    pub(crate) fn admit(&self) -> Result<PreviewLease> {
        self.live
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 4).then_some(n + 1)
            })
            .map_err(|_| {
                AppError::new(
                    annotator_core::error::ErrorCode::ResourceLimit,
                    "请等待先前示例释放资源后重试",
                )
            })?;
        Ok(PreviewLease(self.live.clone()))
    }
    pub(crate) fn retire(old: Arc<Preview>) {
        old.shutdown();
        // Keep the last analysis-runtime owner off its own scheduler workers.
        // Four permits bound active, preparing and retiring preview resources.
        std::thread::spawn(move || {
            while old.state.2.scheduler.stats() != (0, 0) {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            drop(old);
        });
    }
    pub fn invalidate(&self) {
        if let Ok(mut current) = self.current.lock() {
            if let Ok(mut opening) = self.opening.lock() {
                opening.epoch = opening.epoch.saturating_add(1);
                opening.pending = None;
            }
            if let Some(old) = current.take() {
                Self::retire(old);
            }
        }
    }
    pub(crate) fn replace(&self, preview: Arc<Preview>, ticket: &OpenTicket) -> Result<()> {
        let mut current = self.current.lock().map_err(|_| stale())?;
        let mut opening = self.opening.lock().map_err(|_| cancelled_open())?;
        if opening.epoch != ticket.epoch || opening.pending.as_deref() != Some(&ticket.request_id) {
            return Err(cancelled_open());
        }
        preview
            .state
            .3
            .reset_if_source_revision(ticket.source_revision)?;
        opening.pending = None;
        if let Some(old) = current.take() {
            Self::retire(old);
        }
        *current = Some(preview);
        Ok(())
    }
    fn with<T>(
        &self,
        state: &AppState,
        nonce: &str,
        project: &str,
        id: &str,
        f: impl FnOnce(&Preview) -> Result<T>,
    ) -> Result<T> {
        let owner = capture_owner(state, nonce, project)?;
        owner.with_current(state, || {
            let current = self.current.lock().map_err(|_| stale())?;
            let preview = current.as_ref().ok_or_else(stale)?;
            if preview.id != id || preview.owner != owner || preview.source.is_some() {
                return Err(stale());
            }
            f(preview)
        })
    }
}
#[cfg(test)]
fn open_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    scope: Scope,
    creator: &str,
    sample: &str,
    settings: AnalysisSettings,
) -> Result<OpenPreview> {
    open_request_owned(
        state, nonce, project, scope, creator, sample, settings, None,
    )
}
#[cfg(test)]
fn open_request_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    scope: Scope,
    creator: &str,
    sample: &str,
    settings: AnalysisSettings,
    request_id: Option<String>,
) -> Result<OpenPreview> {
    annotator_core::model::validation::validate_analysis(&settings)?;
    let (owner, ticket) = start_open(state, nonce, project, request_id)?;
    finish_open(
        state, nonce, project, scope, creator, sample, settings, owner, ticket,
    )
}
fn start_open(
    state: &AppState,
    nonce: &str,
    project: &str,
    request_id: Option<String>,
) -> Result<(Owner, OpenTicket)> {
    let owner = capture_owner(state, nonce, project)?;
    let ticket = owner.with_current(state, || {
        state.6.examples.begin_open(
            request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            state.3.source_revision(),
        )
    })?;
    Ok((owner, ticket))
}
fn finish_open(
    state: &AppState,
    nonce: &str,
    project: &str,
    scope: Scope,
    creator: &str,
    sample: &str,
    settings: AnalysisSettings,
    owner: Owner,
    ticket: OpenTicket,
) -> Result<OpenPreview> {
    state.6.examples.check_open(&ticket)?;
    let (actual, repo) = capture(state, nonce, project)?;
    if actual != owner {
        return Err(cancelled_open());
    }
    let lease = state.6.examples.admit()?;
    #[cfg(test)]
    {
        let hook = state.6.examples.opening_hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
    }
    state.6.examples.check_open(&ticket)?;
    let entry = repo.get(scope, creator, sample)?;
    let path = repo.resolve(&entry)?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut document = ProjectDocument::create(entry.name.clone())?;
    document.project_id = id.clone();
    let mut descriptor = entry.media;
    descriptor.source_ref = path.to_string_lossy().into_owned();
    descriptor.display_name = entry.name;
    document.analysis.insert(descriptor.id.clone(), settings);
    document
        .playback_mix
        .insert(descriptor.id.clone(), Default::default());
    document.view_state.active_media_id = Some(descriptor.id.clone());
    document.media.push(descriptor);
    document.validate()?;
    let (preview, snapshot) = Preview::prepare(
        state,
        path.parent().ok_or_else(stale)?.to_path_buf(),
        document,
        owner.clone(),
        &ticket,
        lease,
        None,
    )?;
    owner.with_current(state, || state.6.examples.replace(preview.clone(), &ticket))?;
    Ok(OpenPreview {
        preview_id: id,
        snapshot,
    })
}
#[tauri::command]
pub async fn example_preview_open(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    scope: Scope,
    creator_id: String,
    sample_id: String,
    analysis_settings: AnalysisSettings,
    request_id: Option<String>,
) -> Result<OpenPreview> {
    annotator_core::model::validation::validate_analysis(&analysis_settings)?;
    let (owner, ticket) = start_open(&state, &runtime_nonce, &project_id, request_id)?;
    let state = state.inner().clone();
    blocking(move || {
        finish_open(
            &state,
            &runtime_nonce,
            &project_id,
            scope,
            &creator_id,
            &sample_id,
            analysis_settings,
            owner,
            ticket,
        )
    })
    .await
}
#[tauri::command]
pub async fn example_preview_cancel_open(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    request_id: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || cancel_open_owned(&state, &runtime_nonce, &project_id, &request_id)).await
}
fn cancel_open_owned(state: &AppState, nonce: &str, project: &str, request_id: &str) -> Result<()> {
    let owner = capture_owner(state, nonce, project)?;
    owner.with_current(state, || state.6.examples.cancel_open(request_id))
}
#[tauri::command]
pub async fn example_preview_register_view(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<String> {
    let state = state.inner().clone();
    blocking(move || {
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                p.state.2.scheduler.register_view()
            })
    })
    .await
}
#[tauri::command]
pub async fn example_preview_retire_view(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    view_id: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || {
        validate_view(&view_id)?;
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                p.state.2.scheduler.retire_view(&view_id)
            })
    })
    .await
}
#[tauri::command]
pub async fn example_preview_cancel_generation(
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
        if generation > 9_007_199_254_740_991 {
            return Err(AppError::invalid("Invalid analysis generation"));
        }
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                p.state.2.scheduler.cancel_generation(&view_id, generation)
            })
    })
    .await
}
fn validate_view(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 {
        return Err(AppError::invalid("无效分析视图"));
    }
    Ok(())
}
#[tauri::command]
pub async fn example_preview_request_tile(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    request: TileRequest,
    on_event: Channel<TileProgress>,
) -> Result<Response> {
    if request.analysis_source != AnalysisSource::Original {
        return Err(AppError::invalid("示例预览仅分析原始音频"));
    }
    let state = state.inner().clone();
    let bytes = blocking(move || {
        let receiver =
            state
                .6
                .examples
                .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                    super::super::analysis::enqueue_owned(
                        p.state.clone(),
                        None,
                        request,
                        move |event| on_event.send(event).is_ok(),
                    )
                })?;
        let bytes = receiver
            .recv()
            .map_err(|_| AppError::invalid("示例分析中断"))??;
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |_| Ok(()))?;
        Ok(bytes)
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
pub async fn example_preview_media_status(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<Vec<MediaStatus>> {
    let state = state.inner().clone();
    blocking(move || {
        let media =
            state
                .6
                .examples
                .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                    Ok(p.state
                        .0
                        .lock()
                        .map_err(|_| stale())?
                        .as_ref()
                        .ok_or_else(stale)?
                        .snapshot()?
                        .document
                        .media[0]
                        .clone())
                })?;
        let path = Path::new(&media.source_ref);
        let status = if annotator_core::collaboration::atomic::safe_existing(path).is_err() {
            "missing"
        } else {
            match annotator_core::media::identity::fingerprint(path, &Default::default(), |_| {}) {
                Ok(hash) if hash == media.sha256 => "ready",
                Ok(_) => "changed",
                Err(_) => "missing",
            }
        };
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |_| Ok(()))?;
        Ok(vec![MediaStatus {
            media_id: media.id,
            status,
        }])
    })
    .await
}
#[tauri::command]
pub async fn example_preview_playback_configure(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    request: PlaybackRequest,
) -> Result<PlaybackStatus> {
    if !matches!(request.mode, PlaybackMode::Original) || request.bypass {
        return Err(AppError::invalid("示例预览仅播放原始音频"));
    }
    let state = state.inner().clone();
    blocking(move || {
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                if request.project_id != p.id || request.media_id != p.media_id {
                    return Err(stale());
                }
                super::super::playback::configure_owned(p.state.clone(), None, app, request)
            })
    })
    .await
}
#[tauri::command]
pub async fn example_preview_playback_control(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
    action: String,
) -> Result<PlaybackStatus> {
    let state = state.inner().clone();
    blocking(move || {
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                p.state.3.control_source(&p.id, &action)
            })
    })
    .await
}
#[tauri::command]
pub async fn example_preview_playback_status(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<PlaybackStatus> {
    let state = state.inner().clone();
    blocking(move || {
        state
            .6
            .examples
            .with(&state, &runtime_nonce, &project_id, &preview_id, |p| {
                let status = p.state.3.status()?;
                Ok(if status.project_id.as_deref() == Some(&p.id) {
                    status
                } else {
                    PlaybackStatus::default()
                })
            })
    })
    .await
}
#[tauri::command]
pub async fn example_preview_close(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    preview_id: String,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || close_owned(&state, &runtime_nonce, &project_id, &preview_id)).await
}
fn close_owned(state: &AppState, nonce: &str, project: &str, id: &str) -> Result<()> {
    state.6.examples.with(state, nonce, project, id, |p| {
        p.shutdown();
        Ok(())
    })?;
    let mut current = state.6.examples.current.lock().map_err(|_| stale())?;
    if current.as_ref().is_some_and(|p| p.id == id) {
        if let Some(old) = current.take() {
            Manager::retire(old);
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolated_preview_supersedes_and_close_retires_views_without_document_edits() {
        let (state, root, project, nonce) = super::super::tests::setup();
        let (_, repo) = capture(&state, &nonce, &project).unwrap();
        let path = root.join("sample.wav");
        let mut b = Vec::new();
        b.extend(b"RIFF");
        b.extend(44u32.to_le_bytes());
        b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(8000u32.to_le_bytes());
        b.extend(16000u32.to_le_bytes());
        b.extend(2u16.to_le_bytes());
        b.extend(16u16.to_le_bytes());
        b.extend(b"data");
        b.extend(8u32.to_le_bytes());
        b.extend([0u8; 8]);
        std::fs::write(&path, b).unwrap();
        let e = repo.import(Scope::Private, &path, "OK1", 0).unwrap();
        let before = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap();
        let opened = open_owned(
            &state,
            &nonce,
            &project,
            e.scope,
            &e.creator_id,
            &e.sample_id,
            Default::default(),
        )
        .unwrap();
        assert_eq!(opened.snapshot.document.media.len(), 1);
        assert!(opened.snapshot.document.annotations.is_empty());
        assert_ne!(opened.snapshot.document.project_id, project);
        let first_id = opened.preview_id.clone();
        let first = state
            .6
            .examples
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let view = first.state.2.scheduler.register_view().unwrap();
        {
            let mut project = first.state.0.lock().unwrap();
            let project = project.as_mut().unwrap();
            assert!(project
                .apply_change(
                    &first_id,
                    0,
                    annotator_core::model::Change::RemoveMedia {
                        media_id: e.sample_id.clone()
                    }
                )
                .is_err());
            assert!(project.save(&first_id, 0).is_err());
            assert!(project
                .save_as(&root.join("unwanted"), &first_id, 0)
                .is_err());
            assert!(project.session_mut().is_err());
            assert!(!root.join("unwanted").exists());
        }
        let media = &opened.snapshot.document.media[0];
        let settings = opened.snapshot.document.analysis[&media.id].clone();
        let request = TileRequest {
            analysis_source: AnalysisSource::Original,
            processing_version: 2,
            edit_signature: String::new(),
            request_id: "example-tile".into(),
            view_id: view.clone(),
            project_id: opened.snapshot.document.project_id.clone(),
            media_id: media.id.clone(),
            generation: 1,
            config_hash: annotator_core::analysis::tiles::config_hash(&settings),
            settings,
            channel_index: 0,
            kind: annotator_core::model::SpectrumKind::Stft,
            start_frame: 0,
            frame_count: 1,
            time_lod: 0,
            frequency_start: 0,
            frequency_count: 16,
            frequency_lod: 0,
            visible: true,
        };
        let tile = super::super::super::analysis::enqueue_owned(
            first.state.clone(),
            None,
            request,
            |_| true,
        )
        .unwrap()
        .recv()
        .unwrap()
        .unwrap();
        assert!(!tile.is_empty());
        let second = open_owned(
            &state,
            &nonce,
            &project,
            e.scope,
            &e.creator_id,
            &e.sample_id,
            Default::default(),
        )
        .unwrap();
        assert!(close_owned(&state, &nonce, &project, &first_id).is_err());
        assert_eq!(first.state.2.scheduler.live_views(), 0);
        assert!(first.state.0.lock().unwrap().is_none());
        assert!(first
            .state
            .2
            .scheduler
            .submit(&view, 2, true, |_| Ok(vec![1]))
            .is_err());
        let current = state
            .6
            .examples
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let current_view = current.state.2.scheduler.register_view().unwrap();
        let (started, receive) = std::sync::mpsc::channel();
        let (release, continue_work) = std::sync::mpsc::channel();
        let work = current
            .state
            .2
            .scheduler
            .submit(&current_view, 1, true, move |_| {
                started.send(()).unwrap();
                continue_work.recv().unwrap();
                Ok(vec![1])
            })
            .unwrap();
        receive.recv().unwrap();
        close_owned(&state, &nonce, &project, &second.preview_id).unwrap();
        release.send(()).unwrap();
        assert!(work.recv().unwrap().is_err());
        assert_eq!(current.state.2.scheduler.live_views(), 0);
        assert!(current.state.0.lock().unwrap().is_none());
        assert!(state
            .6
            .examples
            .with(&state, &nonce, &project, &second.preview_id, |_| Ok(()))
            .is_err());
        let third = open_owned(
            &state,
            &nonce,
            &project,
            e.scope,
            &e.creator_id,
            &e.sample_id,
            Default::default(),
        )
        .unwrap();
        let third_state = state
            .6
            .examples
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        third_state.state.2.scheduler.register_view().unwrap();
        let owned_path = repo.resolve(&e).unwrap();
        std::fs::write(owned_path, b"changed original bytes").unwrap();
        assert!(open_owned(
            &state,
            &nonce,
            &project,
            e.scope,
            &e.creator_id,
            &e.sample_id,
            Default::default()
        )
        .is_err());
        state.6.retire();
        assert!(third_state.state.0.lock().unwrap().is_none());
        assert_eq!(third_state.state.2.scheduler.live_views(), 0);
        assert!(close_owned(&state, &nonce, &project, &third.preview_id).is_err());
        drop(third_state);
        assert_eq!(
            before,
            state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .snapshot()
                .unwrap()
        );
        drop(first);
        drop(current);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn preview_resource_admission_is_bounded_and_released() {
        let manager = Manager::default();
        let mut leases = (0..4).map(|_| manager.admit().unwrap()).collect::<Vec<_>>();
        assert!(manager.admit().is_err());
        leases.pop();
        assert!(manager.admit().is_ok());
    }
    #[test]
    fn delayed_open_cannot_replace_newer_preview_or_new_main_output() {
        for newer_preview in [true, false] {
            let (state, root, project, nonce) = super::super::tests::setup();
            let (_, repo) = capture(&state, &nonce, &project).unwrap();
            let sample = repo
                .import(
                    Scope::Private,
                    &Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../tests/fixtures/audio/mono16.wav"),
                    "OK",
                    0,
                )
                .unwrap();
            let (entered, started) = std::sync::mpsc::channel();
            let (release, waiting) = std::sync::mpsc::channel();
            *state.6.examples.opening_hook.lock().unwrap() = Some(Box::new(move || {
                entered.send(()).unwrap();
                waiting.recv().unwrap();
            }));
            let worker_state = state.clone();
            let worker_project = project.clone();
            let worker_nonce = nonce.clone();
            let worker_sample = sample.clone();
            let delayed = std::thread::spawn(move || {
                open_owned(
                    &worker_state,
                    &worker_nonce,
                    &worker_project,
                    worker_sample.scope,
                    &worker_sample.creator_id,
                    &worker_sample.sample_id,
                    Default::default(),
                )
            });
            started
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            let expected = if newer_preview {
                Some(
                    open_owned(
                        &state,
                        &nonce,
                        &project,
                        sample.scope,
                        &sample.creator_id,
                        &sample.sample_id,
                        Default::default(),
                    )
                    .unwrap()
                    .preview_id,
                )
            } else {
                None
            };
            state
                .3
                .test_playing_source(expected.as_deref().unwrap_or(&project));
            let output_before = state.3.status().unwrap();
            release.send(()).unwrap();
            let result = delayed.join().unwrap();
            let actual = state
                .6
                .examples
                .current
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.id.clone());
            let output_after = state.3.status().unwrap();
            state.6.examples.invalidate();
            drop(state);
            std::fs::remove_dir_all(root).unwrap();
            assert!(
                matches!(result,Err(ref error) if error.code==annotator_core::error::ErrorCode::Cancelled),
                "older open must be cancelled"
            );
            assert_eq!(actual, expected);
            assert_eq!(output_before.generation, output_after.generation);
            assert_eq!(output_before.project_id, output_after.project_id);
            assert_eq!(
                output_after.state,
                annotator_core::audio::engine::TransportState::Playing
            );
        }
    }
    #[test]
    fn pending_cancel_and_old_preview_close_preserve_newer_intents() {
        let (state, root, project, nonce) = super::super::tests::setup();
        let (_, repo) = capture(&state, &nonce, &project).unwrap();
        let sample = repo
            .import(
                Scope::Private,
                &Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio/mono16.wav"),
                "OK",
                0,
            )
            .unwrap();
        let finish = |owner, ticket| {
            finish_open(
                &state,
                &nonce,
                &project,
                sample.scope,
                &sample.creator_id,
                &sample.sample_id,
                Default::default(),
                owner,
                ticket,
            )
        };
        let cancelled_id = uuid::Uuid::new_v4().to_string();
        let (owner, ticket) =
            start_open(&state, &nonce, &project, Some(cancelled_id.clone())).unwrap();
        cancel_open_owned(&state, &nonce, &project, &cancelled_id).unwrap();
        let before = state.3.status().unwrap().generation;
        assert!(
            matches!(finish(owner,ticket),Err(ref error) if error.code==annotator_core::error::ErrorCode::Cancelled)
        );
        assert_eq!(state.3.status().unwrap().generation, before);
        assert!(state.6.examples.current.lock().unwrap().is_none());

        let old = open_owned(
            &state,
            &nonce,
            &project,
            sample.scope,
            &sample.creator_id,
            &sample.sample_id,
            Default::default(),
        )
        .unwrap();
        state.3.test_playing_source(&old.preview_id);
        let completed_request = state
            .6
            .examples
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .request_id
            .clone();
        cancel_open_owned(&state, &nonce, &project, &completed_request).unwrap();
        assert!(state
            .6
            .examples
            .opening
            .lock()
            .unwrap()
            .cancelled_before_start
            .is_empty());
        let stale_request = uuid::Uuid::new_v4().to_string();
        let (old_owner, old_ticket) =
            start_open(&state, &nonce, &project, Some(stale_request.clone())).unwrap();
        let (new_owner, new_ticket) = start_open(
            &state,
            &nonce,
            &project,
            Some(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        close_owned(&state, &nonce, &project, &old.preview_id).unwrap();
        cancel_open_owned(&state, &nonce, &project, &stale_request).unwrap();
        let newer = finish(new_owner, new_ticket).unwrap();
        assert!(
            matches!(finish(old_owner,old_ticket),Err(ref error) if error.code==annotator_core::error::ErrorCode::Cancelled)
        );
        assert_eq!(
            state
                .6
                .examples
                .current
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .id,
            newer.preview_id
        );
        let (owner, ticket) = start_open(&state, &nonce, &project, None).unwrap();
        state.6.retire();
        assert!(
            matches!(finish(owner,ticket),Err(ref error) if error.code==annotator_core::error::ErrorCode::Cancelled)
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_arriving_before_the_open_handler_starts_is_not_lost() {
        let manager = Manager::default();
        let request_id = uuid::Uuid::new_v4().to_string();
        manager.cancel_open(&request_id).unwrap();
        assert!(
            matches!(manager.begin_open(request_id,0),Err(ref error) if error.code==annotator_core::error::ErrorCode::Cancelled)
        );
    }
    #[test]
    fn early_cancel_registry_is_bounded_without_forgetting_accepted_cancellations() {
        let manager = Manager::default();
        let ids = (0..256)
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect::<Vec<_>>();
        for id in &ids {
            manager.cancel_open(id).unwrap();
        }
        let extra = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            manager.cancel_open(&extra).unwrap_err().code,
            annotator_core::error::ErrorCode::ResourceLimit
        );
        assert!(manager.begin_open(ids[0].clone(), 0).is_err());
        manager.cancel_open(&extra).unwrap();
        assert!(manager.begin_open(extra, 0).is_err());
        for id in ids.into_iter().skip(1) {
            assert!(manager.begin_open(id, 0).is_err());
        }
    }
}
