use annotator_core::{
    analysis::{
        source::{edit_signature, AnalysisSource, SourceReader, PROCESSED_CACHE_BYTES},
        tiles::{compute_tile, config_hash, TileRequest},
    },
    audio::{DspProcessor, PlaybackMode, SourceInfo, DSP_VERSION},
    error::ErrorCode,
    model::{AnalysisSettings, Region, SpectralEdit, SpectrumKind},
};
use std::sync::atomic::{AtomicBool, Ordering};

fn info() -> SourceInfo {
    SourceInfo {
        media_id: "m".into(),
        sample_rate: 48000,
        frame_count: 48013,
        channel_count: 2,
    }
}
fn audio() -> Vec<f32> {
    (0..info().frame_count)
        .flat_map(|i| {
            let t = i as f64 / 48000.;
            let x = (0.3 * (std::f64::consts::TAU * 1500. * t).sin()
                + 0.3 * (std::f64::consts::TAU * 6000. * t).sin()) as f32;
            [x, x]
        })
        .collect()
}
fn edit(channel: u8) -> SpectralEdit {
    SpectralEdit {
        id: "e".into(),
        region: Region {
            media_id: "m".into(),
            channel_index: channel,
            start_seconds: 0.,
            end_seconds: 1.,
            low_hz: 1000.,
            high_hz: 2000.,
        },
        enabled: true,
        processing_version: 1,
    }
}
fn request(
    source: AnalysisSource,
    edits: &[SpectralEdit],
    window: u32,
    channel: u8,
) -> TileRequest {
    let settings = AnalysisSettings {
        window_size: window,
        fft_size: window,
        hop_size: 512,
        ..Default::default()
    };
    TileRequest {
        request_id: "r".into(),
        view_id: "v".into(),
        project_id: "p".into(),
        media_id: "m".into(),
        generation: 1,
        config_hash: config_hash(&settings),
        settings,
        analysis_source: source,
        processing_version: 1,
        edit_signature: if source == AnalysisSource::Processed {
            edit_signature("m", edits)
        } else {
            String::new()
        },
        channel_index: channel,
        kind: SpectrumKind::Stft,
        start_frame: 0,
        frame_count: 94,
        time_lod: 0,
        frequency_start: 0,
        frequency_count: window / 2 + 1,
        frequency_lod: 1,
        visible: true,
    }
}

#[test]
fn processed_tiles_match_independent_dsp_then_stft_for_masks_channels_and_large_windows() {
    let input = audio();
    let cancel = AtomicBool::new(false);
    let mut disabled = edit(0);
    disabled.enabled = false;
    let mut moved = edit(0);
    moved.region.low_hz = 5500.;
    moved.region.high_hz = 6500.;
    for edits in [
        vec![],
        vec![disabled],
        vec![edit(0)],
        vec![edit(0), edit(0), edit(1)],
        vec![moved],
        vec![edit(0)],
    ] {
        let mut reference =
            DspProcessor::new(info(), DSP_VERSION, PlaybackMode::Processed, &edits).unwrap();
        let mut pcm = Vec::new();
        for start in (0..info().frame_count).step_by(997) {
            let count = (info().frame_count - start).min(997) as usize;
            pcm.extend(
                reference
                    .read_frames(start, count, |s, n| {
                        Ok(input[s as usize * 2..(s as usize + n) * 2].to_vec())
                    })
                    .unwrap(),
            );
        }
        for (window, channel) in [(2048, 0), (2048, 1), (32768, 0)] {
            let mut r = request(AnalysisSource::Processed, &edits, window, channel);
            if window == 32768 {
                r.frame_count = 6;
                r.frequency_lod = 0;
            }
            let mut reader =
                SourceReader::new(info(), r.analysis_source, 1, &edits, channel).unwrap();
            let got = compute_tile(
                &r,
                48000,
                info().frame_count,
                &cancel,
                |s, n| {
                    reader.read_channel(s, n, &cancel, |s, n| {
                        assert!(n <= 4096);
                        Ok(input[s as usize * 2..(s as usize + n) * 2].to_vec())
                    })
                },
                |_, _| {},
            )
            .unwrap();
            let expected = compute_tile(
                &r,
                48000,
                info().frame_count,
                &cancel,
                |s, n| {
                    Ok(pcm[s as usize * 2..(s as usize + n) * 2]
                        .chunks_exact(2)
                        .map(|f| f[channel as usize])
                        .collect())
                },
                |_, _| {},
            )
            .unwrap();
            assert_eq!(got.values, expected.values);
            assert!(reader.resident_bytes() <= PROCESSED_CACHE_BYTES);
        }
    }
}

