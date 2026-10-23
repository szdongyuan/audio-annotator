use super::{
    mel::MelBank,
    source::AnalysisSource,
    stft::{frame_count, power_db, Stft},
};
use crate::{
    error::{AppError, ErrorCode, Result},
    media::identity::check_cancel,
    model::{validation::validate_analysis, AnalysisSettings, SpectrumKind},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const METADATA_RESERVE: usize = 16 * 1024;
pub const TILE_FRAMES: u32 = 256;
pub fn config_hash(s: &AnalysisSettings) -> String {
    let window = serde_json::to_string(&s.window).unwrap();
    format!(
        "{:x}",
        Sha256::digest(format!(
            "analysis-v1|{}|{}|{}|{}|{}",
            window.trim_matches('"'),
            s.window_size,
            s.hop_size,
            s.fft_size,
            s.mel_bands
        ))
    )
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TileRequest {
    pub analysis_source: AnalysisSource,
    pub processing_version: u32,
    pub edit_signature: String,
    pub request_id: String,
    pub view_id: String,
    pub project_id: String,
    pub media_id: String,
    pub generation: u64,
    pub config_hash: String,
    pub settings: AnalysisSettings,
    pub channel_index: u8,
    pub kind: SpectrumKind,
    /// start_frame is a raw STFT frame index; frame_count is the requested output rows.
    pub start_frame: u64,
    pub frame_count: u32,
    pub time_lod: u8,
    pub frequency_start: u32,
    pub frequency_count: u32,
    pub frequency_lod: u8,
    pub visible: bool,
}
impl TileRequest {
    pub fn validate(&self) -> Result<()> {
        validate_analysis(&self.settings)?;
        if self.processing_version != crate::audio::DSP_VERSION
            || match self.analysis_source {
                AnalysisSource::Original => !self.edit_signature.is_empty(),
                AnalysisSource::Processed => {
                    self.edit_signature.len() != 64
                        || !self
                            .edit_signature
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }
            }
        {
            return Err(AppError::invalid("无效分析源版本或屏蔽签名"));
        }
        if [
            &self.request_id,
            &self.view_id,
            &self.project_id,
            &self.media_id,
        ]
        .iter()
        .any(|s| s.is_empty() || s.len() > 128)
            || self.generation > 9_007_199_254_740_991
            || self.start_frame > 9_007_199_254_740_991
            || self.config_hash != config_hash(&self.settings)
            || self.channel_index >= 6
            || self.time_lod > 16
            || self.frequency_lod > 16
            || !(1..=TILE_FRAMES).contains(&self.frame_count)
        {
            return Err(AppError::invalid("无效 tile 请求或分析配置 hash"));
        }
        let bins = match self.kind {
            SpectrumKind::Stft => self.settings.fft_size / 2 + 1,
            SpectrumKind::Mel => self.settings.mel_bands,
        };
        if self.frequency_count == 0
            || self
                .frequency_start
                .checked_add(self.frequency_count)
                .is_none_or(|end| end > bins)
        {
            return Err(AppError::invalid("频率区间越界"));
        }
        let columns = self.frequency_count.div_ceil(1 << self.frequency_lod);
        if self.frame_count as usize * columns as usize * 4 + METADATA_RESERVE > MAX_RESPONSE_BYTES
        {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "tile 超过 4 MiB，请细分频率范围或提高 LOD",
            ));
        }
        Ok(())
    }
    pub fn cache_key(&self, source_hash: &str, sample_rate: u32, samples: u64) -> String {
        // Request IDs, view generation, priority and renderer styles are deliberately absent.
        let key = serde_json::to_vec(&(
            2,
            source_hash,
            self.analysis_source,
            self.processing_version,
            &self.edit_signature,
            sample_rate,
            samples,
            self.channel_index,
            &self.settings,
            self.kind,
            self.start_frame,
            self.frame_count,
            self.time_lod,
            self.frequency_start,
            self.frequency_count,
            self.frequency_lod,
        ))
        .unwrap();
        format!("{:x}", Sha256::digest(key))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tile {
    pub rows: u32,
    pub columns: u32,
    pub source_frames: u64,
    pub sample_rate: u32,
    pub total_samples: u64,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub frame_step_samples: u64,
    // Geometry is compact: original bins [frequencyStart, start+count), grouped by 2^LOD.
    // STFT bin centers are bin*sampleRate/FFT; cells use midpoint edges clipped to Nyquist.
    // Mel triangles use consecutive points [i,i+1,i+2]; empty bands still have geometry.
    pub mel_points_hz: Vec<f64>,
    #[serde(skip)]
    pub values: Vec<f32>,
}
pub fn compute_tile(
    request: &TileRequest,
    sample_rate: u32,
    samples: u64,
    cancel: &AtomicBool,
    mut read: impl FnMut(u64, usize) -> Result<Vec<f32>>,
    mut progress: impl FnMut(u64, u64),
) -> Result<Tile> {
    request.validate()?;
    check_cancel(cancel)?;
    if sample_rate == 0 || samples == 0 || samples > 9_007_199_254_740_991 {
        return Err(AppError::invalid("无效媒体范围"));
    }
    let total = frame_count(samples, request.settings.hop_size);
    if request.start_frame >= total {
        return Err(AppError::invalid("分析帧范围越界"));
    }
    let stride = 1_u64 << request.time_lod;
    let frames = (total - request.start_frame).min(u64::from(request.frame_count) * stride);
    let rows = frames.div_ceil(stride) as u32;
    let fstride = 1_u32 << request.frequency_lod;
    let columns = request.frequency_count.div_ceil(fstride);
    let mut stft = Stft::new(&request.settings)?;
    let mel = if request.kind == SpectrumKind::Mel {
        Some(MelBank::new(
            sample_rate,
            request.settings.fft_size,
            request.settings.mel_bands,
        )?)
    } else {
        None
    };
    let mut points = Vec::new();
    if let Some(bank) = &mel {
        points.push(bank.boundaries()[0][0]);
        points.extend(bank.boundaries().iter().map(|p| p[1]));
        points.push(bank.boundaries().last().unwrap()[2]);
    }
    let mut values = Vec::with_capacity(rows as usize * columns as usize);
    for row in 0..rows {
        let first = u64::from(row) * stride;
        let count = (frames - first).min(stride);
        let mut sums = vec![0_f64; columns as usize];
        for offset in 0..count {
            check_cancel(cancel)?;
            let start =
                (request.start_frame + first + offset) * u64::from(request.settings.hop_size);
            let n = (samples - start).min(u64::from(request.settings.window_size)) as usize;
            let input = read(start, n)?;
            if input.len() != n {
                return Err(AppError::new(ErrorCode::AnalysisFailed, "PCM 帧数不匹配"));
            }
            let spectrum = stft.frame(&input)?;
            let power = if let Some(bank) = &mel {
                bank.apply(&spectrum.power)?
            } else {
                spectrum.amplitude.iter().map(|a| a * a).collect()
            };
            for col in 0..columns {
                let first_bin = request.frequency_start + col * fstride;
                let last =
                    (first_bin + fstride).min(request.frequency_start + request.frequency_count);
                sums[col as usize] += power[first_bin as usize..last as usize].iter().sum::<f64>()
                    / f64::from(last - first_bin);
            }
            progress(first + offset + 1, frames);
        }
        values.extend(sums.into_iter().map(|sum| power_db(sum / count as f64)));
    }
    check_cancel(cancel)?;
    Ok(Tile {
        rows,
        columns,
        source_frames: frames,
        sample_rate,
        total_samples: samples,
        start_seconds: request.start_frame as f64 * f64::from(request.settings.hop_size)
            / f64::from(sample_rate),
        end_seconds: ((request.start_frame + frames) * u64::from(request.settings.hop_size))
            .min(samples) as f64
            / f64::from(sample_rate),
        frame_step_samples: stride * u64::from(request.settings.hop_size),
        mel_points_hz: points,
        values,
    })
}
fn pack(metadata: Vec<u8>, values: &[f32]) -> Result<Vec<u8>> {
    let offset = (8 + metadata.len()).next_multiple_of(4);
    if metadata.len() > METADATA_RESERVE - 12
        || offset + values.len() * 4 > MAX_RESPONSE_BYTES
        || values.iter().any(|v| !v.is_finite())
    {
        return Err(AppError::new(
            ErrorCode::ResourceLimit,
            "tile 响应超限或包含无效值",
        ));
    }
    let mut bytes = Vec::with_capacity(offset + values.len() * 4);
    bytes.extend(b"AT01");
    bytes.extend((metadata.len() as u32).to_le_bytes());
    bytes.extend(metadata);
    bytes.resize(offset, 0);
    for value in values {
        bytes.extend(value.to_le_bytes());
    }
    Ok(bytes)
}
pub fn encode_tile(request: &TileRequest, tile: &Tile) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Header<'a> {
        protocol: u8,
        request: &'a TileRequest,
        tile: &'a Tile,
        value_count: usize,
        encoding: &'static str,
    }
    pack(
        serde_json::to_vec(&Header {
            protocol: 1,
            request,
            tile,
            value_count: tile.values.len(),
            encoding: "f32le-db-row-major",
        })
        .map_err(|_| AppError::invalid("tile 元数据编码失败"))?,
        &tile.values,
    )
}
pub fn encode_cached(tile: &Tile) -> Result<Vec<u8>> {
    pack(
        serde_json::to_vec(tile).map_err(|_| AppError::invalid("缓存编码失败"))?,
        &tile.values,
    )
}
pub fn decode_cached(bytes: &[u8]) -> Option<Tile> {
    if bytes.len() < 8 || bytes.len() > MAX_RESPONSE_BYTES || &bytes[..4] != b"AT01" {
        return None;
    }
    let size = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
    let end = 8_usize.checked_add(size)?;
    let offset = end.checked_add(3)? / 4 * 4;
    if size > METADATA_RESERVE || offset > bytes.len() {
        return None;
    }
    let mut tile: Tile = serde_json::from_slice(&bytes[8..end]).ok()?;
    if tile.rows == 0
        || tile.rows > 256
        || tile.columns == 0
        || u64::from(tile.rows) * u64::from(tile.columns) * 4 != (bytes.len() - offset) as u64
    {
        return None;
    }
    tile.values = bytes[offset..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    if tile.values.iter().any(|v| !v.is_finite()) {
        return None;
    }
    Some(tile)
}
