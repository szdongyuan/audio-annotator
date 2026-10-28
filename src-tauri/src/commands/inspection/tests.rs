use super::*;
use annotator_core::{media::decode::decode, model::Change, project::LocalProject};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

fn setup() -> (AppState, PathBuf, String, String, String) {
    let root = std::env::temp_dir().join(format!("native-inspection-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let state = AppState::default();
    state.6.set_local(root.join("local")).unwrap();
    std::fs::create_dir(root.join("project")).unwrap();
    let mut p = LocalProject::create(&root.join("project"), "Main".into()).unwrap();
    let path = root.join("project/audio.wav");
    std::fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio/stereo24.wav"),
        &path,
    )
    .unwrap();
    let decoded = decode(&path, &root.join("pcm"), &AtomicBool::new(false), |_, _| {}).unwrap();
    let mut media = decoded.descriptor.clone();
    media.source_ref = "audio.wav".into();
    let project = p.snapshot().unwrap().document.project_id;
    p.apply_change(
        &project,
        0,
        Change::ImportMedia {
            media: media.clone(),
        },
    )
    .unwrap();
    *state.0.lock().unwrap() = Some(p);
    let nonce = state.6.current.lock().unwrap().nonce.clone();
    (state, root, project, nonce, media.id)
}

fn snapshot(state: &AppState) -> ProjectSnapshot {
    state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
}

#[test]
fn open_is_native_bound_readonly_and_does_not_create_a_legacy_profile() {
    let (state, root, project, nonce, media) = setup();
    let before = snapshot(&state);
    let settings = AnalysisSettings {
        fft_size: 4096,
        ..Default::default()
    };
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        settings.clone(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    assert_ne!(opened.document.project_id, project);
    assert_eq!(opened.document.media[0], before.document.media[0]);
    assert_eq!(opened.document.analysis[&media], settings);
    assert!(!opened.can_undo && !opened.can_redo);
    assert_eq!(before, snapshot(&state));
    assert!(state.6.selected.lock().unwrap().is_none());
    assert_eq!(std::fs::read_dir(root.join("local")).unwrap().count(), 0);
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn independent_analysis_configuration_cancels_old_tiles_without_touching_main() {
    let (state, root, project, nonce, media) = setup();
    let before = snapshot(&state);
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let preview = state
        .6
        .inspection
        .current
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    let view = preview.state.2.scheduler.register_view().unwrap();
    let media_generation = preview.state.1.lock().unwrap().generation();
    let settings = AnalysisSettings {
        fft_size: 4096,
        ..Default::default()
    };
    let configured = configure_analysis_owned(
        &state,
        &nonce,
        &project,
        &opened.document.project_id,
        settings.clone(),
    )
    .unwrap();
    assert_eq!(configured.document.analysis[&media], settings);
    assert_eq!(configured.document.project_id, opened.document.project_id);
    assert!(!configured.can_undo && !configured.can_redo);
    assert!(preview
        .state
        .2
        .scheduler
        .submit(&view, 1, true, |_| Ok(vec![]))
        .is_err());
    assert_eq!(before, snapshot(&state));
    assert_eq!(
        preview.state.1.lock().unwrap().generation(),
        media_generation,
        "analysis configuration must retain PCM/playback hydration authority"
    );
    drop(preview);
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

fn tile_request(
    p: &Preview,
    source: annotator_core::analysis::source::AnalysisSource,
    channel: u8,
) -> annotator_core::analysis::tiles::TileRequest {
    let document = snapshot(&p.state).document;
    let settings = document.analysis[&p.media_id].clone();
    annotator_core::analysis::tiles::TileRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        view_id: p.state.2.scheduler.register_view().unwrap(),
        project_id: p.id.clone(),
        media_id: p.media_id.clone(),
        generation: 1,
        config_hash: annotator_core::analysis::tiles::config_hash(&settings),
        settings,
        analysis_source: source,
        processing_version: 2,
        edit_signature: source.signature(&p.media_id, &document.edits),
        channel_index: channel,
        kind: annotator_core::model::SpectrumKind::Stft,
        start_frame: 0,
        frame_count: 4,
        time_lod: 0,
        frequency_start: 0,
        frequency_count: 128,
        frequency_lod: 0,
        visible: true,
    }
}
fn values(bytes: &[u8]) -> Vec<f32> {
    let header = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let start = (8 + header).div_ceil(4) * 4;
    bytes[start..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

#[test]
fn processed_tiles_use_captured_edits_independent_fft_cache_and_channel_authority() {
    use annotator_core::{
        analysis::source::AnalysisSource,
        model::{EditOperation, Region, SpectralEdit},
    };
    for operation in [EditOperation::Mask, EditOperation::Gain { gain_db: -12.0 }] {
        let (state, root, project, nonce, media) = setup();
        let before_edit = snapshot(&state);
        let m = &before_edit.document.media[0];
        let edit = SpectralEdit {
            id: uuid::Uuid::new_v4().to_string(),
            region: Region {
                media_id: media.clone(),
                channel_index: 0,
                start_seconds: 0.,
                end_seconds: m.frame_count as f64 / m.sample_rate as f64,
                low_hz: 0.,
                high_hz: m.sample_rate as f64 / 2.,
            },
            enabled: true,
            processing_version: 2,
            operation,
        };
        state
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .apply_change(
                &project,
                before_edit.document.revision,
                Change::AddEdit { edit },
            )
            .unwrap();
        let before = snapshot(&state);
        let settings = AnalysisSettings {
            fft_size: 4096,
            ..Default::default()
        };
        let opened = open_owned(
            &state,
            &nonce,
            &project,
            &media,
            settings,
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let p = state
            .6
            .inspection
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let read = |r| values(&tile_owned(&state, &nonce, &project, &p.id, r, |_| true).unwrap());
        let original = read(tile_request(&p, AnalysisSource::Original, 0));
        let processed_request = tile_request(&p, AnalysisSource::Processed, 0);
        let processed = read(processed_request.clone());
        assert!(original
            .iter()
            .zip(&processed)
            .any(|(a, b)| (a - b).abs() > 5.0));
        assert_eq!(processed, read(processed_request.clone())); // warm cache
        let other = read(tile_request(&p, AnalysisSource::Original, 1));
        assert_eq!(other, read(tile_request(&p, AnalysisSource::Processed, 1)));
        // Playback and analysis consume the same captured edits, including stable
        // source channel indices for original/processed region audition.
        let d = snapshot(&p.state).document;
        let m = &d.media[0];
        let decoded = annotator_core::media::decode::rehydrate(
            m,
            &root.join("project"),
            &std::env::temp_dir().join("inspection-test-pcm"),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        let mut cache = annotator_core::media::pcm_cache::PcmCache::for_playback();
        let mut render = |mode| {
            let mut dsp = annotator_core::audio::DspProcessor::new(
                annotator_core::audio::SourceInfo {
                    media_id: media.clone(),
                    sample_rate: m.sample_rate,
                    frame_count: m.frame_count,
                    channel_count: 2,
                },
                2,
                mode,
                &d.edits,
            )
            .unwrap();
            dsp.read_frames(1536, 1024, |start, count| {
                cache.read_frames(&decoded.pcm, start, count)
            })
            .unwrap()
        };
        let original_pcm = render(annotator_core::audio::PlaybackMode::Original);
        let processed_pcm = render(annotator_core::audio::PlaybackMode::Processed);
        let left_energy = |pcm: &[f32]| {
            pcm.chunks_exact(2)
                .map(|f| f[0] as f64 * f[0] as f64)
                .sum::<f64>()
        };
        assert!(left_energy(&processed_pcm) < left_energy(&original_pcm) * 0.2);
        assert!(original_pcm
            .chunks_exact(2)
            .zip(processed_pcm.chunks_exact(2))
            .all(|(a, b)| (a[1] - b[1]).abs() < 1e-6));
        let mut selections = Vec::new();
        for source in [
            annotator_core::audio::SelectionSource::Original,
            annotator_core::audio::SelectionSource::Processed,
        ] {
            let region = Region {
                media_id: media.clone(),
                channel_index: 1,
                start_seconds: 0.,
                end_seconds: 0.1,
                low_hz: 0.,
                high_hz: m.sample_rate as f64 / 2.,
            };
            selections.push(render(annotator_core::audio::PlaybackMode::Selection {
                region,
                source,
            }));
        }
        assert!(selections[0]
            .iter()
            .zip(&selections[1])
            .all(|(a, b)| (a - b).abs() < 1e-6));
        let mut forged = processed_request.clone();
        forged.edit_signature = "0".repeat(64);
        assert!(tile_owned(&state, &nonce, &project, &p.id, forged, |_| true).is_err());
        let mut main_request = processed_request;
        main_request.project_id = project.clone();
        main_request.view_id = state.2.scheduler.register_view().unwrap();
        assert!(
            super::super::analysis::enqueue_owned(state.clone(), None, main_request, |_| true)
                .is_err()
        );
        assert_eq!(before, snapshot(&state));
        assert_eq!(opened.document.edits, before.document.edits);
        drop(p);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn close_stops_owned_preview_and_cannot_stop_a_new_main_transport() {
    use annotator_core::audio::engine::TransportState;
    let (state, root, project, nonce, media) = setup();
    state.3.test_playing_source(&project);
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    assert_eq!(state.3.status().unwrap().state, TransportState::Stopped);
    let id = opened.document.project_id;
    state.3.test_playing_source(&id);
    close_owned(&state, &nonce, &project, &id).unwrap();
    assert_eq!(state.3.status().unwrap().state, TransportState::Stopped);
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    state.3.test_playing_source(&project);
    let before = state.3.status().unwrap();
    close_owned(&state, &nonce, &project, &opened.document.project_id).unwrap();
    let after = state.3.status().unwrap();
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.project_id.as_deref(), Some(project.as_str()));
    assert_eq!(after.state, TransportState::Playing);
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_status_stops_only_the_owned_transport_on_changed_or_missing_media() {
    for missing in [false, true] {
        let (state, root, project, nonce, media) = setup();
        let opened = open_owned(
            &state,
            &nonce,
            &project,
            &media,
            Default::default(),
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let id = opened.document.project_id;
        assert_eq!(
            media_status_owned(&state, &nonce, &project, &id).unwrap(),
            "ready"
        );
        state.3.test_playing_source(&id);
        if missing {
            std::fs::remove_file(root.join("project/audio.wav")).unwrap();
        } else {
            std::fs::write(root.join("project/audio.wav"), b"changed").unwrap();
        }
        assert_eq!(
            media_status_owned(&state, &nonce, &project, &id).unwrap(),
            if missing { "missing" } else { "changed" }
        );
        assert!(state.6.inspection.current.lock().unwrap().is_none());
        assert_eq!(
            state.3.status().unwrap().state,
            annotator_core::audio::engine::TransportState::Stopped
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn processed_playback_prepares_without_parent_locks_and_live_gain_keeps_generation_and_cursor() {
    use super::super::playback::{MonitorGainRequest, PlaybackRequest, PlaybackStatus};
    use annotator_core::{
        audio::{PlaybackMode, SelectionSource},
        model::Region,
    };
    let (state, root, project, nonce, media) = setup();
    let before = snapshot(&state);
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let id = opened.document.project_id;
    let request = PlaybackRequest {
        project_id: id.clone(),
        media_id: media.clone(),
        mode: PlaybackMode::Selection {
            region: Region {
                media_id: media.clone(),
                channel_index: 1,
                start_seconds: 0.,
                end_seconds: 0.1,
                low_hz: 0.,
                high_hz: 4000.,
            },
            source: SelectionSource::Processed,
        },
        bypass: false,
        looping: false,
        volume: 0.5,
        monitor_gain_db: 0.,
        device_id: None,
        seek_seconds: Some(0.),
        play: true,
    };
    let mut buffer = None;
    let status = playback_owned(
        &state,
        &nonce,
        &project,
        &id,
        request,
        |preview, request| {
            assert!(state.0.try_lock().is_ok());
            assert!(state.6.inspection.current.try_lock().is_ok());
            buffer = Some(
                preview
                    .3
                    .test_output(&request.project_id, &request.media_id),
            );
            Ok(preview.3.status().unwrap())
        },
    )
    .unwrap();
    let buffer = buffer.unwrap();
    let request = MonitorGainRequest {
        project_id: id.clone(),
        media_id: media.clone(),
        generation: status.generation,
        monitor_gain_db: -12.0,
    };
    let before_status = state.3.status().unwrap();
    let after = monitor_owned(&state, &nonce, &project, &id, &request).unwrap();
    assert_eq!(after.generation, before_status.generation);
    assert_eq!(after.position_seconds, before_status.position_seconds);
    assert_eq!(buffer.consumed(), 0);
    assert!((buffer.monitor_scalar() - 10.0_f32.powf(-12.0 / 20.0)).abs() < 1e-7);
    assert_eq!(before, snapshot(&state));
    let _: PlaybackStatus = after;
    close_owned(&state, &nonce, &project, &id).unwrap();
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_or_stale_caller_binding_does_not_retire_a_current_session() {
    let (state, root, project, nonce, media) = setup();
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let id = opened.document.project_id;
    assert!(with_preview(&state, "stale", &project, &id, |_| Ok(())).is_err());
    assert!(with_preview(
        &state,
        &nonce,
        &uuid::Uuid::new_v4().to_string(),
        &id,
        |_| Ok(())
    )
    .is_err());
    assert!(with_preview(
        &state,
        &nonce,
        &project,
        &uuid::Uuid::new_v4().to_string(),
        |_| Ok(())
    )
    .is_err());
    assert!(with_preview(&state, &nonce, &project, &id, |_| Ok(())).is_ok());
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_owner_replacement_and_selected_source_edits_retire_only_the_old_preview() {
    for kind in [
        "nonce",
        "actor",
        "generation",
        "project",
        "edits",
        "removed",
    ] {
        let (state, root, project, nonce, media) = setup();
        let opened = open_owned(
            &state,
            &nonce,
            &project,
            &media,
            Default::default(),
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let id = opened.document.project_id;
        state.3.test_playing_source(&id);
        let old = state
            .6
            .inspection
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let view = old.state.2.scheduler.register_view().unwrap();
        match kind {
            "nonce" => state.6.current.lock().unwrap().nonce = uuid::Uuid::new_v4().to_string(),
            "actor" => *state.6.selected.lock().unwrap() = Some(uuid::Uuid::new_v4().to_string()),
            "generation" => state.1.lock().unwrap().reset(),
            "project" => {
                let mut document = snapshot(&state).document;
                document.project_id = uuid::Uuid::new_v4().to_string();
                *state.0.lock().unwrap() =
                    Some(LocalProject::transient(root.join("project"), document).unwrap());
            }
            _ => {
                let mut guard = state.0.lock().unwrap();
                let p = guard.as_mut().unwrap();
                let document = p.snapshot().unwrap().document;
                let change = if kind == "removed" {
                    Change::RemoveMedia {
                        media_id: media.clone(),
                    }
                } else {
                    Change::AddEdit {
                        edit: annotator_core::model::SpectralEdit {
                            id: uuid::Uuid::new_v4().to_string(),
                            region: annotator_core::model::Region {
                                media_id: media.clone(),
                                channel_index: 0,
                                start_seconds: 0.,
                                end_seconds: 0.01,
                                low_hz: 0.,
                                high_hz: 4000.,
                            },
                            enabled: true,
                            processing_version: 2,
                            operation: annotator_core::model::EditOperation::Mask,
                        },
                    }
                };
                p.apply_change(&project, document.revision, change).unwrap();
            }
        }
        assert!(
            with_preview(&state, &nonce, &project, &id, |_| Ok(())).is_err(),
            "{kind}"
        );
        assert!(
            state.6.inspection.current.lock().unwrap().is_none(),
            "{kind}"
        );
        assert!(old.state.0.lock().unwrap().is_none());
        assert!(old
            .state
            .2
            .scheduler
            .submit(&view, 1, true, |_| Ok(vec![]))
            .is_err());
        assert_eq!(
            state.3.status().unwrap().state,
            annotator_core::audio::engine::TransportState::Stopped
        );
        drop(old);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn main_revision_and_analysis_changes_do_not_rebind_the_preview() {
    let (state, root, project, nonce, media) = setup();
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let mut guard = state.0.lock().unwrap();
    let p = guard.as_mut().unwrap();
    let d = p.snapshot().unwrap().document;
    p.apply_change(
        &project,
        d.revision,
        Change::UpdateAnalysis {
            media_id: media.clone(),
            settings: AnalysisSettings {
                fft_size: 4096,
                ..Default::default()
            },
        },
    )
    .unwrap();
    drop(guard);
    assert!(with_preview(
        &state,
        &nonce,
        &project,
        &opened.document.project_id,
        |_| Ok(())
    )
    .is_ok());
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancelled_and_superseded_openings_never_publish_or_take_over_newer_audio() {
    let (state, root, project, nonce, media) = setup();
    let request = uuid::Uuid::new_v4().to_string();
    cancel_open_owned(&state, &nonce, &project, &request).unwrap();
    assert!(open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        request
    )
    .is_err());
    let (owner, ticket, source) = start_open(
        &state,
        &nonce,
        &project,
        &media,
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    cancel_open_owned(&state, &nonce, &project, &ticket.request_id).unwrap();
    assert!(finish_open(&state, owner, ticket, source, Default::default()).is_err());
    let (owner, ticket, source) = start_open(
        &state,
        &nonce,
        &project,
        &media,
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let newer = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    state.3.test_playing_source(&newer.document.project_id);
    let before = state.3.status().unwrap();
    assert!(finish_open(&state, owner, ticket, source, Default::default()).is_err());
    assert_eq!(state.3.status().unwrap().generation, before.generation);
    assert!(close_owned(&state, &nonce, &project, &uuid::Uuid::new_v4().to_string()).is_err());
    close_owned(&state, &nonce, &project, &newer.document.project_id).unwrap();
    let (owner, ticket, source) = start_open(
        &state,
        &nonce,
        &project,
        &media,
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    state.3.test_playing_source(&project);
    let before = state.3.status().unwrap();
    assert!(finish_open(&state, owner, ticket, source, Default::default()).is_err());
    assert_eq!(state.3.status().unwrap().generation, before.generation);
    assert_eq!(
        state.3.status().unwrap().project_id.as_deref(),
        Some(project.as_str())
    );
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn changed_source_during_open_and_failed_openings_release_all_admission_permits() {
    let (state, root, project, nonce, media) = setup();
    let original = std::fs::read(root.join("project/audio.wav")).unwrap();
    for _ in 0..6 {
        let (owner, ticket, source) = start_open(
            &state,
            &nonce,
            &project,
            &media,
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        std::fs::write(root.join("project/audio.wav"), b"changed").unwrap();
        assert!(finish_open(&state, owner, ticket, source, Default::default()).is_err());
        std::fs::write(root.join("project/audio.wav"), &original).unwrap();
    }
    let leases = (0..4)
        .map(|_| state.6.inspection.admit().unwrap())
        .collect::<Vec<_>>();
    assert!(state.6.inspection.admit().is_err());
    assert!(open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string()
    )
    .is_err());
    drop(leases);
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    close_owned(&state, &nonce, &project, &opened.document.project_id).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let leases = (0..4)
            .map(|_| state.6.inspection.admit())
            .collect::<Result<Vec<_>>>();
        if leases.is_ok() {
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

fn inventory(root: &Path) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn visit(
        base: &Path,
        root: &Path,
        out: &mut std::collections::BTreeMap<PathBuf, Option<Vec<u8>>>,
    ) {
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            let relative = path.strip_prefix(base).unwrap().to_path_buf();
            if path.is_dir() {
                out.insert(relative, None);
                visit(base, &path, out);
            } else {
                // Windows writer leases deny byte reads while held. Inventory their
                // names/lengths; every content file still compares its actual bytes.
                let bytes = std::fs::read(&path).unwrap_or_else(|error| {
                    assert_eq!(
                        error.raw_os_error(),
                        Some(33),
                        "{}: {error}",
                        path.display()
                    );
                    assert!(path.to_string_lossy().ends_with(".lock"));
                    format!("held-lease:{}", path.metadata().unwrap().len()).into_bytes()
                });
                out.insert(relative, Some(bytes));
            }
        }
    }
    let mut result = Default::default();
    visit(root, root, &mut result);
    result
}

#[test]
fn shared_and_explicit_actor_none_readonly_inspection_use_shared_root_and_preserve_every_file() {
    use super::super::collaboration::test_profiles;
    use annotator_core::collaboration::*;
    for read_only in [false, true] {
        let (state, root, _, _, _) = setup();
        let document = snapshot(&state).document;
        let m = &document.media[0];
        for name in ["shared/media", "shared/authors", "shared/annotations"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let source_ref = format!("media/{}.wav", m.id);
        std::fs::copy(
            root.join("project/audio.wav"),
            root.join("shared").join(&source_ref),
        )
        .unwrap();
        let manifest = CollaborationManifest {
            kind: MANIFEST_KIND.into(),
            format_version: CURRENT_COLLABORATION_FORMAT,
            project_id: document.project_id.clone(),
            name: document.name.clone(),
            created_at: document.created_at.clone(),
            media: vec![PublicMedia {
                id: m.id.clone(),
                display_name: m.display_name.clone(),
                source_ref,
                sha256: m.sha256.clone(),
                byte_length: m.byte_length,
                sample_rate: m.sample_rate,
                frame_count: m.frame_count,
                channel_count: m.channel_count,
                channel_layout: m.channel_layout.clone(),
            }],
        };
        test_profiles::write_manifest(&root.join("shared"), &manifest);
        let repo = Arc::new(CollaborationRepository::open(&root.join("shared")).unwrap());
        let foreign = repo.adopt(&test_profiles::profile("foreign")).unwrap();
        repo.publish(&foreign, None, &LayerPayload::default())
            .unwrap();
        let own_profile = test_profiles::profile("own");
        let own = Arc::new(repo.adopt(&own_profile).unwrap());
        *state.6.selected.lock().unwrap() = Some(own_profile.author_id.clone());
        let local = state.6.local().unwrap();
        let p = if read_only {
            LocalProject::open_shared_view_only(repo.clone(), &local).unwrap()
        } else {
            LocalProject::open_shared(repo.clone(), Some(own.clone()), &local).unwrap()
        };
        *state.0.lock().unwrap() = Some(p);
        state.6.install(Some(repo.clone())).unwrap();
        std::fs::write(
            local.join("global-settings-sentinel.json"),
            b"unchanged global preferences",
        )
        .unwrap();
        let nonce = state.6.current.lock().unwrap().nonce.clone();
        let before = snapshot(&state);
        let files = inventory(&root);
        let project = before.document.project_id.clone();
        let media = m.id.clone();
        let opened = open_owned(
            &state,
            &nonce,
            &project,
            &media,
            Default::default(),
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let p = state
            .6
            .inspection
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        assert_eq!(
            p.state.0.lock().unwrap().as_ref().unwrap().root(),
            root.join("shared").canonicalize().unwrap()
        );
        assert_ne!(
            p.state.0.lock().unwrap().as_ref().unwrap().root(),
            state.0.lock().unwrap().as_ref().unwrap().storage_root()
        );
        let r = tile_request(
            &p,
            annotator_core::analysis::source::AnalysisSource::Processed,
            0,
        );
        assert!(!tile_owned(&state, &nonce, &project, &p.id, r, |_| true)
            .unwrap()
            .is_empty());
        configure_analysis_owned(
            &state,
            &nonce,
            &project,
            &p.id,
            AnalysisSettings {
                fft_size: 4096,
                ..Default::default()
            },
        )
        .unwrap();
        let buffer = p.state.3.test_output(&p.id, &p.media_id);
        let generation = p.state.3.status().unwrap().generation;
        monitor_owned(
            &state,
            &nonce,
            &project,
            &p.id,
            &super::super::playback::MonitorGainRequest {
                project_id: p.id.clone(),
                media_id: p.media_id.clone(),
                generation,
                monitor_gain_db: 6.0,
            },
        )
        .unwrap();
        assert!(buffer.monitor_scalar() > 1.9);
        close_owned(&state, &nonce, &project, &opened.document.project_id).unwrap();
        assert_eq!(before, snapshot(&state));
        assert_eq!(files, inventory(&root));
        assert_eq!(
            *state.6.selected.lock().unwrap(),
            Some(own_profile.author_id)
        );
        drop(p);
        drop(state);
        drop(own);
        drop(foreign);
        drop(repo);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn opening_revalidates_native_edits_before_installing_and_generation_cancel_releases_waiters() {
    let (state, root, project, nonce, media) = setup();
    let (owner, ticket, source) = start_open(
        &state,
        &nonce,
        &project,
        &media,
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    {
        let mut guard = state.0.lock().unwrap();
        let p = guard.as_mut().unwrap();
        let d = p.snapshot().unwrap().document;
        p.apply_change(
            &project,
            d.revision,
            Change::UpdateMediaNote {
                media_id: media.clone(),
                note: "changed during opening".into(),
                merge_key: None,
            },
        )
        .unwrap();
    }
    assert!(finish_open(&state, owner, ticket, source, Default::default()).is_err());
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let p = state
        .6
        .inspection
        .current
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    let request = tile_request(
        &p,
        annotator_core::analysis::source::AnalysisSource::Original,
        0,
    );
    let view = request.view_id.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let (release, waiting) = std::sync::mpsc::channel();
    let waiting = std::sync::Mutex::new(Some(waiting));
    let worker = state.clone();
    let worker_project = project.clone();
    let worker_nonce = nonce.clone();
    let id = opened.document.project_id.clone();
    let main_authority = state.0.clone();
    let work = std::thread::spawn(move || {
        tile_owned(
            &worker,
            &worker_nonce,
            &worker_project,
            &id,
            request,
            move |event| {
                if serde_json::to_value(event).unwrap()["phase"] == "ready" {
                    assert!(main_authority.try_lock().is_ok());
                    send.send(()).unwrap();
                    waiting.lock().unwrap().take().unwrap().recv().unwrap();
                }
                true
            },
        )
    });
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    p.state.2.scheduler.cancel_generation(&view, 1).unwrap();
    release.send(()).unwrap();
    assert!(work.join().unwrap().is_err());
    assert!(
        p.state.0.lock().unwrap().is_some(),
        "cancelling one tile generation must preserve the session"
    );
    let mut next = tile_request(
        &p,
        annotator_core::analysis::source::AnalysisSource::Original,
        0,
    );
    next.view_id = view;
    next.generation = 2;
    assert!(tile_owned(&state, &nonce, &project, &p.id, next, |_| true).is_ok());
    drop(p);
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn examples_and_inspection_share_one_current_preview_and_four_resource_permits() {
    let state = AppState::default();
    assert!(Arc::ptr_eq(&state.6.examples, &state.6.inspection));
    let _inspection = state.6.inspection.admit().unwrap();
    let _examples = (0..3)
        .map(|_| state.6.examples.admit().unwrap())
        .collect::<Vec<_>>();
    assert!(state.6.inspection.admit().is_err());
    assert!(state.6.examples.admit().is_err());
}

#[test]
fn a_warm_tile_still_rejects_changed_or_missing_source_and_releases_the_owned_preview() {
    for missing in [false, true] {
        let (state, root, project, nonce, media) = setup();
        let opened = open_owned(
            &state,
            &nonce,
            &project,
            &media,
            Default::default(),
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let p = state
            .6
            .inspection
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let request = tile_request(
            &p,
            annotator_core::analysis::source::AnalysisSource::Original,
            0,
        );
        assert!(tile_owned(&state, &nonce, &project, &p.id, request.clone(), |_| true).is_ok());
        state.3.test_playing_source(&opened.document.project_id);
        if missing {
            std::fs::remove_file(root.join("project/audio.wav")).unwrap();
        } else {
            std::fs::write(root.join("project/audio.wav"), b"changed after warm tile").unwrap();
        }
        assert!(tile_owned(&state, &nonce, &project, &p.id, request, |_| true).is_err());
        assert!(p.state.0.lock().unwrap().is_none());
        assert!(state.6.inspection.current.lock().unwrap().is_none());
        assert_eq!(
            state.3.status().unwrap().state,
            annotator_core::audio::engine::TransportState::Stopped
        );
        drop(p);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn rejected_native_playback_parameters_preserve_active_audition_and_tile_leases() {
    use crate::commands::playback::{prepare_configuration, PlaybackRequest};
    use annotator_core::audio::{DspProcessor, PlaybackMode, SelectionSource, SourceInfo};
    use annotator_core::model::Region;
    let (state, root, project, nonce, media) = setup();
    let before = snapshot(&state);
    let opened = open_owned(
        &state,
        &nonce,
        &project,
        &media,
        Default::default(),
        uuid::Uuid::new_v4().to_string(),
    )
    .unwrap();
    let id = opened.document.project_id;
    let p = state
        .6
        .inspection
        .current
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .clone();
    let buffer = state.3.test_output(&id, &media);
    let status = state.3.status().unwrap();
    let tile = tile_request(
        &p,
        annotator_core::analysis::source::AnalysisSource::Original,
        0,
    );
    let region = Region {
        media_id: media.clone(),
        channel_index: 1,
        start_seconds: 0.,
        end_seconds: 0.1,
        low_hz: 0.,
        high_hz: 24000.,
    };
    let valid = PlaybackRequest {
        project_id: id.clone(),
        media_id: media.clone(),
        mode: PlaybackMode::Selection {
            region: region.clone(),
            source: SelectionSource::Processed,
        },
        bypass: false,
        looping: false,
        volume: 0.5,
        monitor_gain_db: 0.,
        device_id: None,
        seek_seconds: Some(0.),
        play: true,
    };
    let mut invalid = Vec::new();
    invalid.push((
        "volume",
        PlaybackRequest {
            volume: 2.,
            ..valid.clone()
        },
    ));
    invalid.push((
        "monitor",
        PlaybackRequest {
            monitor_gain_db: 25.,
            ..valid.clone()
        },
    ));
    invalid.push((
        "seek",
        PlaybackRequest {
            seek_seconds: Some(-1.),
            ..valid.clone()
        },
    ));
    for (name, region) in [
        (
            "channel",
            Region {
                channel_index: 2,
                ..region.clone()
            },
        ),
        (
            "range",
            Region {
                start_seconds: 0.08,
                end_seconds: 0.02,
                ..region.clone()
            },
        ),
        (
            "selection source",
            Region {
                media_id: uuid::Uuid::new_v4().to_string(),
                ..region
            },
        ),
    ] {
        invalid.push((
            name,
            PlaybackRequest {
                mode: PlaybackMode::Selection {
                    region,
                    source: SelectionSource::Processed,
                },
                ..valid.clone()
            },
        ));
    }
    for (name, request) in invalid {
        let result = playback_owned(
            &state,
            &nonce,
            &project,
            &id,
            request,
            |preview, request| {
                // This is the exact scalar/source/DSP selection validation used by
                // configure_owned, before its platform device/publication boundary.
                prepare_configuration(&preview, None, &request)?;
                panic!("malformed {name} was accepted")
            },
        );
        assert_eq!(
            result
                .err()
                .expect("malformed request must be rejected")
                .code,
            annotator_core::error::ErrorCode::InvalidInput,
            "{name}"
        );
        assert!(
            p.state.0.lock().unwrap().is_some(),
            "{name} must not retire the session"
        );
        let after = state.3.status().unwrap();
        assert_eq!(after.generation, status.generation, "{name}");
        assert_eq!(after.state, status.state, "{name}");
        assert_eq!(after.position_seconds, status.position_seconds, "{name}");
        assert_eq!(buffer.consumed(), 0, "{name}");
        assert!(
            tile_owned(&state, &nonce, &project, &id, tile.clone(), |_| true).is_ok(),
            "{name} must preserve existing tile leases"
        );
    }
    let audition = playback_owned(&state, &nonce, &project, &id, valid, |preview, request| {
        let prepared = prepare_configuration(&preview, None, &request)?;
        let m = prepared.descriptor;
        let decoded = annotator_core::media::decode::rehydrate(
            &m,
            &prepared.root,
            &std::env::temp_dir().join("inspection-rejection-pcm"),
            &AtomicBool::new(false),
            |_, _| {},
        )?;
        let mut cache = annotator_core::media::pcm_cache::PcmCache::for_playback();
        let mut dsp = DspProcessor::new(
            SourceInfo {
                media_id: m.id,
                sample_rate: m.sample_rate,
                frame_count: m.frame_count,
                channel_count: m.channel_count as usize,
            },
            2,
            request.mode,
            &prepared.doc.edits,
        )?;
        let samples = dsp.read_frames(0, 1024, |start, count| {
            cache.read_frames(&decoded.pcm, start, count)
        })?;
        assert!(samples.iter().any(|sample| sample.abs() > 0.01));
        preview.3.status()
    })
    .unwrap();
    assert_eq!(audition.generation, status.generation);
    assert_eq!(buffer.consume(), [0.25, -0.25]);
    assert_eq!(before, snapshot(&state));
    close_owned(&state, &nonce, &project, &id).unwrap();
    drop(p);
    drop(state);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn playback_source_and_output_failures_still_retire_the_owned_session() {
    use crate::commands::playback::{prepare_configuration, PlaybackRequest};
    for source_missing in [false, true] {
        let (state, root, project, nonce, media) = setup();
        let opened = open_owned(
            &state,
            &nonce,
            &project,
            &media,
            Default::default(),
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
        let id = opened.document.project_id;
        let p = state
            .6
            .inspection
            .current
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .clone();
        let _buffer = state.3.test_output(&id, &media);
        let view = p.state.2.scheduler.register_view().unwrap();
        let request = PlaybackRequest {
            project_id: id.clone(),
            media_id: media,
            mode: annotator_core::audio::PlaybackMode::Processed,
            bypass: false,
            looping: false,
            volume: 0.5,
            monitor_gain_db: 0.,
            device_id: None,
            seek_seconds: Some(0.),
            play: true,
        };
        if source_missing {
            std::fs::remove_file(root.join("project/audio.wav")).unwrap();
        }
        let result = playback_owned(
            &state,
            &nonce,
            &project,
            &id,
            request,
            |preview, request| {
                assert!(
                    !source_missing,
                    "missing source must reject before output setup"
                );
                prepare_configuration(&preview, None, &request)?;
                // Only the platform output boundary is simulated, after real preflight.
                Err(AppError::new(
                    annotator_core::error::ErrorCode::DeviceFailed,
                    "output unavailable",
                ))
            },
        );
        assert!(result.is_err());
        assert!(p.state.0.lock().unwrap().is_none());
        assert!(state.6.inspection.current.lock().unwrap().is_none());
        assert!(p
            .state
            .2
            .scheduler
            .submit(&view, 1, true, |_| Ok(vec![]))
            .is_err());
        assert_eq!(
            state.3.status().unwrap().state,
            annotator_core::audio::engine::TransportState::Stopped
        );
        drop(p);
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}
