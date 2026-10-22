use crate::{
    error::{AppError, ErrorCode, Result},
    model::*,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Exchange DTO deliberately cannot contain a local source_ref. Notes remain user content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMedia {
    pub id: String,
    pub display_name: String,
    pub sha256: String,
    pub byte_length: u64,
    pub sample_rate: u32,
    pub frame_count: u64,
    pub channel_count: u8,
    pub channel_layout: Option<Vec<String>>,
    pub note: String,
    pub channel_notes: Vec<String>,
    pub media_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u32,
    pub project_id: String,
    pub name: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub media: Vec<PortableMedia>,
    pub categories: Vec<Category>,
    pub annotations: Vec<Annotation>,
    pub edits: Vec<SpectralEdit>,
    pub analysis: BTreeMap<String, AnalysisSettings>,
    pub playback_mix: BTreeMap<String, PlaybackMix>,
    pub view_state: ViewState,
    pub algorithm_versions: AlgorithmVersions,
}
pub fn media_path(id: &str) -> String {
    format!("media/{id}")
}
impl Manifest {
    pub fn capture(doc: &ProjectDocument, bundle: bool) -> Result<Self> {
        doc.validate()?;
        Ok(Self {
            format_version: 1,
            project_id: doc.project_id.clone(),
            name: doc.name.clone(),
            revision: doc.revision,
            created_at: doc.created_at.clone(),
            updated_at: doc.updated_at.clone(),
            media: doc
                .media
                .iter()
                .map(|m| PortableMedia {
                    id: m.id.clone(),
                    display_name: m.display_name.clone(),
                    sha256: m.sha256.clone(),
                    byte_length: m.byte_length,
                    sample_rate: m.sample_rate,
                    frame_count: m.frame_count,
                    channel_count: m.channel_count,
                    channel_layout: m.channel_layout.clone(),
                    note: m.note.clone(),
                    channel_notes: m.channel_notes.clone(),
                    media_path: bundle.then(|| media_path(&m.id)),
                })
                .collect(),
            categories: doc.categories.clone(),
            annotations: doc.annotations.clone(),
            edits: doc.edits.clone(),
            analysis: doc.analysis.clone(),
            playback_mix: doc.playback_mix.clone(),
            view_state: doc.view_state.clone(),
            algorithm_versions: doc.algorithm_versions.clone(),
        })
    }
    pub fn parse(bytes: &[u8], bundle: bool) -> Result<Self> {
        let v: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|_| super::invalid("无效的 UTF-8 JSON 清单"))?;
        match v.get("formatVersion").and_then(|v| v.as_u64()) {
            Some(1) => (),
            Some(_) => {
                return Err(AppError::new(
                    ErrorCode::UnsupportedVersion,
                    "不支持此交换格式版本，请更新程序",
                ))
            }
            None => return Err(super::invalid("缺少格式版本")),
        }
        // Option fields must still be present in the wire format.
        if v.get("media").and_then(|v| v.as_array()).is_none_or(|ms| {
            ms.iter()
                .any(|m| m.get("mediaPath").is_none() || m.get("channelLayout").is_none())
        }) {
            return Err(super::invalid("缺少媒体字段"));
        }
        let m: Self =
            serde_json::from_value(v).map_err(|_| super::invalid("清单结构无效或含未知字段"))?;
        for media in &m.media {
            if media.media_path != bundle.then(|| media_path(&media.id)) {
                return Err(super::invalid("媒体路径与包类型或媒体 ID 不一致"));
            }
        }
        m.document(false)?.validate()?;
        Ok(m)
    }
    pub fn document(&self, independent: bool) -> Result<ProjectDocument> {
        let d = ProjectDocument {
            format_version: 1,
            project_id: if independent {
                uuid::Uuid::new_v4().to_string()
            } else {
                self.project_id.clone()
            },
            name: self.name.clone(),
            revision: self.revision,
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            media: self
                .media
                .iter()
                .map(|m| MediaDescriptor {
                    id: m.id.clone(),
                    display_name: m.display_name.clone(),
                    source_ref: media_path(&m.id),
                    sha256: m.sha256.clone(),
                    byte_length: m.byte_length,
                    sample_rate: m.sample_rate,
                    frame_count: m.frame_count,
                    channel_count: m.channel_count,
                    channel_layout: m.channel_layout.clone(),
                    note: m.note.clone(),
                    channel_notes: m.channel_notes.clone(),
                })
                .collect(),
            categories: self.categories.clone(),
            annotations: self.annotations.clone(),
            edits: self.edits.clone(),
            analysis: self.analysis.clone(),
            playback_mix: self.playback_mix.clone(),
            view_state: self.view_state.clone(),
            algorithm_versions: self.algorithm_versions.clone(),
        };
        d.validate()?;
        Ok(d)
    }
}
