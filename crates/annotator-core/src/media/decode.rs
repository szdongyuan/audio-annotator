use super::{
    identity::{check_cancel, fingerprint, SourceStamp},
    pcm_cache::PcmFile,
};
use crate::{
    error::{AppError, ErrorCode, Result},
    model::MediaDescriptor,
};
use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{
        DecoderOptions, CODEC_TYPE_FLAC, CODEC_TYPE_MP3, CODEC_TYPE_PCM_F32LE,
        CODEC_TYPE_PCM_S16LE, CODEC_TYPE_PCM_S24LE, CODEC_TYPE_PCM_S32LE,
    },
    errors::Error,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};

pub struct DecodedMedia {
    pub descriptor: MediaDescriptor,
    /// Actual resolved source; the document may intentionally retain a relative sourceRef.
    pub source_path: PathBuf,
    pub pcm: Arc<PcmFile>,
    pub stamp: SourceStamp,
}
impl DecodedMedia {
    pub fn verify_source(&self) -> Result<()> {
        self.stamp.verify(&self.source_path)
    }
}
/// Lazy reopening verifies the original bytes and metadata without editing the document.
pub fn rehydrate(
    expected: &MediaDescriptor,
    project_root: &Path,
    cache_root: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(&str, u64),
) -> Result<DecodedMedia> {
    let source = Path::new(&expected.source_ref);
    let resolved = if source.is_absolute() {
        source.to_path_buf()
    } else {
        project_root.join(source)
    };
    let mut decoded = decode(&resolved, cache_root, cancel, progress)?;
    if !super::registry::same_identity(expected, &decoded.descriptor) {
        return Err(AppError::new(
            ErrorCode::IdentityMismatch,
            "原文件指纹或音频元数据已改变，请重新关联",
        ));
    }
    decoded.descriptor = expected.clone();
    Ok(decoded)
}
struct PendingFile {
    path: PathBuf,
    published: bool,
}
impl Drop for PendingFile {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
fn failure(error: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::DecodeFailed, format!("音频解码失败：{error}"))
}
fn symphonia_error(error: Error) -> AppError {
    match error {
        Error::Unsupported(message) => AppError::new(ErrorCode::UnsupportedFormat, message),
        other => failure(other),
    }
}

pub fn check_pcm_space(frames: Option<u64>, channels: usize, available: u64) -> Result<()> {
    if let Some(frames) = frames {
        let bytes = frames
            .checked_mul(channels as u64)
            .and_then(|n| n.checked_mul(4))
            .ok_or_else(|| AppError::new(ErrorCode::ResourceLimit, "PCM 文件尺寸溢出"))?;
        if bytes > available {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "解码缓存所需磁盘空间不足",
            ));
        }
    }
    Ok(())
}

