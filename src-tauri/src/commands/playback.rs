use crate::state::AppState;
use annotator_core::{
    audio::{
        device::{device_error, list_devices, Device, OutputDevice},
        engine::{OutputBuffer, PlaybackState, PresentationStatus, TransportState},
        renderer::{RenderOptions, Renderer},
        PlaybackMode, SelectionSource, SourceInfo,
    },
    error::{AppError, ErrorCode, Result},
    media::{decode::rehydrate, pcm_cache::PcmCache},
    model::{MediaDescriptor, PlaybackMix, ProjectDocument, SpectralEdit},
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, State};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackRequest {
    pub project_id: String,
    pub media_id: String,
    pub mode: PlaybackMode,
    pub bypass: bool,
    pub looping: bool,
    pub volume: f32,
    pub device_id: Option<String>,
    pub seek_seconds: Option<f64>,
    pub play: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub generation: u64,
    pub project_id: Option<String>,
    pub media_id: Option<String>,
    pub state: TransportState,
    pub position_seconds: f64,
    pub start_seconds: f64,
    pub first_seconds: f64,
    pub end_seconds: f64,
    /// Frames submitted by the callback, not an audible-presentation counter.
    pub consumed_frames: u64,
    pub presentation: PresentationStatus,
    pub underrun_frames: u64,
    pub device_name: Option<String>,
    pub device_rate: u32,
    pub device_channels: u16,
    pub error: Option<AppError>,
}
impl Default for PlaybackStatus {
    fn default() -> Self {
        Self {
            generation: 0,
            project_id: None,
            media_id: None,
            state: TransportState::Stopped,
            position_seconds: 0.0,
            start_seconds: 0.0,
            first_seconds: 0.0,
            end_seconds: 0.0,
            consumed_frames: 0,
            presentation: PresentationStatus::default(),
            underrun_frames: 0,
            device_name: None,
            device_rate: 0,
            device_channels: 0,
            error: None,
        }
    }
}
struct Control {
    transport: Option<PlaybackState>,
    status: PlaybackStatus,
    buffer: Option<Arc<OutputBuffer>>,
    cancel: Arc<AtomicBool>,
    source_rate: u32,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            transport: None,
            status: PlaybackStatus::default(),
            buffer: None,
            cancel: Arc::new(AtomicBool::new(false)),
            source_rate: 1,
        }
    }
}
impl Control {
    fn ready(&mut self) {
        if self.status.state == TransportState::Buffering {
            self.status.state = self
                .transport
                .as_ref()
                .map_or(TransportState::Stopped, |t| t.state);
        }
        if let Some(buffer) = &self.buffer {
            buffer.set_playing(self.status.state == TransportState::Playing);
        }
    }
}
struct Work {
    state: AppState,
    request: PlaybackRequest,
    descriptor: MediaDescriptor,
    edits: Vec<SpectralEdit>,
    mix: PlaybackMix,
    root: PathBuf,
    media_generation: u64,
    generation: u64,
    position: u64,
    cancel: Arc<AtomicBool>,
    app: tauri::AppHandle,
}
pub struct PlaybackRuntime {
    control: Arc<Mutex<Control>>,
    epoch: Arc<AtomicU64>,
    send: mpsc::SyncSender<()>,
    pending: Arc<Mutex<Option<Work>>>,
}
impl Default for PlaybackRuntime {
    fn default() -> Self {
        let (send, receive) = mpsc::sync_channel::<()>(1);
        let pending = Arc::new(Mutex::new(None::<Work>));
        let worker_pending = pending.clone();
        let control = Arc::new(Mutex::new(Control::default()));
        let epoch = Arc::new(AtomicU64::new(0));
        let worker_control = control.clone();
        let worker_epoch = epoch.clone();
        std::thread::Builder::new()
            .name("audio-output-worker".into())
            .spawn(move || {
                while receive.recv().is_ok() {
                    let Some(work) = worker_pending.lock().ok().and_then(|mut slot| slot.take())
                    else {
                        continue;
                    };
                    if work.cancel.load(Ordering::Acquire) {
                        continue;
                    }
                    if let Err(error) = run(&work, &worker_control, &worker_epoch) {
                        if !work.cancel.load(Ordering::Acquire) {
                            if let Ok(mut c) = worker_control.lock() {
                                if c.status.generation == work.generation {
                                    if let Some(b) = &c.buffer {
                                        b.set_playing(false);
                                    }
                                    if let Some(t) = &mut c.transport {
                                        t.state = TransportState::Error;
                                    }
                                    c.status.state = TransportState::Error;
                                    c.status.error = Some(error);
                                    let _ = work.app.emit("playback-progress", c.status.clone());
                                }
                            }
                        }
                    }
                }
            })
            .expect("audio worker");
        Self {
            control,
            epoch,
            send,
            pending,
        }
    }
}
impl PlaybackRuntime {
    pub fn status(&self) -> Result<PlaybackStatus> {
        let mut c = self
            .control
            .lock()
            .map_err(|_| device_error("播放服务不可用"))?;
        sample_clock(&mut c);
        Ok(c.status.clone())
    }
    pub fn reset(&self) {
        if let Ok(mut c) = self.control.lock() {
            c.cancel.store(true, Ordering::Release);
            if let Some(b) = c.buffer.take() {
                b.set_playing(false);
            }
            let generation = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
            c.transport = None;
            c.status = PlaybackStatus {
                generation,
                ..Default::default()
            };
        }
    }
    pub fn stop(&self) -> Result<PlaybackStatus> {
        let mut c = self
            .control
            .lock()
            .map_err(|_| device_error("播放服务不可用"))?;
        c.cancel.store(true, Ordering::Release);
        if let Some(b) = c.buffer.take() {
            b.set_playing(false);
        }
        c.status.generation = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(t) = &mut c.transport {
            t.stop();
        }
        c.status.position_seconds = c.status.start_seconds;
        c.status.state = TransportState::Stopped;
        Ok(c.status.clone())
    }
    pub fn pause(&self) -> Result<PlaybackStatus> {
        let mut c = self
            .control
            .lock()
            .map_err(|_| device_error("播放服务不可用"))?;
        if let Some(b) = &c.buffer {
            b.set_playing(false);
        }
        sample_clock(&mut c);
        if let Some(t) = &mut c.transport {
            t.pause();
        }
        c.status.state = TransportState::Paused;
        Ok(c.status.clone())
    }
    /// Called only for changes to the active source's actual audio inputs.
    pub fn changed(&self, before: &ProjectDocument, after: &ProjectDocument) {
        let Ok(mut c) = self.control.lock() else {
            return;
        };
        let Some(id) = c.status.media_id.clone() else {
            return;
        };
        let source = |doc: &ProjectDocument| {
            doc.media.iter().find(|m| m.id == id).map(|m| {
                (
                    m.sha256.clone(),
                    m.source_ref.clone(),
                    m.sample_rate,
                    m.frame_count,
                    m.channel_count,
                )
            })
        };
        if source(before) != source(after)
            || before.playback_mix.get(&id) != after.playback_mix.get(&id)
            || before
                .edits
                .iter()
                .filter(|e| e.region.media_id == id)
                .collect::<Vec<_>>()
                != after
                    .edits
                    .iter()
                    .filter(|e| e.region.media_id == id)
                    .collect::<Vec<_>>()
        {
            if let Some(b) = &c.buffer {
                b.set_playing(false);
            }
            sample_clock(&mut c);
            c.cancel.store(true, Ordering::Release);
            c.status.generation = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
            c.buffer = None;
            if source(after).is_none() {
                c.status.state = TransportState::Stopped;
                c.status.media_id = None;
            }
        }
    }
}
fn sample_clock(c: &mut Control) {
    if let Some(b) = &c.buffer {
        if let Some(t) = &mut c.transport {
            t.consumed(b.position());
        }
        c.status.position_seconds = b.position() as f64 / c.source_rate as f64;
        c.status.consumed_frames = b.consumed();
        c.status.underrun_frames = b.underruns();
        c.status.presentation = b.presentation();
        if c.status.presentation.drained && c.status.state == TransportState::Playing {
            if let Some(t) = &mut c.transport {
                t.end();
            }
            c.status.state = TransportState::Ended;
            c.status.position_seconds = c.status.end_seconds;
        }
    }
}
fn publish(work: &Work, control: &Mutex<Control>) {
    if let Ok(mut c) = control.lock() {
        if c.status.generation == work.generation {
            sample_clock(&mut c);
            let _ = work.app.emit("playback-progress", c.status.clone());
        }
    }
}
fn run(work: &Work, control: &Mutex<Control>, epoch: &Arc<AtomicU64>) -> Result<()> {
    // No project lock during source verification, hydration, PCM reads, FFT or device setup.
    let media = {
        let _hydration = work
            .state
            .2
            .hydration
            .lock()
            .map_err(|_| device_error("媒体服务不可用"))?;
        if work.cancel.load(Ordering::Acquire) {
            return Ok(());
        }
        let cached = work
            .state
            .1
            .lock()
            .map_err(|_| device_error("媒体服务不可用"))?
            .registry
            .get_unverified(&work.descriptor);
        match cached {
            Ok(media) => {
                media.verify_source()?;
                media
            }
            Err(_) => {
                let media = rehydrate(
                    &work.descriptor,
                    &work.root,
                    &std::env::temp_dir().join("audio-annotator-pcm"),
                    &work.cancel,
                    |_, _| {},
                )?;
                if work.cancel.load(Ordering::Acquire) {
                    return Ok(());
                }
                work.state
                    .1
                    .lock()
                    .map_err(|_| device_error("媒体服务不可用"))?
                    .publish_rehydrated(work.media_generation, media)?
            }
        }
    };
    if work.cancel.load(Ordering::Acquire) {
        return Ok(());
    }
    let device = Device::select(work.request.device_id.as_deref())?;
    let mode = effective_mode(&work.request);
    let mut renderer = Renderer::new(
        SourceInfo {
            media_id: work.descriptor.id.clone(),
            sample_rate: work.descriptor.sample_rate,
            frame_count: work.descriptor.frame_count,
            channel_count: work.descriptor.channel_count as usize,
        },
        mode,
        &work.edits,
        RenderOptions {
            mix: work.mix.clone(),
            volume: work.request.volume,
            device_rate: device.sample_rate(),
            start: work.position,
            looping: work.request.looping,
        },
    )?;
    let buffer = Arc::new(OutputBuffer::new(
        131072,
        epoch.clone(),
        work.generation,
        work.position,
    ));
    let mut cache = PcmCache::for_playback();
    let mut pending = None;
    let mut offset = 0;
    let mut eof = false;
    // At most ~2.7 seconds stereo at 48 kHz; never render a full long source.
    let mut fill = |buffer: &OutputBuffer| -> Result<()> {
        while buffer.free() > 65536 && !eof && !work.cancel.load(Ordering::Acquire) {
            if pending.is_none() {
                media.verify_source()?;
                pending =
                    renderer.next(|start, count| cache.read_frames(&media.pcm, start, count))?;
                offset = 0;
                if pending.is_none() {
                    eof = true;
                    buffer.finish();
                    break;
                }
            }
            let chunk = pending.as_ref().unwrap();
            while offset < chunk.positions.len()
                && buffer.push(
                    [chunk.samples[offset * 2], chunk.samples[offset * 2 + 1]],
                    chunk.positions[offset],
                )
            {
                offset += 1;
            }
            if offset == chunk.positions.len() {
                pending = None;
            }
        }
        Ok(())
    };
    fill(&buffer)?;
    if work.cancel.load(Ordering::Acquire) {
        return Ok(());
    }
    {
        let mut c = control.lock().map_err(|_| device_error("播放服务不可用"))?;
        if c.status.generation != work.generation {
            return Ok(());
        }
        c.buffer = Some(buffer.clone());
        c.status.device_name = Some(device.name.clone());
        c.status.device_rate = device.sample_rate();
        c.status.device_channels = device.channels();
        c.ready();
    }
    let _stream = device.start(buffer.clone())?;
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut verified = Instant::now();
    while !work.cancel.load(Ordering::Acquire) {
        if buffer.device_failed.load(Ordering::Acquire) {
            return Err(device_error("设备已断开或输出流失效"));
        }
        if verified.elapsed() >= Duration::from_millis(250) {
            media.verify_source()?;
            verified = Instant::now();
        }
        fill(&buffer)?;
        if last.elapsed() >= Duration::from_millis(33) {
            publish(work, control);
            last = Instant::now();
        }
        if buffer.ended() {
            publish(work, control);
            break;
        }
        std::thread::sleep(Duration::from_millis(3));
    }
    buffer.set_playing(false);
    Ok(())
}
fn effective_mode(request: &PlaybackRequest) -> PlaybackMode {
    if !request.bypass {
        return request.mode.clone();
    }
    match &request.mode {
        PlaybackMode::Selection { region, .. } => PlaybackMode::Selection {
            region: region.clone(),
            source: SelectionSource::Original,
        },
        _ => PlaybackMode::Original,
    }
}
#[tauri::command]
pub async fn playback_devices() -> Result<Vec<OutputDevice>> {
    tauri::async_runtime::spawn_blocking(list_devices)
        .await
        .map_err(|_| device_error("设备枚举中断"))?
}
#[tauri::command]
pub fn playback_status(state: State<'_, AppState>) -> Result<PlaybackStatus> {
    state.3.status()
}
#[tauri::command]
pub fn playback_control(state: State<'_, AppState>, action: String) -> Result<PlaybackStatus> {
    match action.as_str() {
        "pause" => state.3.pause(),
        "stop" => state.3.stop(),
        "reset" => {
            state.3.reset();
            state.3.status()
        }
        _ => Err(AppError::invalid("未知播放操作")),
    }
}
#[tauri::command]
pub async fn playback_configure(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: PlaybackRequest,
) -> Result<PlaybackStatus> {
    if !request.volume.is_finite()
        || !(0.0..=1.0).contains(&request.volume)
        || request
            .seek_seconds
            .is_some_and(|s| !s.is_finite() || s < 0.0)
    {
        return Err(AppError::invalid("无效播放参数"));
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (doc, root, media_generation) = {
            let lock = state.0.lock().map_err(|_| device_error("项目服务不可用"))?;
            let project = lock
                .as_ref()
                .ok_or_else(|| AppError::invalid("尚未打开项目"))?;
            (
                project.snapshot()?.document,
                project.root().to_path_buf(),
                state
                    .1
                    .lock()
                    .map_err(|_| device_error("媒体服务不可用"))?
                    .generation(),
            )
        };
        if doc.project_id != request.project_id {
            return Err(AppError::new(ErrorCode::Cancelled, "项目已切换"));
        }
        let descriptor = doc
            .media
            .iter()
            .find(|m| m.id == request.media_id)
            .cloned()
            .ok_or_else(|| AppError::invalid("未知播放源"))?;
        let mode = effective_mode(&request);
        let bounds = annotator_core::audio::DspProcessor::new(
            SourceInfo {
                media_id: descriptor.id.clone(),
                sample_rate: descriptor.sample_rate,
                frame_count: descriptor.frame_count,
                channel_count: descriptor.channel_count as usize,
            },
            1,
            mode,
            &doc.edits,
        )?;
        let first = bounds.source_start_frame();
        let end = first + bounds.frame_count();
        let rate = descriptor.sample_rate as f64;
        // Revalidate runtime identity after the lock-free DSP setup; serialize publication with project transitions.
        let project_guard = state.0.lock().map_err(|_| device_error("项目服务不可用"))?;
        let current = project_guard
            .as_ref()
            .ok_or_else(|| AppError::new(ErrorCode::Cancelled, "项目已切换"))?
            .snapshot()?
            .document;
        if current.project_id != doc.project_id
            || state
                .1
                .lock()
                .map_err(|_| device_error("媒体服务不可用"))?
                .generation()
                != media_generation
            || current
                .media
                .iter()
                .find(|m| m.id == descriptor.id)
                .is_none_or(|m| {
                    !annotator_core::media::registry::same_identity(m, &descriptor)
                        || m.source_ref != descriptor.source_ref
                })
            || current.edits != doc.edits
            || current.playback_mix != doc.playback_mix
        {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "播放来源已更新，请重试",
            ));
        }
        let mut c = state
            .3
            .control
            .lock()
            .map_err(|_| device_error("播放服务不可用"))?;
        if let Some(b) = &c.buffer {
            b.set_playing(false);
        }
        sample_clock(&mut c);
        c.cancel.store(true, Ordering::Release);
        let same = c.status.project_id.as_deref() == Some(&request.project_id)
            && c.status.media_id.as_deref() == Some(&request.media_id);
        let position = (request.seek_seconds.unwrap_or(if same {
            if c.status.state == TransportState::Ended && request.play {
                first as f64 / rate
            } else {
                c.status.position_seconds
            }
        } else {
            first as f64 / rate
        }) * rate)
            .round() as u64;
        let position = position.clamp(first, end);
        let mut transport = PlaybackState::new(first, end, position);
        if same {
            if let Some(previous) = &c.transport {
                transport.state = previous.state;
                transport.start = previous.start.clamp(first, end);
            }
        }
        if request.seek_seconds.is_some() {
            transport.seek(position);
        }
        if request.play {
            transport.play();
        } else if !matches!(
            transport.state,
            TransportState::Stopped | TransportState::Ended
        ) {
            transport.pause();
        }
        // Prebuffering a stopped seek remains stopped in the state machine until Play.
        let position = transport.position;
        let start = transport.start;
        c.transport = Some(transport);
        let generation = state.3.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let cancel = Arc::new(AtomicBool::new(false));
        c.buffer = None;
        c.cancel = cancel.clone();
        c.source_rate = descriptor.sample_rate;
        c.status = PlaybackStatus {
            generation,
            project_id: Some(request.project_id.clone()),
            media_id: Some(request.media_id.clone()),
            state: TransportState::Buffering,
            position_seconds: position as f64 / rate,
            start_seconds: start.clamp(first, end) as f64 / rate,
            first_seconds: first as f64 / rate,
            end_seconds: end as f64 / rate,
            ..Default::default()
        };
        let status = c.status.clone();
        let work = Work {
            state: state.clone(),
            request: request.clone(),
            descriptor,
            edits: doc.edits,
            mix: doc
                .playback_mix
                .get(&request.media_id)
                .cloned()
                .unwrap_or_default(),
            root,
            media_generation,
            generation,
            position,
            cancel,
            app,
        };
        *state
            .3
            .pending
            .lock()
            .map_err(|_| device_error("播放队列不可用"))? = Some(work);
        match state.3.send.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => (),
            Err(_) => return Err(device_error("播放工作线程已结束")),
        }
        Ok(status)
    })
    .await
    .map_err(|_| device_error("播放请求中断"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document() -> ProjectDocument {
        ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v2.json"))
            .unwrap()
    }
    #[test]
    fn native_ended_status_waits_for_presentation_but_stop_cancels_immediately() {
        use annotator_core::audio::engine::{OutputTiming, PresentationTracker, SubmittedTail};
        for stop in [false, true] {
            let runtime = PlaybackRuntime::default();
            let buffer = Arc::new(OutputBuffer::new(8, runtime.epoch.clone(), 0, 0));
            {
                let mut c = runtime.control.lock().unwrap();
                c.source_rate = 1000;
                c.transport = Some(PlaybackState::new(0, 1, 0));
                c.transport.as_mut().unwrap().play();
                c.status.state = TransportState::Playing;
                c.status.end_seconds = 0.001;
                c.buffer = Some(buffer.clone());
            }
            buffer.push([0.75; 2], 1);
            buffer.finish();
            buffer.set_playing(true);
            buffer.consume();
            assert_eq!(runtime.status().unwrap().state, TransportState::Playing);
            let mut timing = PresentationTracker::default();
            timing.record(
                &buffer,
                OutputTiming {
                    callback_nanos: 0,
                    playback_nanos: 8_000_000,
                },
                8,
                1000,
                Some(SubmittedTail {
                    frame_end: 1,
                    non_silent: true,
                }),
            );
            assert_eq!(runtime.status().unwrap().state, TransportState::Playing);
            if stop {
                assert_eq!(runtime.stop().unwrap().state, TransportState::Stopped);
                assert!(runtime
                    .control
                    .lock()
                    .unwrap()
                    .cancel
                    .load(Ordering::Acquire));
                assert!(!buffer.ended());
            } else {
                timing.record(
                    &buffer,
                    OutputTiming {
                        callback_nanos: 9_000_000,
                        playback_nanos: 17_000_000,
                    },
                    8,
                    1000,
                    None,
                );
                let status = runtime.status().unwrap();
                assert_eq!(status.state, TransportState::Ended);
                assert!(status.presentation.drained);
                assert_eq!(status.position_seconds, 0.001);
            }
        }
    }
    #[test]
    fn prebuffer_completion_preserves_stopped_and_paused_transport_intent() {
        for expected in [
            TransportState::Stopped,
            TransportState::Paused,
            TransportState::Playing,
        ] {
            let mut c = Control::default();
            let mut transport = PlaybackState::new(0, 100, 20);
            transport.state = expected;
            c.transport = Some(transport);
            c.status.state = TransportState::Buffering;
            c.ready();
            assert_eq!(c.status.state, expected);
        }
    }
    #[test]
    fn native_pause_stop_and_reset_use_counted_output_and_invalidate_old_callbacks() {
        let runtime = PlaybackRuntime::default();
        let buffer = Arc::new(OutputBuffer::new(8, runtime.epoch.clone(), 0, 20));
        {
            let mut c = runtime.control.lock().unwrap();
            c.source_rate = 10;
            c.transport = Some(PlaybackState::new(0, 100, 20));
            c.transport.as_mut().unwrap().play();
            c.status.start_seconds = 2.0;
            c.status.end_seconds = 10.0;
            c.status.state = TransportState::Playing;
            c.buffer = Some(buffer.clone());
        }
        buffer.push([0.2; 2], 30);
        buffer.set_playing(true);
        buffer.consume();
        assert_eq!(runtime.pause().unwrap().position_seconds, 3.0);
        buffer.push([0.3; 2], 40);
        assert_eq!(buffer.consume(), [0.0; 2]);
        assert_eq!(runtime.stop().unwrap().position_seconds, 2.0);
        buffer.set_playing(true);
        assert_eq!(buffer.consume(), [0.0; 2]);
        runtime.reset();
        assert!(runtime.status().unwrap().media_id.is_none());
    }
    #[test]
    fn native_document_changes_only_cancel_audio_inputs_for_active_media() {
        let runtime = PlaybackRuntime::default();
        let before = document();
        let id = before.media[0].id.clone();
        runtime.control.lock().unwrap().status.media_id = Some(id.clone());
        let mut after = before.clone();
        after.revision += 1;
        after.media[0].note = "note".into();
        after.categories[0].name = "category".into();
        after.analysis.get_mut(&id).unwrap().fft_size = 4096;
        runtime.changed(&before, &after);
        assert_eq!(runtime.epoch.load(Ordering::Acquire), 0);
        after.playback_mix.get_mut(&id).unwrap().solo_channels = vec![0];
        runtime.changed(&before, &after);
        assert_eq!(runtime.epoch.load(Ordering::Acquire), 1);
        after.media.clear();
        runtime.changed(&before, &after);
        assert!(runtime.status().unwrap().media_id.is_none());
    }
}
