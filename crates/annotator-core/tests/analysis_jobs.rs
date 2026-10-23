use annotator_core::{
    analysis::{
        cache::TileCache,
        scheduler::Scheduler,
        tiles::{compute_tile, config_hash, encode_tile, TileRequest, MAX_RESPONSE_BYTES},
    },
    error::{ErrorCode, Result},
    model::{AnalysisSettings, SpectrumKind},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
fn request() -> TileRequest {
    let settings = AnalysisSettings {
        window_size: 64,
        fft_size: 64,
        hop_size: 64,
        ..Default::default()
    };
    TileRequest {
        analysis_source: annotator_core::analysis::source::AnalysisSource::Original,
        processing_version: 1,
        edit_signature: String::new(),
        request_id: "request-1".into(),
        view_id: "view-1".into(),
        project_id: "project-1".into(),
        media_id: "media-1".into(),
        generation: 1,
        config_hash: config_hash(&settings),
        settings,
        channel_index: 0,
        kind: SpectrumKind::Stft,
        start_frame: 0,
        frame_count: 2,
        time_lod: 1,
        frequency_start: 0,
        frequency_count: 33,
        frequency_lod: 0,
        visible: true,
    }
}
#[test]
fn tile_averages_linear_power_and_clips_physical_tail() {
    let req = request();
    let tile = compute_tile(
        &req,
        48000,
        193,
        &AtomicBool::new(false),
        |start, count| Ok(vec![if start == 0 { 1. } else { 0. }; count]),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(tile.rows, 2);
    assert_eq!(tile.source_frames, 4);
    assert_eq!(tile.end_seconds, 193. / 48000.);
    assert!((tile.values[0] + 3.0103).abs() < 0.001);
    assert_eq!(tile.values[33], -160.);
    assert_eq!(tile.columns, 33);
    assert_eq!(tile.frame_step_samples, 128);
    let packet = encode_tile(&req, &tile).unwrap();
    assert_eq!(&packet[..4], b"AT01");
    assert!(packet.len() < MAX_RESPONSE_BYTES);
    let mut oversized = req.clone();
    oversized.settings.fft_size = 65536;
    oversized.config_hash = config_hash(&oversized.settings);
    oversized.frequency_count = 32769;
    oversized.frame_count = 256;
    assert_eq!(
        compute_tile(
            &oversized,
            48000,
            100000,
            &AtomicBool::new(false),
            |_, _| panic!("must reject before PCM"),
            |_, _| {}
        )
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
}
#[test]
fn configuration_keys_cover_identity_and_analysis_but_not_view_style() {
    let r = request();
    let key = r.cache_key("abc", 48000, 193);
    for mutate in [
        |r: &mut TileRequest| r.channel_index = 1,
        |r: &mut TileRequest| r.settings.hop_size = 32,
        |r: &mut TileRequest| r.kind = SpectrumKind::Mel,
        |r: &mut TileRequest| r.time_lod = 0,
        |r: &mut TileRequest| r.frequency_lod = 1,
    ] {
        let mut other = r.clone();
        mutate(&mut other);
        assert_ne!(key, other.cache_key("abc", 48000, 193));
    }
    assert_ne!(key, r.cache_key("def", 48000, 193));
    assert_ne!(key, r.cache_key("abc", 44100, 193));
    let mut other = r.clone();
    other.request_id = "new".into();
    other.generation = 99;
    other.view_id = "other-view".into();
    other.visible = false;
    assert_eq!(key, other.cache_key("abc", 48000, 193));
}
#[test]
fn frequency_lod_uses_power_and_mel_tiles_keep_triangle_geometry() {
    let mut req = request();
    req.settings.window = annotator_core::model::WindowFunction::Rectangular;
    req.config_hash = config_hash(&req.settings);
    req.frequency_lod = 1;
    let tile = compute_tile(
        &req,
        48000,
        193,
        &AtomicBool::new(false),
        |start, count| Ok(vec![if start == 0 { 1. } else { 0. }; count]),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(tile.columns, 17);
    assert!((tile.values[0] + 6.0206).abs() < 0.001);
    req.kind = SpectrumKind::Mel;
    req.frequency_count = 128;
    let mel = compute_tile(
        &req,
        48000,
        193,
        &AtomicBool::new(false),
        |_, count| Ok(vec![0.; count]),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(mel.columns, 64);
    assert_eq!(mel.mel_points_hz.len(), 130);
    assert_eq!(mel.mel_points_hz[0], 0.);
    assert!((mel.mel_points_hz[129] - 24000.).abs() < 1e-9);
    assert!(mel.values.iter().all(|x| *x == -160.));
}
#[test]
fn visible_jobs_precede_background_queue_and_old_generations_never_run() {
    let scheduler = Scheduler::new(1, 32);
    let held = scheduler.register_view().unwrap();
    let background = scheduler.register_view().unwrap();
    let visible_view = scheduler.register_view().unwrap();
    let late = scheduler.register_view().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let hold = scheduler
        .submit(&held, 1, false, move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(vec![])
        })
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let (order_tx, order_rx) = mpsc::channel();
    let tx = order_tx.clone();
    let back = scheduler
        .submit(&background, 1, false, move |_| {
            tx.send(2).unwrap();
            Ok(vec![])
        })
        .unwrap();
    let visible = scheduler
        .submit(&visible_view, 1, true, move |_| {
            order_tx.send(1).unwrap();
            Ok(vec![])
        })
        .unwrap();
    scheduler.cancel_generation(&late, 3).unwrap();
    assert_eq!(
        scheduler
            .submit(&late, 2, true, |_| panic!("stale job"))
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    release_tx.send(()).unwrap();
    hold.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
    visible
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    back.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
    assert_eq!(order_rx.recv().unwrap(), 1);
    assert_eq!(order_rx.recv().unwrap(), 2);
}
#[test]
fn cache_is_bounded_lru_persistent_and_recovers_corruption() {
    let root = std::env::temp_dir().join(format!("tile-test-{}", uuid::Uuid::new_v4()));
    let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
    let mut cache = TileCache::new(root.clone(), 8, 80).unwrap();
    cache.put(&a, vec![1; 4]).unwrap();
    cache.put(&b, vec![2; 4]).unwrap();
    assert_eq!(&*cache.get(&a).unwrap().unwrap(), &vec![1; 4]);
    cache.put(&c, vec![3; 4]).unwrap();
    assert!(cache.resident_bytes() <= 8);
    assert!(cache.disk_bytes().unwrap() <= 80);
    drop(cache);
    let mut cache = TileCache::new(root.clone(), 8, 80).unwrap();
    assert_eq!(&*cache.get(&c).unwrap().unwrap(), &vec![3; 4]);
    std::fs::write(root.join(format!("{c}.tile")), b"broken").unwrap();
    cache.clear_memory();
    assert!(cache.get(&c).unwrap().is_none());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn disk_lru_refreshes_on_memory_hits_and_never_deletes_noncache_files() {
    use std::fs::{FileTimes, OpenOptions};
    use std::time::SystemTime;
    let root = std::env::temp_dir().join(format!("lru-test-{}", uuid::Uuid::new_v4()));
    let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
    let mut cache = TileCache::new(root.clone(), 8, 72).unwrap();
    cache.put(&a, vec![1; 4]).unwrap();
    cache.put(&b, vec![2; 4]).unwrap();
    for (key, seconds) in [(&a, 1), (&b, 2)] {
        OpenOptions::new()
            .write(true)
            .open(root.join(format!("{key}.tile")))
            .unwrap()
            .set_times(
                FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
            )
            .unwrap();
    }
    std::fs::write(root.join("source.wav"), b"never delete").unwrap();
    cache.get(&a).unwrap();
    cache.put(&c, vec![3; 4]).unwrap();
    assert!(root.join(format!("{a}.tile")).exists());
    assert!(!root.join(format!("{b}.tile")).exists());
    assert!(cache.get(&b).unwrap().is_none());
    assert_eq!(
        std::fs::read(root.join("source.wav")).unwrap(),
        b"never delete"
    );
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn scheduler_bounds_workers_queue_cancels_only_view_and_drops_late_results() {
    let scheduler = Scheduler::new(2, 32);
    let (started_tx, started_rx) = mpsc::channel();
    let release = Arc::new(AtomicBool::new(false));
    let mut receivers = Vec::new();
    let a = scheduler.register_view().unwrap();
    let b = scheduler.register_view().unwrap();
    let overflow = scheduler.register_view().unwrap();
    for scope in [&a, &b] {
        let started = started_tx.clone();
        let release = release.clone();
        receivers.push(
            scheduler
                .submit(scope, 1, true, move |_| {
                    started.send(()).unwrap();
                    while !release.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                    }
                    Ok(vec![1])
                })
                .unwrap(),
        );
    }
    for _ in 0..2 {
        started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    let stale = scheduler
        .submit(&a, 1, false, move |_| {
            flag.store(true, Ordering::SeqCst);
            Ok(vec![9])
        })
        .unwrap();
    for _ in 0..31 {
        scheduler
            .submit(&scheduler.register_view().unwrap(), 1, false, |_| {
                Ok(vec![])
            })
            .unwrap();
    }
    assert_eq!(
        scheduler
            .submit(&overflow, 1, true, |_| Ok(vec![]))
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(scheduler.stats(), (2, 32));
    scheduler.cancel_generation(&a, 1).unwrap();
    release.store(true, Ordering::SeqCst);
    assert_eq!(
        receivers
            .remove(0)
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert!(receivers
        .remove(0)
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .is_ok());
    assert_eq!(
        stale
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert!(!ran.load(Ordering::SeqCst));
    assert_eq!(
        scheduler
            .submit(&a, 1, true, |_| Ok(vec![]))
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    let next = scheduler.submit(&a, 2, true, |_| Ok(vec![2])).unwrap();
    assert_eq!(
        next.recv_timeout(Duration::from_secs(3)).unwrap().unwrap(),
        vec![2]
    );
}
#[test]
fn scheduler_reset_invalidates_same_project_runtime_and_panics_do_not_kill_workers() {
    let scheduler = Scheduler::new(1, 32);
    let view = scheduler.register_view().unwrap();
    let (tx, rx) = mpsc::channel();
    let release = Arc::new(AtomicBool::new(false));
    let hold = release.clone();
    let old = scheduler
        .submit(&view, 1, true, move |_| {
            tx.send(()).unwrap();
            while !hold.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            Ok(vec![])
        })
        .unwrap();
    rx.recv_timeout(Duration::from_secs(3)).unwrap();
    scheduler.reset();
    release.store(true, Ordering::SeqCst);
    assert_eq!(
        old.recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    let view = scheduler.register_view().unwrap();
    let panic = scheduler
        .submit(&view, 1, true, |_| -> Result<Vec<u8>> {
            panic!("worker test")
        })
        .unwrap();
    assert_eq!(
        panic
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::AnalysisFailed
    );
    assert!(scheduler
        .submit(&view, 1, true, |_| Ok(vec![]))
        .unwrap()
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .is_ok());
}
#[test]
fn reopening_relative_media_rehydrates_without_changing_document_path_and_rejects_changed_source() {
    use annotator_core::media::{
        decode::{decode, rehydrate},
        registry::MediaTasks,
    };
    let root = std::env::temp_dir().join(format!("rehydrate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("media")).unwrap();
    let original = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    std::fs::copy(original, root.join("media/audio.wav")).unwrap();
    let cache = root.join("pcm");
    let cancel = AtomicBool::new(false);
    let decoded = decode(&root.join("media/audio.wav"), &cache, &cancel, |_, _| {}).unwrap();
    let mut expected = decoded.descriptor.clone();
    expected.source_ref = "media/audio.wav".into();
    expected.note = "retained".into();
    drop(decoded);
    let actual = rehydrate(&expected, &root, &cache, &cancel, |_, _| {}).unwrap();
    assert_eq!(actual.descriptor, expected);
    actual.verify_source().unwrap();
    let mut tasks = MediaTasks::default();
    let generation = tasks.generation();
    tasks.publish_rehydrated(generation, actual).unwrap();
    assert!(tasks.registry.get_checked(&expected).is_ok());
    let replacement = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/stereo24.wav");
    std::fs::copy(replacement, root.join("media/audio.wav")).unwrap();
    assert!(tasks.registry.get_checked(&expected).is_err());
    assert!(rehydrate(&expected, &root, &cache, &cancel, |_, _| {}).is_err());
    tasks.reset();
    std::fs::remove_dir_all(root).unwrap();
}
