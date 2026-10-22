use super::*;
use crate::error::{AppError, ErrorCode, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewState {
    pub media: BTreeMap<String, MediaView>,
    #[serde(deserialize_with = "super::required_nullable")]
    pub active_media_id: Option<String>,
    #[serde(deserialize_with = "super::required_nullable")]
    pub compare_media_id: Option<String>,
    pub linked_time: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlgorithmVersions {
    pub analysis: u32,
    pub dsp: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocument {
    pub format_version: u32,
    pub project_id: String,
    pub name: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    pub media: Vec<MediaDescriptor>,
    pub categories: Vec<Category>,
    pub annotations: Vec<Annotation>,
    pub edits: Vec<SpectralEdit>,
    pub analysis: BTreeMap<String, AnalysisSettings>,
    pub playback_mix: BTreeMap<String, PlaybackMix>,
    pub view_state: ViewState,
    pub algorithm_versions: AlgorithmVersions,
}
impl ProjectDocument {
    pub fn create(name: String) -> Result<Self> {
        let now = now();
        let doc = Self {
            format_version: 1,
            project_id: uuid::Uuid::new_v4().to_string(),
            name,
            revision: 0,
            created_at: now.clone(),
            updated_at: now,
            media: vec![],
            categories: vec![],
            annotations: vec![],
            edits: vec![],
            analysis: BTreeMap::new(),
            playback_mix: BTreeMap::new(),
            view_state: ViewState::default(),
            algorithm_versions: AlgorithmVersions {
                analysis: 1,
                dsp: 1,
            },
        };
        doc.validate()?;
        Ok(doc)
    }
    pub fn from_json(json: &str) -> Result<Self> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|_| AppError::invalid("Invalid project JSON"))?;
        match value.get("formatVersion").and_then(|v| v.as_u64()) {
            Some(1) => (),
            Some(_) => {
                return Err(AppError::new(
                    ErrorCode::UnsupportedVersion,
                    "Unsupported project format version",
                ))
            }
            None => return Err(AppError::invalid("Missing or invalid formatVersion")),
        }
        let doc: Self = serde_json::from_value(value)
            .map_err(|_| AppError::invalid("Invalid project structure"))?;
        doc.validate()?;
        Ok(doc)
    }
    pub fn validate(&self) -> Result<()> {
        validation::validate_document(self)
    }
}
pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
