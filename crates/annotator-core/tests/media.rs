use annotator_core::{
    error::ErrorCode,
    media::{decode::decode, pcm_cache::PcmCache, registry::same_identity},
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio")
        .join(name)
}
fn cache() -> PathBuf {
    std::env::temp_dir().join(format!("annotator-media-test-{}", uuid::Uuid::new_v4()))
}
#[test]
fn analysis_and_playback_share_one_pcm_retention_budget() {
    use annotator_core::media::pcm_cache::PCM_CACHE_BYTES;
    let analysis = PcmCache::for_analysis();
    let playback = PcmCache::for_playback();
    assert_eq!(
        analysis.capacity_bytes() + playback.capacity_bytes(),
        PCM_CACHE_BYTES
    );
    assert_eq!(analysis.capacity_bytes(), 96 * 1024 * 1024);
    assert_eq!(playback.capacity_bytes(), 32 * 1024 * 1024);
    // Exercise eviction with concurrent consumers retaining different parts of real PCM.
    let root = cache();
    let decoded = decode(
        &fixture("six32.wav"),
        &root,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    let mut analysis = PcmCache::new(4096 * 6 * 4);
    let mut playback = PcmCache::new(4096 * 6 * 4);
    for _ in 0..3 {
        for start in [0, 4096] {
            analysis.read_frames(&decoded.pcm, start, 704).unwrap();
            playback
                .read_frames(&decoded.pcm, 4096 - start, 704)
                .unwrap();
            assert!(analysis.resident_bytes() + playback.resident_bytes() <= 2 * 4096 * 6 * 4);
        }
    }
    drop(decoded);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn real_formats_decode_with_distinct_channels_and_exact_frames() {
    let root = cache();
    for (name, channels) in [
        ("mono16.wav", 1),
        ("stereo24.wav", 2),
        ("six32.wav", 6),
        ("float32.wav", 2),
        ("six.flac", 6),
        ("mono.flac", 1),
        ("stereo.mp3", 2),
    ] {
        let decoded = decode(&fixture(name), &root, &AtomicBool::new(false), |_, _| {}).unwrap();
        let m = &decoded.descriptor;
        assert_eq!(m.channel_count, channels);
        assert_eq!(m.sample_rate, 48000);
        assert_eq!(m.frame_count, decoded.pcm.frame_count());
        assert!(m.frame_count >= 4800);
        if !name.ends_with("mp3") {
            assert_eq!(m.frame_count, 4800);
        }
        let mut pcm = PcmCache::new(32 * 1024);
        let samples = pcm
            .read_frames(&decoded.pcm, 0, m.frame_count as usize)
            .unwrap();
        for c in 0..channels as usize {
            let energy = |f: f64| -> f64 {
                let (mut re, mut im) = (0_f64, 0_f64);
                for i in 0..4800 {
                    let a = 2. * std::f64::consts::PI * f * i as f64 / 48000.;
                    let v = samples[i * channels as usize + c] as f64;
                    re += v * a.cos();
                    im += v * a.sin();
                }
                re.hypot(im)
            };
            assert!(energy(300. * (c + 1) as f64) > 900., "{name} channel {c}");
            assert!(
                energy(300. * (c + 2) as f64) < 30.,
                "cross-channel contamination {name}"
            );
        }
        assert!(pcm.resident_bytes() <= 32 * 1024);
    }
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn malformed_and_cancelled_never_publish_pcm() {
    let root = cache();
    for (name, code) in [
        ("corrupt.wav", ErrorCode::DecodeFailed),
        ("truncated.wav", ErrorCode::DecodeFailed),
        ("zero.wav", ErrorCode::DecodeFailed),
        ("seven.wav", ErrorCode::UnsupportedChannels),
        ("nonfinite.wav", ErrorCode::DecodeFailed),
    ] {
        let error = decode(&fixture(name), &root, &AtomicBool::new(false), |_, _| {})
            .err()
            .unwrap();
        assert_eq!(error.code, code, "{name}: {error}");
    }
    let cancel = AtomicBool::new(false);
    assert_eq!(
        decode(&fixture("six32.wav"), &root, &cancel, |_, _| {
            cancel.store(true, Ordering::Relaxed);
        })
        .err()
        .unwrap()
        .code,
        ErrorCode::Cancelled
    );
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    std::fs::remove_dir(root).unwrap();
}
#[test]
fn pcm_ranges_identity_and_source_changes_are_checked() {
    let root = cache();
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("source.wav");
    std::fs::copy(fixture("stereo24.wav"), &source).unwrap();
    let decoded = decode(&source, &root, &AtomicBool::new(false), |_, _| {}).unwrap();
    let other = decode(
        &fixture("mono16.wav"),
        &root,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    assert!(same_identity(&decoded.descriptor, &decoded.descriptor));
    assert!(!same_identity(&decoded.descriptor, &other.descriptor));
    let mut cache = PcmCache::new(1024);
    let all = cache.read_frames(&decoded.pcm, 0, 4800).unwrap();
    assert_eq!(
        cache.read_frames(&decoded.pcm, 4090, 20).unwrap(),
        all[8180..8220]
    );
    assert!(cache.read_frames(&decoded.pcm, 4799, 2).is_err());
    decoded.verify_source().unwrap();
    std::fs::write(&source, b"changed").unwrap();
    assert_eq!(
        decoded.verify_source().unwrap_err().code,
        ErrorCode::IdentityMismatch
    );
    drop(decoded);
    drop(other);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn relink_preserves_current_notes_and_rejects_different_identity() {
    use annotator_core::{
        model::{Change, ProjectDocument},
        project::ProjectSession,
    };
    let root = cache();
    let decoded = decode(
        &fixture("mono16.wav"),
        &root,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    let mut session =
        ProjectSession::new(ProjectDocument::create("Media".into()).unwrap()).unwrap();
    let id = session.snapshot().document.project_id;
    let mut media = decoded.descriptor.clone();
    media.note = "keep latest note".into();
    session
        .apply_change(
            &id,
            0,
            Change::ImportMedia {
                media: media.clone(),
            },
        )
        .unwrap();
    let mut candidate = decoded.descriptor.clone();
    candidate.source_ref = "D:/moved/source.wav".into();
    let snapshot = session
        .apply_change(
            &id,
            1,
            Change::RelinkMedia {
                media: candidate.clone(),
            },
        )
        .unwrap();
    assert_eq!(snapshot.document.media[0].note, "keep latest note");
    assert_eq!(snapshot.document.media[0].source_ref, candidate.source_ref);
    candidate.sha256 = "0".repeat(64);
    assert_eq!(
        session
            .apply_change(&id, 2, Change::RelinkMedia { media: candidate })
            .unwrap_err()
            .code,
        ErrorCode::IdentityMismatch
    );
    drop(decoded);
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn stale_preparations_cannot_publish_after_runtime_replacement() {
    use annotator_core::media::registry::MediaTasks;
    let root = cache();
    let mut tasks = MediaTasks::default();
    let (generation, cancel) = tasks.begin("batch".into()).unwrap();
    let decoded = decode(&fixture("mono16.wav"), &root, &cancel, |_, _| {}).unwrap();
    tasks.reset();
    assert!(cancel.load(Ordering::Relaxed));
    assert_eq!(
        tasks
            .prepare_for_task(generation, "batch", decoded)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn streaming_hash_checks_original_bytes_and_changed_source_aborts() {
    use annotator_core::media::identity::fingerprint;
    let root = cache();
    std::fs::create_dir_all(&root).unwrap();
    let source = root.join("changing.wav");
    std::fs::copy(fixture("mono16.wav"), &source).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("sha256.json")).unwrap()).unwrap();
    let expected = manifest
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "mono16.wav")
        .unwrap()["sha256"]
        .as_str()
        .unwrap();
    assert_eq!(
        fingerprint(&source, &AtomicBool::new(false), |_| {}).unwrap(),
        expected
    );
    let error = decode(&source, &root, &AtomicBool::new(false), |phase, _| {
        if phase == "decoding" {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&source)
                .unwrap()
                .set_len(10000)
                .unwrap();
        }
    })
    .err()
    .unwrap();
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn known_pcm_size_checks_available_space_before_decoding() {
    use annotator_core::media::decode::check_pcm_space;
    assert!(check_pcm_space(Some(4800), 6, 4800 * 6 * 4).is_ok());
    assert_eq!(
        check_pcm_space(Some(4800), 6, 20).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(
        check_pcm_space(Some(u64::MAX), 6, u64::MAX)
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn release_is_scoped_to_the_task_that_prepared_the_descriptor() {
    use annotator_core::media::registry::MediaTasks;
    let root = cache();
    let mut tasks = MediaTasks::default();
    let (generation, cancel) = tasks.begin("new-task".into()).unwrap();
    let decoded = decode(&fixture("mono16.wav"), &root, &cancel, |_, _| {}).unwrap();
    let descriptor = tasks
        .prepare_for_task(generation, "new-task", decoded)
        .unwrap();
    tasks.release_for_task("old-task", &descriptor.id);
    assert!(tasks.prepared(&descriptor).is_ok());
    tasks.release_for_task("new-task", &descriptor.id);
    assert!(tasks.prepared(&descriptor).is_err());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn mp3_frame_count_comes_from_actual_packets_not_bitrate_estimates() {
    let root = cache();
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("sha256.json")).unwrap()).unwrap();
    for name in ["stereo.mp3", "vbr-no-xing.mp3"] {
        let decoded = decode(&fixture(name), &root, &AtomicBool::new(false), |_, _| {}).unwrap();
        let expected = manifest
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["name"] == name)
            .unwrap()["decodedFrames"]
            .as_u64()
            .unwrap();
        assert_eq!(decoded.descriptor.frame_count, expected, "{name}");
    }
    for name in ["truncated.mp3", "truncated-no-xing.mp3"] {
        assert_eq!(
            decode(&fixture(name), &root, &AtomicBool::new(false), |_, _| {})
                .err()
                .unwrap()
                .code,
            ErrorCode::DecodeFailed,
            "{name}"
        );
    }
    std::fs::remove_dir(root).unwrap();
}

fn extensible_six_channel_wav(mask: u32) -> Vec<u8> {
    let basic = std::fs::read(fixture("six32.wav")).unwrap();
    let mut wav = basic[..12].to_vec();
    // Exercise bounded chunk skipping and RIFF's even-byte padding.
    wav.extend_from_slice(b"JUNK\x03\0\0\0abc\0");
    wav.extend_from_slice(b"fmt \x28\0\0\0");
    let mut format = basic[20..36].to_vec();
    format[..2].copy_from_slice(&0xfffe_u16.to_le_bytes());
    wav.extend_from_slice(&format);
    wav.extend_from_slice(&22_u16.to_le_bytes());
    wav.extend_from_slice(&32_u16.to_le_bytes());
    wav.extend_from_slice(&mask.to_le_bytes());
    wav.extend_from_slice(&[1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]);
    wav.extend_from_slice(&basic[36..]);
    let riff_size = wav.len() as u32 - 8;
    wav[4..8].copy_from_slice(&riff_size.to_le_bytes());
    wav
}

#[test]
fn wav_layout_requires_an_explicit_valid_mask_and_preserves_sample_order() {
    let root = cache();
    std::fs::create_dir_all(&root).unwrap();
    let basic = decode(
        &fixture("six32.wav"),
        &root,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(
        basic.descriptor.channel_layout, None,
        "basic WAV has no speaker mask"
    );
    let float = decode(
        &fixture("float32.wav"),
        &root,
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(
        float.descriptor.channel_layout, None,
        "basic IEEE float WAV has no speaker mask"
    );
    let mut pcm = PcmCache::default();
    let original = pcm.read_frames(&basic.pcm, 0, 4800).unwrap();
    for (name, mask) in [("unspecified.bin", 0), ("explicit.bin", 0x3f)] {
        let path = root.join(name);
        std::fs::write(&path, extensible_six_channel_wav(mask)).unwrap();
        let decoded = decode(&path, &root, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(decoded.descriptor.channel_count, 6);
        assert_eq!(pcm.read_frames(&decoded.pcm, 0, 4800).unwrap(), original);
        if mask == 0 {
            assert_eq!(decoded.descriptor.channel_layout, None);
        } else {
            assert_eq!(decoded.descriptor.channel_layout.as_ref().unwrap().len(), 6);
            assert_eq!(
                decoded.descriptor.channel_layout.as_ref().unwrap()[0],
                "FRONT_LEFT"
            );
        }
        let rebound = decode(&path, &root, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert!(same_identity(&decoded.descriptor, &rebound.descriptor));
    }
    // These formats define channel positions in the format, not a WAV decoder fallback.
    for name in ["six.flac", "stereo.mp3"] {
        let decoded = decode(&fixture(name), &root, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert!(decoded.descriptor.channel_layout.is_some());
    }
    drop(basic);
    drop(float);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn contradictory_or_reserved_wav_masks_are_rejected_without_decoder_repairs() {
    let root = cache();
    std::fs::create_dir_all(&root).unwrap();
    for mask in [0x3, 0x7f, 0x8000001f] {
        let path = root.join(format!("invalid-{mask}.bin"));
        std::fs::write(&path, extensible_six_channel_wav(mask)).unwrap();
        let result = decode(&path, &root, &AtomicBool::new(false), |_, _| {});
        assert_eq!(
            result
                .err()
                .expect("invalid mask must not be repaired")
                .code,
            ErrorCode::DecodeFailed
        );
    }
    assert!(!std::fs::read_dir(&root).unwrap().any(|entry| entry
        .unwrap()
        .path()
        .extension()
        .is_some_and(|ext| ext == "pcm")));
    std::fs::remove_dir_all(root).unwrap();
}