/// Bounded packet decode. No full-file sample allocation and no document lock.
pub fn decode(
    path: &Path,
    cache_root: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64),
) -> Result<DecodedMedia> {
    check_cancel(cancel)?;
    std::fs::create_dir_all(cache_root).map_err(failure)?;
    let path = path
        .canonicalize()
        .map_err(|_| AppError::new(ErrorCode::MissingMedia, "无法找到音频文件"))?;
    let before = SourceStamp::read(&path)?;
    let sha256 = fingerprint(&path, cancel, |bytes| progress("hashing", bytes))?;
    before.verify(&path)?;
    check_cancel(cancel)?;
    let wave_layout = super::wave_layout::inspect(&path, before.bytes, cancel)?;
    let source = MediaSourceStream::new(
        Box::new(File::open(&path).map_err(failure)?),
        Default::default(),
    );
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    // Library gapless mode also trims to bitrate-estimated durations for headerless MP3.
    // Decode all packets and apply only explicit encoder delay/padding ourselves.
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| match e {
            Error::Unsupported(_) => failure("无法识别音频或文件损坏"),
            other => symphonia_error(other),
        })?
        .format;
    let track = format
        .default_track()
        .ok_or_else(|| failure("文件没有音轨"))?;
    let params = track.codec_params.clone();
    let track_id = track.id;
    if ![
        CODEC_TYPE_PCM_S16LE,
        CODEC_TYPE_PCM_S24LE,
        CODEC_TYPE_PCM_S32LE,
        CODEC_TYPE_PCM_F32LE,
        CODEC_TYPE_FLAC,
        CODEC_TYPE_MP3,
    ]
    .contains(&params.codec)
    {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            "仅支持 WAV PCM16/24/32、float32、FLAC 与 MP3",
        ));
    }
    if params.codec == CODEC_TYPE_MP3 {
        super::mp3_framing::validate(&path, before.bytes, cancel)?;
    }
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions { verify: true })
        .map_err(symphonia_error)?;
    if let Some(channels) = params.channels {
        check_pcm_space(
            params.n_frames,
            channels.count(),
            fs2::available_space(cache_root).map_err(failure)?,
        )?;
    }
    let mut pending = PendingFile {
        path: cache_root.join(format!("{}.pcm", uuid::Uuid::new_v4())),
        published: false,
    };
    let mut output = BufWriter::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&pending.path)
            .map_err(failure)?,
    );
    let mut frames = 0_u64;
    let mut raw_frames = 0_u64;
    let mut spec = None;
    let mut leading = if params.codec == CODEC_TYPE_MP3 {
        params.delay.unwrap_or(0) as usize
    } else {
        0
    };
    loop {
        check_cancel(cancel)?;
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(symphonia_error(e)),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder.decode(&packet).map_err(symphonia_error)?;
        let current = *decoded.spec();
        let channels = current.channels.count();
        if wave_layout.as_ref().is_some_and(|wave| {
            usize::from(wave.channel_count) != channels
                || wave
                    .explicit_mask
                    .is_some_and(|mask| mask != current.channels)
        }) {
            return Err(failure("WAV 通道元数据与解码结果不一致"));
        }
        if !(1..=6).contains(&channels) {
            return Err(AppError::new(
                ErrorCode::UnsupportedChannels,
                "仅支持 1–6 个通道",
            ));
        }
        if current.rate == 0 || spec.is_some_and(|s| s != current) {
            return Err(failure("音频采样率或通道布局在文件中改变"));
        }
        spec = Some(current);
        // Decoder packet capacity is bounded for supported codecs; reject abusive headers.
        if decoded.capacity() > 1024 * 1024 {
            return Err(AppError::new(ErrorCode::ResourceLimit, "音频数据块过大"));
        }
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, current);
        buffer.copy_interleaved_ref(decoded);
        let block_frames = buffer.samples().len() / channels;
        raw_frames = raw_frames
            .checked_add(block_frames as u64)
            .ok_or_else(|| failure("帧数溢出"))?;
        let skip = leading.min(block_frames);
        leading -= skip;
        for value in &buffer.samples()[skip * channels..] {
            if !value.is_finite() {
                return Err(failure("包含非有限浮点采样"));
            }
            output.write_all(&value.to_le_bytes()).map_err(failure)?;
        }
        frames = frames
            .checked_add((block_frames - skip) as u64)
            .ok_or_else(|| failure("帧数溢出"))?;
        progress("decoding", frames);
    }
    check_cancel(cancel)?;
    let exact_length =
        params.codec != CODEC_TYPE_MP3 || params.delay.is_some() || params.padding.is_some();
    if exact_length
        && params
            .n_frames
            .is_some_and(|expected| raw_frames != expected)
    {
        return Err(failure("音频帧不完整"));
    }
    if params.codec == CODEC_TYPE_MP3 {
        frames = frames
            .checked_sub(params.padding.unwrap_or(0) as u64)
            .ok_or_else(|| failure("MP3 填充超出采样帧"))?;
    }
    if frames == 0 {
        return Err(failure("音频没有采样帧"));
    }
    if decoder.finalize().verify_ok == Some(false) {
        return Err(failure("音频校验失败"));
    }
    output.flush().map_err(failure)?;
    output
        .get_ref()
        .set_len(frames * spec.unwrap().channels.count() as u64 * 4)
        .map_err(failure)?;
    output.get_ref().sync_all().map_err(failure)?;
    drop(output);
    before.verify(&path)?;
    check_cancel(cancel)?;
    let spec = spec.unwrap();
    let channels = spec.channels.count();
    let descriptor = MediaDescriptor {
        id: uuid::Uuid::new_v4().to_string(),
        display_name: path.file_name().unwrap().to_string_lossy().into_owned(),
        source_ref: path.to_string_lossy().into_owned(),
        sha256,
        byte_length: before.bytes,
        sample_rate: spec.rate,
        frame_count: frames,
        channel_count: channels as u8,
        channel_layout: wave_layout
            .map_or(Some(spec.channels), |wave| wave.explicit_mask)
            .map(|mask| mask.iter().map(|c| format!("{c:?}")).collect()),
        note: String::new(),
        channel_notes: vec![String::new(); channels],
    };
    let pcm_path = pending.path.clone();
    pending.published = true;
    Ok(DecodedMedia {
        descriptor,
        source_path: path,
        pcm: Arc::new(PcmFile::new(pcm_path, frames, channels)),
        stamp: before,
    })
}
