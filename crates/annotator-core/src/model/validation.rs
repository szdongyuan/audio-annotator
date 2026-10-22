use super::*;
use crate::error::{AppError, ErrorCode, Result};
use std::collections::HashSet;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn require(valid: bool, message: &str) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(AppError::invalid(message))
    }
}
fn id(value: &str) -> Result<()> {
    require(
        uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value && !id.is_nil()),
        "Invalid canonical UUID",
    )
}
fn timestamp(value: &str) -> Result<()> {
    require(
        value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok(),
        "Invalid UTC timestamp",
    )
}
fn dates(created: &str, updated: &str) -> Result<()> {
    timestamp(created)?;
    timestamp(updated)?;
    require(
        chrono::DateTime::parse_from_rfc3339(created).unwrap()
            <= chrono::DateTime::parse_from_rfc3339(updated).unwrap(),
        "Updated time precedes creation",
    )
}
pub fn validate_analysis(settings: &AnalysisSettings) -> Result<()> {
    require(
        (64..=32768).contains(&settings.window_size)
            && (1..=settings.window_size).contains(&settings.hop_size)
            && settings.fft_size >= settings.window_size
            && settings.fft_size <= 65536
            && settings.fft_size.is_power_of_two()
            && (32..=512).contains(&settings.mel_bands),
        "Invalid analysis settings",
    )
}
pub fn validate_region(region: &Region, media: &[MediaDescriptor]) -> Result<()> {
    let source = media
        .iter()
        .find(|m| m.id == region.media_id)
        .ok_or_else(|| AppError::invalid("Region references unknown media"))?;
    require(
        region.channel_index < source.channel_count,
        "Channel is outside media range",
    )?;
    require(
        [
            region.start_seconds,
            region.end_seconds,
            region.low_hz,
            region.high_hz,
        ]
        .iter()
        .all(|n| n.is_finite())
            && 0.0 <= region.start_seconds
            && region.start_seconds < region.end_seconds
            && region.end_seconds <= source.duration()
            && 0.0 <= region.low_hz
            && region.low_hz < region.high_hz
            && region.high_hz <= source.nyquist(),
        "Invalid region bounds",
    )
}
pub fn validate_document(doc: &ProjectDocument) -> Result<()> {
    if doc.format_version != 1
        || doc.algorithm_versions.analysis != 1
        || doc.algorithm_versions.dsp != 1
    {
        return Err(AppError::new(
            ErrorCode::UnsupportedVersion,
            "Unsupported format or algorithm version",
        ));
    }
    id(&doc.project_id)?;
    require(
        !doc.name.trim().is_empty() && doc.revision <= MAX_SAFE_INTEGER,
        "Invalid name or revision",
    )?;
    dates(&doc.created_at, &doc.updated_at)?;
    let mut ids = HashSet::new();
    ids.insert(doc.project_id.as_str());
    for entity_id in doc
        .media
        .iter()
        .map(|m| &m.id)
        .chain(doc.categories.iter().map(|c| &c.id))
        .chain(doc.annotations.iter().map(|a| &a.id))
        .chain(doc.edits.iter().map(|e| &e.id))
    {
        id(entity_id)?;
        require(ids.insert(entity_id.as_str()), "Duplicate entity ID")?;
    }
    for media in &doc.media {
        if !(1..=6).contains(&media.channel_count) {
            return Err(AppError::new(
                ErrorCode::UnsupportedChannels,
                "Expected 1–6 channels",
            ));
        }
        require(
            !media.display_name.trim().is_empty() && !media.source_ref.trim().is_empty(),
            "Missing media name or source reference",
        )?;
        require(
            media.sha256.len() == 64
                && media
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Invalid SHA-256",
        )?;
        require(
            media.sample_rate > 0
                && media.frame_count > 0
                && media.frame_count <= MAX_SAFE_INTEGER
                && media.byte_length > 0
                && media.byte_length <= MAX_SAFE_INTEGER,
            "Invalid media metadata",
        )?;
        require(
            media.channel_notes.len() == media.channel_count as usize
                && media
                    .channel_layout
                    .as_ref()
                    .is_none_or(|l| l.len() == media.channel_count as usize),
            "Channel metadata length mismatch",
        )?;
    }
    let mut names = HashSet::new();
    for category in &doc.categories {
        require(
            !category.name.trim().is_empty() && names.insert(category.name.trim()),
            "Empty or duplicate category name",
        )?;
        require(
            category.color.len() == 7
                && category.color.starts_with('#')
                && category.color[1..].bytes().all(|b| b.is_ascii_hexdigit()),
            "Expected #RRGGBB category color",
        )?;
    }
    for annotation in &doc.annotations {
        validate_region(&annotation.region, &doc.media)?;
        dates(&annotation.created_at, &annotation.updated_at)?;
        require(
            annotation
                .category_id
                .as_ref()
                .is_none_or(|id| doc.categories.iter().any(|c| &c.id == id)),
            "Unknown category reference",
        )?;
    }
    for edit in &doc.edits {
        validate_region(&edit.region, &doc.media)?;
        if edit.processing_version != 1 {
            return Err(AppError::new(
                ErrorCode::UnsupportedVersion,
                "Unsupported edit processing version",
            ));
        }
    }
    for (media_id, settings) in &doc.analysis {
        require(
            doc.media.iter().any(|m| &m.id == media_id),
            "Analysis references unknown media",
        )?;
        validate_analysis(settings)?;
    }
    for (media_id, mix) in &doc.playback_mix {
        let source = doc
            .media
            .iter()
            .find(|m| &m.id == media_id)
            .ok_or_else(|| AppError::invalid("Mix references unknown media"))?;
        for channels in [&mix.solo_channels, &mix.muted_channels] {
            require(
                channels.iter().all(|&c| c < source.channel_count)
                    && channels.iter().collect::<HashSet<_>>().len() == channels.len(),
                "Invalid or duplicate mix channels",
            )?;
        }
    }
    require(
        doc.media
            .iter()
            .all(|m| doc.analysis.contains_key(&m.id) && doc.playback_mix.contains_key(&m.id)),
        "Missing per-media settings",
    )?;
    for selected in [
        &doc.view_state.active_media_id,
        &doc.view_state.compare_media_id,
    ]
    .into_iter()
    .flatten()
    {
        require(
            doc.media.iter().any(|m| &m.id == selected),
            "View references unknown media",
        )?;
    }
    require(
        doc.view_state.compare_media_id.is_none()
            || doc.view_state.active_media_id != doc.view_state.compare_media_id,
        "Cannot compare media with itself",
    )?;
    let max_duration = doc
        .media
        .iter()
        .map(MediaDescriptor::duration)
        .fold(0.0, f64::max);
    for (media_id, view) in &doc.view_state.media {
        let source = doc
            .media
            .iter()
            .find(|m| &m.id == media_id)
            .ok_or_else(|| AppError::invalid("View references unknown media"))?;
        require(
            view.visible_channels
                .iter()
                .all(|&c| c < source.channel_count)
                && view.visible_channels.iter().collect::<HashSet<_>>().len()
                    == view.visible_channels.len(),
            "Invalid visible channels",
        )?;
        let end_limit = if doc.view_state.linked_time {
            max_duration
        } else {
            source.duration()
        };
        require(
            [
                view.start_seconds,
                view.end_seconds,
                view.low_hz,
                view.high_hz,
                view.frequency_mix,
                view.gain_db,
                view.dynamic_range_db,
            ]
            .iter()
            .all(|n| n.is_finite())
                && 0.0 <= view.start_seconds
                && view.start_seconds < view.end_seconds
                && view.end_seconds <= end_limit
                && 0.0 <= view.low_hz
                && view.low_hz < view.high_hz
                && view.high_hz <= source.nyquist()
                && (0.0..=1.0).contains(&view.frequency_mix)
                && view.dynamic_range_db > 0.0
                && !view.palette.trim().is_empty(),
            "Invalid view bounds or display settings",
        )?;
    }
    Ok(())
}
