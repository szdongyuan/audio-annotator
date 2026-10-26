use annotator_core::{
    audio::{
        DspProcessor, PlaybackMode, SelectionSource, SourceInfo, DSP_VERSION, MAX_BLOCK_FRAMES,
    },
    error::ErrorCode,
    model::{Region, SpectralEdit},
};
use std::f64::consts::TAU;

fn info(frames: usize, channels: usize) -> SourceInfo {
    SourceInfo {
        media_id: "media".into(),
        sample_rate: 48000,
        frame_count: frames as u64,
        channel_count: channels,
    }
}
fn region(channel: u8, start: f64, end: f64, low: f64, high: f64) -> Region {
    Region {
        media_id: "media".into(),
        channel_index: channel,
        start_seconds: start,
        end_seconds: end,
        low_hz: low,
        high_hz: high,
    }
}
fn edit(r: Region) -> SpectralEdit {
    SpectralEdit {
        id: "edit".into(),
        region: r,
        enabled: true,
        processing_version: 2,
        operation: annotator_core::model::EditOperation::Mask,
    }
}
fn tone(frames: usize, hz: f64) -> Vec<f32> {
    (0..frames)
        .map(|i| (0.3 * (TAU * hz * i as f64 / 48000.).sin()) as f32)
        .collect()
}
fn render(
    input: &[f32],
    channels: usize,
    mode: PlaybackMode,
    edits: &[SpectralEdit],
    block: usize,
) -> Vec<f32> {
    let mut dsp = DspProcessor::new(
        info(input.len() / channels, channels),
        DSP_VERSION,
        mode,
        edits,
    )
    .unwrap();
    let mut result = Vec::new();
    let mut position = 0;
    while position < dsp.frame_count() {
        let count = block.min((dsp.frame_count() - position) as usize);
        result.extend(
            dsp.read_frames(position, count, |start, n| {
                Ok(input[start as usize * channels..(start as usize + n) * channels].to_vec())
            })
            .unwrap(),
        );
        position += count as u64;
    }
    result
}
fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}
fn amplitude(x: &[f32], hz: f64, rate: f64) -> f64 {
    let (a, b) = x.iter().enumerate().fold((0., 0.), |(a, b), (i, x)| {
        let p = TAU * hz * i as f64 / rate;
        (a + *x as f64 * p.cos(), b + *x as f64 * p.sin())
    });
    2. * a.hypot(b) / x.len() as f64
}

#[test]
fn identity_exact_length_short_boundaries_dc_nyquist_and_no_mutation() {
    for len in [1, 2, 31, 511, 512, 2047, 2048, 2049, 12013] {
        let input: Vec<_> = (0..len)
            .map(|i| 0.1 + if i % 2 == 0 { 0.2 } else { -0.2 } + (i as f32 * 0.13).sin() * 0.1)
            .collect();
        let before = input.clone();
        let out = render(&input, 1, PlaybackMode::Processed, &[], 997);
        assert_eq!(out.len(), input.len());
        let error: Vec<_> = out.iter().zip(&input).map(|(a, b)| a - b).collect();
        let relative = rms(&error) / rms(&input);
        println!("identity len={len} relative RMS={relative:e}");
        assert!(relative <= 1e-4);
        assert_eq!(before, input);
    }
}