#[test]
fn random_access_head_tail_overlap_reuse_and_cancellation_are_bounded() {
    let input = audio();
    let cancel = AtomicBool::new(false);
    let edits = [edit(0)];
    let mut reader = SourceReader::new(info(), AnalysisSource::Processed, 1, &edits, 0).unwrap();
    let mut dsp = DspProcessor::new(info(), 1, PlaybackMode::Processed, &edits).unwrap();
    for (start, count) in [(0, 1), (47016, 997), (9517, 121), (1, 32768), (513, 32768)] {
        let got = reader
            .read_channel(start, count, &cancel, |s, n| {
                Ok(input[s as usize * 2..(s as usize + n) * 2].to_vec())
            })
            .unwrap();
        let mut expected = Vec::new();
        for offset in (0..count).step_by(73) {
            expected.extend(
                dsp.read_frames(start + offset as u64, (count - offset).min(73), |s, n| {
                    Ok(input[s as usize * 2..(s as usize + n) * 2].to_vec())
                })
                .unwrap()
                .chunks_exact(2)
                .map(|f| f[0]),
            );
        }
        assert_eq!(got, expected);
    }
    reader
        .read_channel(514, 32768, &cancel, |_, _| {
            panic!("overlapping windows must reuse retained processed blocks")
        })
        .unwrap();
    cancel.store(true, Ordering::Release);
    assert_eq!(
        reader
            .read_channel(514, 32768, &cancel, |_, _| panic!())
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    cancel.store(false, Ordering::Release);
    let mut reader = SourceReader::new(info(), AnalysisSource::Processed, 1, &edits, 0).unwrap();
    assert_eq!(
        reader
            .read_channel(0, 32768, &cancel, |s, n| {
                cancel.store(true, Ordering::Release);
                Ok(input[s as usize * 2..(s as usize + n) * 2].to_vec())
            })
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
}

#[test]
fn original_and_processed_cache_identities_never_alias_and_geometry_is_authoritative() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/analysis-signature.json"
    ))
    .unwrap();
    let shared: Vec<SpectralEdit> = serde_json::from_value(fixture["edits"].clone()).unwrap();
    assert_eq!(
        annotator_core::analysis::source::canonical_edits("m", &shared),
        fixture["canonical"].as_str().unwrap()
    );
    assert_eq!(
        edit_signature("m", &shared),
        fixture["signature"].as_str().unwrap()
    );
    assert_eq!(
        annotator_core::media::pcm_cache::PcmCache::for_analysis().capacity_bytes()
            + 2 * PROCESSED_CACHE_BYTES
            + annotator_core::media::pcm_cache::PcmCache::for_playback().capacity_bytes(),
        128 * 1024 * 1024
    );
    let edits = [edit(0)];
    let original = request(AnalysisSource::Original, &edits, 2048, 0);
    let processed = request(AnalysisSource::Processed, &edits, 2048, 0);
    assert_ne!(
        original.cache_key("hash", 48000, 48013),
        processed.cache_key("hash", 48000, 48013)
    );
    let mut different = processed.clone();
    different.edit_signature = edit_signature("m", &[]);
    assert_ne!(
        processed.cache_key("hash", 48000, 48013),
        different.cache_key("hash", 48000, 48013)
    );
    different.processing_version = 2;
    assert!(different.validate().is_err());
    different = processed.clone();
    different.edit_signature = "untrusted".into();
    assert!(different.validate().is_err());
    let mut unrelated = edit(1);
    unrelated.region.media_id = "other".into();
    let mut disabled = edit(1);
    disabled.enabled = false;
    let mut renamed = edit(0);
    renamed.id = "other-id".into();
    renamed.region.start_seconds = -0.;
    assert_eq!(
        edit_signature("m", &edits),
        edit_signature("m", &[unrelated, disabled, renamed, edit(0)])
    );
    let input = audio();
    let mut raw = SourceReader::new(info(), AnalysisSource::Original, 1, &edits, 1).unwrap();
    assert_eq!(
        raw.read_channel(17, 32768, &AtomicBool::new(false), |s, n| {
            assert!(n <= 4096);
            Ok(input[s as usize * 2..(s as usize + n) * 2].to_vec())
        })
        .unwrap(),
        input[34..(17 + 32768) * 2]
            .chunks_exact(2)
            .map(|f| f[1])
            .collect::<Vec<_>>()
    );
}
