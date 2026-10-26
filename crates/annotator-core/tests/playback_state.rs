use annotator_core::audio::engine::{OutputBuffer, PlaybackState, TransportState};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

fn buffer() -> (Arc<AtomicU64>, OutputBuffer) {
    let epoch = Arc::new(AtomicU64::new(1));
    let out = OutputBuffer::new(8, epoch.clone(), 1, 20);
    (epoch, out)
}
#[test]
fn counted_device_clock_only_advances_on_consumption() {
    let (_, out) = buffer();
    out.push([0.5, -0.5], 21);
    out.push([0.2, -0.2], 22);
    assert_eq!(out.position(), 20);
    out.set_playing(true);
    assert_eq!(out.consume(), [0.5, -0.5]);
    assert_eq!(out.position(), 21);
    assert_eq!(out.consumed(), 1);
}
#[test]
fn pause_retains_buffer_and_clock() {
    let (_, out) = buffer();
    out.push([1.0, 1.0], 21);
    assert_eq!(out.consume(), [0.0; 2]);
    assert_eq!(out.position(), 20);
    out.set_playing(true);
    assert_eq!(out.consume(), [1.0; 2]);
    out.set_playing(false);
    out.consume();
    assert_eq!(out.consumed(), 1);
}
#[test]
fn obsolete_generation_never_outputs_queued_audio() {
    let (epoch, out) = buffer();
    out.push([1.0; 2], 21);
    out.set_playing(true);
    epoch.store(2, Ordering::Release);
    assert_eq!(out.consume(), [0.0; 2]);
    assert_eq!(out.consumed(), 0);
}
#[test]
fn underrun_does_not_advance_source_clock() {
    let (_, out) = buffer();
    out.set_playing(true);
    out.consume();
    out.consume();
    assert_eq!(out.underruns(), 2);
    assert_eq!(out.position(), 20);
    out.finish();
    out.consume();
    assert_eq!(out.underruns(), 2);
    assert!(out.ended());
}
#[test]
fn ring_is_bounded_and_reuses_consumed_slots() {
    let (_, out) = buffer();
    for i in 0..8 {
        assert!(out.push([0.25; 2], i));
    }
    assert!(!out.push([1.0; 2], 99));
    out.set_playing(true);
    out.consume();
    assert!(out.push([0.5; 2], 9));
}
#[test]
fn nonfinite_is_sanitized_and_finite_headroom_preserved() {
    let (_, out) = buffer();
    out.push([f32::NAN, 2.0], 21);
    out.set_playing(true);
    assert_eq!(out.consume(), [0.0, 2.0]);
}
#[test]
fn play_pause_resume_stop_preserves_session_start() {
    let mut s = PlaybackState::new(10, 100, 10);
    s.seek(30);
    s.play();
    s.consumed(50);
    s.pause();
    s.play();
    s.consumed(60);
    s.stop();
    assert_eq!(s.position, 30);
    assert_eq!(s.state, TransportState::Stopped);
}
#[test]
fn seek_clamps_to_exact_selection_bounds() {
    let mut s = PlaybackState::new(10, 100, 10);
    s.seek(0);
    assert_eq!(s.position, 10);
    s.seek(1000);
    assert_eq!(s.position, 100);
}
#[test]
fn natural_end_stays_at_end_and_replay_starts_at_beginning() {
    let mut s = PlaybackState::new(10, 100, 10);
    s.play();
    s.consumed(100);
    s.end();
    assert_eq!(s.position, 100);
    assert_eq!(s.state, TransportState::Ended);
    s.play();
    assert_eq!(s.position, 10);
}
#[test]
fn selection_loop_clock_retains_original_source_coordinates() {
    for _source in ["original", "processed"] {
        let (_, out) = buffer();
        out.push([0.1; 2], 99);
        out.push([0.2; 2], 20);
        out.set_playing(true);
        out.consume();
        assert_eq!(out.position(), 99);
        out.consume();
        assert_eq!(out.position(), 20);
    }
}
#[test]
fn switching_source_cancels_old_buffer_before_new_source_is_ready() {
    let (epoch, out) = buffer();
    out.push([1.0; 2], 25);
    out.set_playing(true);
    epoch.fetch_add(1, Ordering::AcqRel);
    let new = OutputBuffer::new(8, epoch, 2, 400);
    assert_eq!(out.consume(), [0.0; 2]);
    assert_eq!(new.position(), 400);
}
#[test]
fn ring_exhaustion_does_not_mean_device_presentation() {
    let (_, out) = buffer();
    out.push([0.1; 2], 30);
    out.finish();
    assert!(!out.ended());
    out.set_playing(true);
    out.consume();
    assert!(
        !out.ended(),
        "the callback has not submitted or presented its last frame yet"
    );
    assert_eq!(out.position(), 30);
}
#[test]
fn delayed_output_sink_keeps_stream_until_the_nonzero_tail_is_presented() {
    use annotator_core::audio::engine::{OutputTiming, PresentationTracker, SubmittedTail};
    let (_, out) = buffer();
    out.push([0.25, -0.25], 21);
    out.push([0.5, -0.5], 22);
    out.push([0.75, -0.75], 23);
    out.finish();
    out.set_playing(true);
    let mut tracker = PresentationTracker::default();
    let mut live = true;
    let mut scheduled = Vec::<(u64, [f32; 2])>::new();
    let mut presented = Vec::new();
    // This sink's presentation clock is independent of the callback consuming PCM.
    for (now, playback) in [
        (0, 20_000_000),
        (10_000_000, 30_000_000),
        (22_999_999, 42_999_999),
        (23_000_000, 43_000_000),
    ] {
        for (_, sample) in scheduled.extract_if(.., |(deadline, _)| *deadline <= now) {
            presented.push(sample);
        }
        let mut tail = None;
        for frame in 0..8 {
            if let Some(sample) = out.consume_frame() {
                scheduled.push((playback + (frame + 1) * 1_000_000, sample));
                tail = Some(SubmittedTail {
                    frame_end: (frame + 1) as usize,
                    non_silent: sample != [0.0; 2],
                });
            }
        }
        tracker.record(
            &out,
            OutputTiming {
                callback_nanos: now,
                playback_nanos: playback,
            },
            8,
            1000,
            tail,
        );
        if out.ended() {
            assert_eq!(presented.last(), Some(&[0.75, -0.75]));
            live = false;
        }
        assert_eq!(live, now < 23_000_000);
    }
    let proof = out.presentation();
    assert!(proof.drained);
    assert!(proof.tail_non_silent);
    assert_eq!(proof.tail_nanos, Some(23_000_000));
    assert_eq!(proof.ring_exhausted_nanos, Some(0));
    assert_eq!(proof.pending_tail_frames, 0);
    assert_eq!(out.consumed(), 3);
    assert_eq!(out.underruns(), 0);
}
#[test]
fn wasapi_padding_and_retired_frames_bound_the_scheduled_tail() {
    use annotator_core::audio::engine::{OutputTiming, PresentationTracker, SubmittedTail};
    let (_, out) = buffer();
    let mut tracker = PresentationTracker::default();
    // WASAPI's first empty-client callback exposes all eight device-buffer frames.
    tracker.record(
        &out,
        OutputTiming {
            callback_nanos: 0,
            playback_nanos: 8_000_000,
        },
        8,
        1000,
        None,
    );
    out.push([0.5; 2], 21);
    out.push([0.75; 2], 22);
    out.finish();
    out.set_playing(true);
    out.consume();
    out.consume();
    // Later only two frames are writable: six frames remain ahead of this tail.
    // CPAL 0.15.3 predicts playback using writable frames; retain the padding bound too.
    tracker.record(
        &out,
        OutputTiming {
            callback_nanos: 20_000_000,
            playback_nanos: 22_000_000,
        },
        2,
        1000,
        Some(SubmittedTail {
            frame_end: 2,
            non_silent: true,
        }),
    );
    assert_eq!(out.presentation().tail_nanos, Some(28_000_000));
    assert!(!out.ended());
    for (now, pending) in [
        (40_000_000, 6),
        (42_000_000, 4),
        (44_000_000, 2),
        (46_000_000, 0),
    ] {
        tracker.record(
            &out,
            OutputTiming {
                callback_nanos: now,
                playback_nanos: now + 2_000_000,
            },
            2,
            1000,
            None,
        );
        assert_eq!(out.presentation().pending_tail_frames, pending);
        assert_eq!(out.ended(), pending == 0);
    }
}
#[test]
fn callback_timestamp_publication_is_required_even_after_ring_exhaustion() {
    use annotator_core::audio::engine::{OutputTiming, PresentationTracker, SubmittedTail};
    let (_, out) = buffer();
    let mut tracker = PresentationTracker::default();
    out.push([0.5; 2], 21);
    out.finish();
    out.set_playing(true);
    out.consume();
    assert!(!out.ended());
    tracker.record(
        &out,
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
    assert!(!out.ended());
    assert_eq!(out.presentation().scheduled_frames, 1);
    tracker.record(
        &out,
        OutputTiming {
            callback_nanos: 9_000_000,
            playback_nanos: 17_000_000,
        },
        8,
        1000,
        None,
    );
    assert!(out.ended());
}
#[test]
fn resampled_renderer_finishes_at_exact_source_frame_and_seeks_without_old_filter_tail() {
    use annotator_core::{
        audio::{renderer::Renderer, PlaybackMode, SourceInfo},
        model::PlaybackMix,
    };
    let make = |start| {
        Renderer::new(
            SourceInfo {
                media_id: "m".into(),
                sample_rate: 48000,
                frame_count: 10001,
                channel_count: 1,
            },
            PlaybackMode::Original,
            &[],
            annotator_core::audio::renderer::RenderOptions {
                mix: PlaybackMix::default(),
                volume: 1.0,
                device_rate: 44100,
                start,
                looping: false,
            },
        )
        .unwrap()
    };
    for start in [0, 9000] {
        let mut r = make(start);
        let mut positions = Vec::new();
        while let Some(c) = r.next(|_, n| Ok(vec![0.25; n])).unwrap() {
            positions.extend(c.positions);
        }
        assert_eq!(positions.last(), Some(&10001));
    }
}
#[test]
fn real_selection_renderer_loops_both_sources_on_original_channel_and_exact_bounds() {
    use annotator_core::{
        audio::{renderer::Renderer, PlaybackMode, SelectionSource, SourceInfo},
        model::{PlaybackMix, Region, SpectralEdit},
    };
    let region = Region {
        media_id: "m".into(),
        channel_index: 1,
        start_seconds: 0.01,
        end_seconds: 0.03,
        low_hz: 500.0,
        high_hz: 2000.0,
    };
    let edit = SpectralEdit {
        id: "e".into(),
        region: Region {
            start_seconds: 0.0,
            end_seconds: 0.1,
            ..region.clone()
        },
        enabled: true,
        processing_version: 2,
        operation: annotator_core::model::EditOperation::Mask,
    };
    let mut energies = Vec::new();
    for source in [SelectionSource::Original, SelectionSource::Processed] {
        let mut r = Renderer::new(
            SourceInfo {
                media_id: "m".into(),
                sample_rate: 48000,
                frame_count: 4800,
                channel_count: 2,
            },
            PlaybackMode::Selection {
                region: region.clone(),
                source,
            },
            std::slice::from_ref(&edit),
            annotator_core::audio::renderer::RenderOptions {
                mix: PlaybackMix {
                    solo_channels: vec![1],
                    muted_channels: vec![0],
                },
                volume: 1.0,
                device_rate: 48000,
                start: 480,
                looping: true,
            },
        )
        .unwrap();
        let read = |start: u64, n: usize| {
            Ok((start..start + n as u64)
                .flat_map(|i| {
                    [
                        0.0,
                        (std::f64::consts::TAU * 1000.0 * i as f64 / 48000.0).sin() as f32 * 0.3,
                    ]
                })
                .collect())
        };
        let a = r.next(read).unwrap().unwrap();
        let b = r.next(read).unwrap().unwrap();
        assert_eq!(a.samples, b.samples);
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.positions.len(), 960);
        assert_eq!(a.positions.last(), Some(&1440));
        assert!(a.samples.chunks_exact(2).all(|f| f[0] == f[1]));
        energies.push(a.samples.iter().map(|v| v * v).sum::<f32>());
    }
    assert!(energies[0] > 1.0);
    assert!(energies[1] < energies[0] * 0.001);
}
#[test]
fn sub_device_frame_loop_is_rejected_without_infinite_production() {
    use annotator_core::{
        audio::{renderer::Renderer, PlaybackMode, SourceInfo},
        model::PlaybackMix,
    };
    assert!(Renderer::new(
        SourceInfo {
            media_id: "m".into(),
            sample_rate: 48000,
            frame_count: 1,
            channel_count: 1
        },
        PlaybackMode::Original,
        &[],
        annotator_core::audio::renderer::RenderOptions {
            mix: PlaybackMix::default(),
            volume: 1.0,
            device_rate: 8000,
            start: 0,
            looping: true,
        }
    )
    .is_err());
}

#[test]
fn finite_headroom_survives_mixer_resampler_and_ring() {
    use annotator_core::{
        audio::{mixer::mix_stereo, resample::BlockResampler},
        model::PlaybackMix,
    };
    let scalar = 10.0_f32.powf(24.0 / 20.0);
    let mixed = mix_stereo(
        &[0.4 * scalar, -0.2 * scalar],
        2,
        &PlaybackMix::default(),
        1.0,
    )
    .unwrap();
    for rate in [48000, 44100] {
        let mut resampler = BlockResampler::new(48000, rate, 2, 4000).unwrap();
        let mut output = resampler.push(&mixed.repeat(4000)).unwrap();
        output.extend(resampler.finish().unwrap());
        let (_, out) = buffer();
        let middle = &output[2000..2002];
        out.push([middle[0], middle[1]], 21);
        out.set_playing(true);
        let frame = out.consume();
        assert!((frame[0] / scalar - 0.4).abs() < 0.001, "{rate}: {frame:?}");
        assert!((frame[1] / scalar + 0.2).abs() < 0.001);
    }
}