#[test]
fn dual_tone_mask_selection_and_sources() {
    let x: Vec<_> = tone(48000, 1500.)
        .iter()
        .zip(tone(48000, 6000.))
        .map(|(a, b)| a + b)
        .collect();
    let edits = [edit(region(0, 0., 1., 1000., 2000.))];
    let processed = render(&x, 1, PlaybackMode::Processed, &edits, 4096);
    let mid = &processed[9600..38400];
    let rejection = 20. * (amplitude(mid, 1500., 48000.) / 0.3).log10();
    let pass = 20. * (amplitude(mid, 6000., 48000.) / 0.3).log10();
    println!("mask rejection={rejection:.3}dB pass={pass:.6}dB");
    assert!(rejection <= -30. && pass.abs() <= 1.);
    assert_eq!(render(&x, 1, PlaybackMode::Original, &edits, 3001), x);
    let selection = region(0, 0.1, 0.9, 1000., 2000.);
    let original = render(
        &x,
        1,
        PlaybackMode::Selection {
            region: selection.clone(),
            source: SelectionSource::Original,
        },
        &edits,
        777,
    );
    let masked = render(
        &x,
        1,
        PlaybackMode::Selection {
            region: selection,
            source: SelectionSource::Processed,
        },
        &edits,
        777,
    );
    assert_eq!(original.len(), 38400);
    let selected = &original[4800..33600];
    let reject = 20. * (amplitude(selected, 6000., 48000.) / 0.3).log10();
    let pass = 20. * (amplitude(selected, 1500., 48000.) / 0.3).log10();
    println!("selection rejection={reject:.3}dB pass={pass:.6}dB");
    assert!(reject <= -30. && pass.abs() <= 1.);
    assert!(rms(&masked[4800..33600]) / rms(selected) < 0.032);
    assert_eq!(original[0], 0.);
}

#[test]
fn overlap_is_max_union_and_channels_are_isolated() {
    let x: Vec<_> = tone(16001, 1500.).iter().flat_map(|v| [*v, *v]).collect();
    let e = edit(region(0, 0.02, 0.31, 1490., 1700.));
    let single = render(
        &x,
        2,
        PlaybackMode::Processed,
        std::slice::from_ref(&e),
        1003,
    );
    let double = render(&x, 2, PlaybackMode::Processed, &[e.clone(), e], 1003);
    assert_eq!(single, double);
    let right: Vec<_> = single.chunks_exact(2).map(|f| f[1]).collect();
    let expected = tone(16001, 1500.);
    assert!(
        rms(&right
            .iter()
            .zip(expected)
            .map(|(a, b)| a - b)
            .collect::<Vec<_>>())
            < 1e-6
    );
    let selected = render(
        &x,
        2,
        PlaybackMode::Selection {
            region: region(1, 0., 0.3, 0., 24000.),
            source: SelectionSource::Original,
        },
        &[],
        4096,
    );
    assert_eq!(selected.len(), 14400);
}

#[test]
fn arbitrary_blocks_and_seeks_have_global_stft_phase_and_bounded_reads() {
    let x = tone(19001, 2137.);
    let edits = [edit(region(0, 0.01, 0.35, 1900., 2200.))];
    let a = render(&x, 1, PlaybackMode::Processed, &edits, 4096);
    let b = render(&x, 1, PlaybackMode::Processed, &edits, 73);
    assert_eq!(a, b);
    let mut dsp = DspProcessor::new(
        info(x.len(), 1),
        DSP_VERSION,
        PlaybackMode::Processed,
        &edits,
    )
    .unwrap();
    let mut reads = 0;
    let got = dsp
        .read_frames(9517, 121, |start, n| {
            reads += 1;
            assert!(n <= 2048);
            Ok(x[start as usize..start as usize + n].to_vec())
        })
        .unwrap();
    assert_eq!(got, a[9517..9638]);
    assert!(reads < 10);
    assert!(dsp
        .read_frames(0, MAX_BLOCK_FRAMES + 1, |_, _| panic!())
        .is_err());
}

#[test]
fn invalid_versions_ranges_nonfinite_and_empty_are_explicit() {
    assert!(
        matches!(DspProcessor::new(info(100,1),1,PlaybackMode::Original,&[]),Err(e) if e.code==ErrorCode::UnsupportedVersion)
    );
    assert!(DspProcessor::new(info(0, 1), DSP_VERSION, PlaybackMode::Original, &[]).is_err());
    let mut bad = edit(region(0, 0., 0.001, 0., 2000.));
    bad.processing_version = 99;
    assert!(
        matches!(DspProcessor::new(info(100,1),DSP_VERSION,PlaybackMode::Processed,&[bad]),Err(e) if e.code==ErrorCode::UnsupportedVersion)
    );
    for r in [
        region(0, 0., 1., 0., 24001.),
        region(0, f64::NAN, 1., 0., 1000.),
        region(1, 0., 1., 0., 1000.),
    ] {
        assert!(DspProcessor::new(
            info(48000, 1),
            DSP_VERSION,
            PlaybackMode::Selection {
                region: r,
                source: SelectionSource::Original
            },
            &[]
        )
        .is_err());
    }
    let mut dsp =
        DspProcessor::new(info(100, 1), DSP_VERSION, PlaybackMode::Processed, &[]).unwrap();
    assert!(dsp
        .read_frames(0, 100, |_, n| Ok(vec![f32::NAN; n]))
        .is_err());
    assert!(dsp.read_frames(99, 2, |_, _| panic!()).is_err());
}

