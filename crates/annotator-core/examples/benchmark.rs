//! Reproducible backend throughput; UI latency is measured separately by npm run perf.
use annotator_core::{
    analysis::tiles::{compute_tile, config_hash, TileRequest},
    audio::{
        renderer::{RenderOptions, Renderer},
        PlaybackMode, SourceInfo,
    },
    media::{decode::decode, pcm_cache::PcmCache},
    model::{AnalysisSettings, PlaybackMix, SpectrumKind},
};
use std::{path::PathBuf, sync::atomic::AtomicBool, time::Instant};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: benchmark <fixture-path>")?,
    );
    let root = std::env::temp_dir().join(format!("annotator-benchmark-{}", uuid::Uuid::new_v4()));
    let cancel = AtomicBool::new(false);
    let start = Instant::now();
    let media = decode(&source, &root, &cancel, |_, _| {})?;
    let decode_ms = start.elapsed().as_secs_f64() * 1000.;
    let m = &media.descriptor;
    let mut analysis = PcmCache::for_analysis();
    let mut playback = PcmCache::for_playback();
    let settings = AnalysisSettings::default();
    let start = Instant::now();
    for channel in 0..m.channel_count {
        let request = TileRequest {
            request_id: format!("b-{channel}"),
            view_id: "benchmark".into(),
            project_id: "benchmark".into(),
            media_id: m.id.clone(),
            generation: 1,
            config_hash: config_hash(&settings),
            settings: settings.clone(),
            channel_index: channel,
            kind: SpectrumKind::Stft,
            start_frame: 0,
            frame_count: 256,
            time_lod: 0,
            frequency_start: 0,
            frequency_count: settings.fft_size / 2 + 1,
            frequency_lod: 0,
            visible: true,
        };
        compute_tile(
            &request,
            m.sample_rate,
            m.frame_count,
            &cancel,
            |s, n| {
                let data = analysis.read_frames(&media.pcm, s, n)?;
                Ok(data
                    .chunks_exact(m.channel_count as usize)
                    .map(|f| f[channel as usize])
                    .collect())
            },
            |_, _| {},
        )?;
    }
    let six_channel_tiles_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut renderer = Renderer::new(
        SourceInfo {
            media_id: m.id.clone(),
            sample_rate: m.sample_rate,
            frame_count: m.frame_count,
            channel_count: m.channel_count as usize,
        },
        PlaybackMode::Processed,
        &[],
        RenderOptions {
            mix: PlaybackMix::default(),
            volume: 1.,
            device_rate: 48000,
            start: 0,
            looping: false,
        },
    )?;
    let start = Instant::now();
    let mut frames = 0;
    while frames < 30 * 48000 {
        match renderer.next(|s, n| playback.read_frames(&media.pcm, s, n))? {
            Some(chunk) => frames += chunk.positions.len(),
            None => break,
        }
    }
    let render_ms = start.elapsed().as_secs_f64() * 1000.;
    // Saturate both retention partitions using the long source; never decode it into RAM.
    for s in (0..m.frame_count).step_by(4096) {
        let n = (m.frame_count - s).min(4096) as usize;
        analysis.read_frames(&media.pcm, s, n)?;
        playback.read_frames(&media.pcm, s, n)?;
    }
    let resident = analysis.resident_bytes() + playback.resident_bytes();
    assert!(resident <= 128 * 1024 * 1024);
    println!(
        "{}",
        serde_json::json!({"fixture":source,"sourceSeconds":m.frame_count as f64/m.sample_rate as f64,"channels":m.channel_count,"sampleRate":m.sample_rate,"decodeMs":decode_ms,"firstTilesMs":six_channel_tiles_ms,"processedFrames":frames,"processedSeconds":frames as f64/48000.,"renderMs":render_ms,"analysisPcmBytes":analysis.resident_bytes(),"playbackPcmBytes":playback.resident_bytes(),"combinedPcmBytes":resident,"pcmBudgetBytes":128*1024*1024,"note":"backend throughput, not native device or UI latency"})
    );
    drop(media);
    std::fs::remove_dir_all(root)?;
    Ok(())
}