#[test]
fn mixing_solo_then_mute_layouts_and_output_safety() {
    use annotator_core::{audio::mixer::mix_stereo, model::PlaybackMix};
    let all = PlaybackMix::default();
    assert_eq!(
        mix_stereo(&[0.25, -0.5], 1, &all, 1.).unwrap(),
        vec![0.25, 0.25, -0.5, -0.5]
    );
    assert_eq!(
        mix_stereo(&[0.25, -0.5], 2, &all, 1.).unwrap(),
        vec![0.25, -0.5]
    );
    for channel in [0, 1] {
        let m = PlaybackMix {
            solo_channels: vec![channel],
            muted_channels: vec![],
        };
        let value = if channel == 0 { 0.25 } else { -0.5 };
        assert_eq!(
            mix_stereo(&[0.25, -0.5], 2, &m, 1.).unwrap(),
            vec![value, value]
        );
    }
    for channels in 3..=6 {
        let x: Vec<_> = (0..channels).map(|i| i as f32 / 10.).collect();
        let got = mix_stereo(&x, channels, &all, 1.).unwrap();
        let expected = x.iter().sum::<f32>() / channels as f32;
        assert!((got[0] - expected).abs() < 1e-6 && got[0] == got[1]);
        let m = PlaybackMix {
            solo_channels: vec![0, 2],
            muted_channels: vec![0],
        };
        assert_eq!(mix_stereo(&x, channels, &m, 1.).unwrap(), vec![0.2, 0.2]);
        let m = PlaybackMix {
            solo_channels: vec![2],
            muted_channels: vec![2],
        };
        assert_eq!(mix_stereo(&x, channels, &m, 1.).unwrap(), vec![0., 0.]);
    }
    let mute_left = PlaybackMix {
        solo_channels: vec![],
        muted_channels: vec![0],
    };
    assert_eq!(
        mix_stereo(&[0.25, -0.5], 2, &mute_left, 1.).unwrap(),
        vec![0., -0.5]
    );
    assert_eq!(mix_stereo(&[2., -2.], 2, &all, 1.).unwrap(), vec![2., -2.]);
    assert!(mix_stereo(&[f32::NAN], 1, &all, 1.).is_err());
    assert!(mix_stereo(&[1.], 2, &all, 1.).is_err());
    assert!(mix_stereo(&[1.], 1, &all, f32::INFINITY).is_err());
    assert!(mix_stereo(
        &[1.],
        1,
        &PlaybackMix {
            solo_channels: vec![1],
            muted_channels: vec![]
        },
        1.
    )
    .is_err());
}

#[test]
fn rubato_block_resampling_duration_frequency_delay_tail_and_partition_invariance() {
    use annotator_core::audio::resample::BlockResampler;
    for (from, to) in [(48000, 44100), (44100, 48000), (48000, 48000)] {
        for frames in [1, 17, 1001, from as usize + 37] {
            let input: Vec<_> = (0..frames)
                .flat_map(|i| {
                    [
                        (0.25 * (TAU * 1000. * i as f64 / from as f64).sin()) as f32,
                        0.,
                    ]
                })
                .collect();
            let run = |block: usize| {
                let mut r = BlockResampler::new(from, to, 2, frames as u64).unwrap();
                let mut out = Vec::new();
                for part in input.chunks(block * 2) {
                    out.extend(r.push(part).unwrap());
                }
                out.extend(r.finish().unwrap());
                assert!(r.finish().is_err());
                assert!(r.push(&[]).is_err());
                out
            };
            let out = run(997);
            let expected = ((frames as u64 * to as u64 + from as u64 / 2) / from as u64) as usize;
            assert_eq!(out.len(), expected * 2);
            assert_eq!(out, run(71));
            assert!(out.iter().all(|v| v.is_finite()));
            assert!(out.chunks_exact(2).all(|p| p[1] == 0.));
            if frames > from as usize {
                let left: Vec<_> = out.chunks_exact(2).map(|p| p[0]).collect();
                let mid = &left[to as usize / 10..to as usize * 9 / 10];
                let db = 20. * (amplitude(mid, 1000., to as f64) / 0.25).log10();
                println!("resample {from}->{to} frames={expected} 1kHz amplitude={db:.6}dB");
                assert!(db.abs() < 0.1);
                let err: Vec<_> = left
                    .iter()
                    .enumerate()
                    .map(|(i, v)| v - (0.25 * (TAU * 1000. * i as f64 / to as f64).sin()) as f32)
                    .collect();
                let error = rms(&err[to as usize / 10..to as usize * 9 / 10]);
                println!("resample timing RMS error={error:e}");
                assert!(error < 1e-4, "delay not trimmed");
            }
        }
    }
    let mut r = BlockResampler::new(48000, 44100, 1, 3).unwrap();
    assert!(r.push(&[f32::NAN]).is_err());
    assert!(r.finish().is_err());
    r.push(&[1., 0., 0.]).unwrap();
    assert!(r.push(&[0.]).is_err());
    assert_eq!(r.finish().unwrap().len(), 3);
    assert!(BlockResampler::new(0, 44100, 1, 100).is_err());
}

#[test]
fn unusual_rate_pairs_are_rejected_before_large_fft_allocation() {
    use annotator_core::audio::resample::BlockResampler;
    assert!(
        matches!(BlockResampler::new(48000,47999,2,48000), Err(e) if e.code==ErrorCode::ResourceLimit)
    );
    assert!(
        matches!(BlockResampler::new(1,384000,2,1), Err(e) if e.code==ErrorCode::ResourceLimit)
    );
}

#[test]
fn raised_cosine_widths_union_disabled_narrow_and_physical_edges() {
    use annotator_core::audio::mask::{frequency_weight, suppression, time_weight};
    let r = region(0, 0.1, 0.9, 1000., 2000.);
    let width = 2. * 48000. / 2048.;
    assert!((frequency_weight(&r, 1000. + width / 2., 48000) - 0.5).abs() < 1e-12);
    assert_eq!(frequency_weight(&r, 1000., 48000), 0.);
    assert!((time_weight(&r, 0.105) - 0.5).abs() < 1e-12);
    assert!((suppression(&[&r, &r], 0.105, 1000. + width / 2., 48000) - 0.25).abs() < 1e-12);
    let narrow = region(0, 0., 0.001, 1000., 1001.);
    assert_eq!(frequency_weight(&narrow, 1000.5, 48000), 1.);
    assert_eq!(time_weight(&narrow, 0.0005), 1.);
    assert!((frequency_weight(&r, 1010., 8000) - 0.5).abs() < 1e-12); // floor width 20Hz
    let full = region(0, 0., 0.05, 0., 24000.);
    assert_eq!(frequency_weight(&full, 0., 48000), 1.);
    assert_eq!(frequency_weight(&full, 24000., 48000), 1.);
    let input = tone(2400, 1500.);
    let mut disabled = edit(full);
    disabled.enabled = false;
    assert_eq!(
        render(&input, 1, PlaybackMode::Processed, &[disabled], 4096),
        render(&input, 1, PlaybackMode::Processed, &[], 4096)
    );
    let selected = render(
        &input,
        1,
        PlaybackMode::Selection {
            region: narrow,
            source: SelectionSource::Original,
        },
        &[],
        13,
    );
    assert_eq!(selected.len(), 48);
    assert!(selected.iter().all(|v| v.is_finite()));
    assert_eq!(
        render(&vec![0.; 2301], 1, PlaybackMode::Processed, &[], 511),
        vec![0.; 2301]
    );
}

#[test]
fn visual_stft_settings_do_not_change_processing() {
    use annotator_core::{
        analysis::stft::Stft,
        model::{AnalysisSettings, WindowFunction},
    };
    let input = tone(10000, 1500.);
    let edits = [edit(region(0, 0., 0.2, 1300., 1600.))];
    let expected = render(&input, 1, PlaybackMode::Processed, &edits, 4096);
    for (size, hop, window) in [
        (256, 64, WindowFunction::Rectangular),
        (4096, 1024, WindowFunction::Blackman),
    ] {
        let settings = AnalysisSettings {
            window,
            window_size: size,
            fft_size: size,
            hop_size: hop,
            mel_bands: 32,
        };
        let mut visual = Stft::new(&settings).unwrap();
        visual.frame(&input[..size as usize]).unwrap();
        assert_eq!(
            render(&input, 1, PlaybackMode::Processed, &edits, 4096),
            expected
        );
    }
}

#[test]
fn ten_minute_six_channel_source_renders_a_seek_without_full_file_reads() {
    let mut source = info(48000 * 600, 6);
    let mut dsp =
        DspProcessor::new(source.clone(), DSP_VERSION, PlaybackMode::Processed, &[]).unwrap();
    let start = source.frame_count - 777;
    let mut total_read = 0;
    let out = dsp
        .read_frames(start, 777, |first, n| {
            assert!(n <= 2048);
            total_read += n;
            Ok((first..first + n as u64)
                .flat_map(|i| {
                    (0..6).map(move |ch| ((i as f64 * 0.07 + ch as f64).sin() * 0.3) as f32)
                })
                .collect())
        })
        .unwrap();
    assert_eq!(out.len(), 777 * 6);
    assert!(total_read < 16384);
    for (i, frame) in out.chunks_exact(6).enumerate() {
        for (ch, v) in frame.iter().enumerate() {
            let expected = (((start + i as u64) as f64 * 0.07 + ch as f64).sin() * 0.3) as f32;
            assert!((v - expected).abs() < 1e-6);
        }
    }
    source.frame_count = 100;
    let mut original = DspProcessor::new(source, DSP_VERSION, PlaybackMode::Original, &[]).unwrap();
    assert!(original.read_frames(0, 1, |_, _| Ok(vec![0.; 5])).is_err());
}

#[test]
fn resampler_drains_nonzero_final_filter_tail_and_keeps_output_finite() {
    use annotator_core::audio::resample::BlockResampler;
    for (from, to) in [(48000, 44100), (44100, 48000)] {
        let mut r = BlockResampler::new(from, to, 1, 5003).unwrap();
        let mut input = vec![0.; 5003];
        input[5002] = 0.5;
        let mut out = Vec::new();
        for chunk in input.chunks(127) {
            out.extend(r.push(chunk).unwrap());
        }
        let tail = r.finish().unwrap();
        assert!(
            tail.iter().any(|v| v.abs() > 0.05),
            "final source impulse was lost"
        );
        out.extend(tail);
        assert_eq!(out.len() as u64, r.output_frame_count());
        let peak = out
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.abs().total_cmp(&b.abs()))
            .unwrap()
            .0;
        let expected = (5002.0 * to as f64 / from as f64).round() as usize;
        assert!(peak.abs_diff(expected) <= 1);
    }
    let mut empty = BlockResampler::new(48000, 44100, 2, 0).unwrap();
    assert!(empty.finish().unwrap().is_empty());
    let mut clipped = BlockResampler::new(48000, 44100, 1, 3000).unwrap();
    let mut output = clipped.push(&vec![f32::MAX; 3000]).unwrap();
    output.extend(clipped.finish().unwrap());
    assert!(output.iter().all(|v| v.is_finite()));
}

#[test]
fn regional_gain_measured_sum_repetition_mask_and_channel_isolation() {
    use annotator_core::model::EditOperation;
    let x = tone(48000, 1500.);
    let gain = |db| {
        let mut e = edit(region(0, 0.0, 1.0, 0.0, 24000.));
        e.operation = EditOperation::Gain { gain_db: db };
        e
    };
    for db in [6.0, -6.0, 0.0] {
        let out = render(&x, 1, PlaybackMode::Processed, &[gain(db)], 777);
        let measured = 20.0 * (rms(&out[9600..38400]) / rms(&x[9600..38400])).log10();
        assert!((measured - db).abs() < 0.001, "{db} -> {measured}");
    }
    let repeated = vec![gain(6.0), gain(6.0)];
    let a = render(&x, 1, PlaybackMode::Processed, &repeated, 4096);
    let b = render(&x, 1, PlaybackMode::Processed, &repeated, 73);
    assert_eq!(a, b);
    assert!((20.0 * (rms(&a[9600..38400]) / rms(&x[9600..38400])).log10() - 12.0).abs() < 0.001);
    let mut dsp = DspProcessor::new(
        info(x.len(), 1),
        DSP_VERSION,
        PlaybackMode::Processed,
        &repeated,
    )
    .unwrap();
    assert_eq!(
        dsp.read_frames(
            19003,
            199,
            |s, n| Ok(x[s as usize..s as usize + n].to_vec())
        )
        .unwrap(),
        a[19003..19202]
    );
    for (edits, expected) in [(vec![gain(24.0); 3], 48.0), (vec![gain(-60.0); 3], -120.0)] {
        let out = render(&x, 1, PlaybackMode::Processed, &edits, 1003);
        let db = 20.0 * (rms(&out[9600..38400]) / rms(&x[9600..38400])).log10();
        assert!((db - expected).abs() < 0.001, "clamp {expected}->{db}");
    }
    let cancel = render(
        &x,
        1,
        PlaybackMode::Processed,
        &[gain(6.0), gain(-6.0)],
        701,
    );
    assert!(
        rms(&cancel
            .iter()
            .zip(&x)
            .map(|(a, b)| a - b)
            .collect::<Vec<_>>())
            < 1e-6
    );
    let mut masked = repeated;
    masked.push(edit(region(0, 0.0, 1.0, 0.0, 24000.)));
    assert!(rms(&render(&x, 1, PlaybackMode::Processed, &masked, 1001)[9600..38400]) < 1e-7);
    let stereo: Vec<_> = x.iter().flat_map(|v| [*v, *v]).collect();
    let out = render(&stereo, 2, PlaybackMode::Processed, &[gain(6.0)], 511);
    assert!(out
        .chunks_exact(2)
        .zip(&x)
        .all(|(f, v)| (f[1] - v).abs() < 1e-6));
}

#[test]
fn regional_plus24_then_monitor_minus24_recovers_clean_interior_before_conversion() {
    use annotator_core::{
        audio::{
            device::output_f32, engine::OutputBuffer, mixer::mix_stereo, resample::BlockResampler,
        },
        model::{EditOperation, PlaybackMix},
    };
    use std::sync::{atomic::AtomicU64, Arc};
    let x = tone(48000, 1500.);
    let mut gain = edit(region(0, 0.0, 1.0, 0.0, 24000.));
    gain.operation = EditOperation::Gain { gain_db: 24.0 };
    let amplified = render(&x, 1, PlaybackMode::Processed, &[gain], 4096);
    let mixed = mix_stereo(&amplified[20000..23000], 1, &PlaybackMix::default(), 1.0).unwrap();
    let mut resampler = BlockResampler::new(48000, 48000, 2, 3000).unwrap();
    let frames = resampler.push(&mixed).unwrap();
    let buffer = OutputBuffer::new(3000, Arc::new(AtomicU64::new(1)), 1, 0);
    buffer.set_monitor_gain_db(-24.0).unwrap();
    for (i, frame) in frames.chunks_exact(2).enumerate() {
        buffer.push([frame[0], frame[1]], i as u64);
    }
    buffer.set_playing(true);
    for expected in &x[20000..23000] {
        let frame = buffer.consume();
        let restored = output_f32(frame[0] * buffer.monitor_scalar());
        assert!((restored - expected).abs() < 1e-6, "{restored}!={expected}");
    }
}
