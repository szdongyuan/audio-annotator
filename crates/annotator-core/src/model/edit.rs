use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpectralEdit {
    pub id: String,
    pub region: Region,
    pub enabled: bool,
    pub processing_version: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Change {
    ImportMedia {
        media: MediaDescriptor,
    },
    RelinkMedia {
        media: MediaDescriptor,
    },
    RemoveMedia {
        media_id: String,
    },
    UpdateMediaNote {
        media_id: String,
        note: String,
        #[serde(deserialize_with = "super::required_nullable")]
        merge_key: Option<String>,
    },
    UpdateChannelNote {
        media_id: String,
        channel_index: u8,
        note: String,
        #[serde(deserialize_with = "super::required_nullable")]
        merge_key: Option<String>,
    },
    UpdateAnnotationNote {
        id: String,
        note: String,
        #[serde(deserialize_with = "super::required_nullable")]
        merge_key: Option<String>,
    },
    AddCategory {
        category: Category,
    },
    UpdateCategory {
        category: Category,
    },
    RemoveCategory {
        id: String,
    },
    AddAnnotation {
        annotation: Annotation,
    },
    UpdateAnnotation {
        annotation: Annotation,
    },
    RemoveAnnotation {
        id: String,
    },
    AddEdit {
        edit: SpectralEdit,
    },
    UpdateEdit {
        edit: SpectralEdit,
    },
    RemoveEdit {
        id: String,
    },
    SetEditEnabled {
        id: String,
        enabled: bool,
    },
    UpdateAnalysis {
        media_id: String,
        settings: AnalysisSettings,
    },
    UpdatePlaybackMix {
        media_id: String,
        mix: PlaybackMix,
    },
    UpdateViewState {
        view_state: ViewState,
    },
}
impl Change {
    pub fn records_history(&self) -> bool {
        !matches!(
            self,
            Self::UpdateViewState { .. } | Self::UpdatePlaybackMix { .. }
        )
    }
    pub fn merge_identity(&self) -> Option<(String, String)> {
        match self {
            Self::UpdateMediaNote {
                media_id,
                merge_key: Some(key),
                ..
            } => Some((format!("media:{media_id}"), key.clone())),
            Self::UpdateChannelNote {
                media_id,
                channel_index,
                merge_key: Some(key),
                ..
            } => Some((format!("channel:{media_id}:{channel_index}"), key.clone())),
            Self::UpdateAnnotationNote {
                id,
                merge_key: Some(key),
                ..
            } => Some((format!("annotation:{id}"), key.clone())),
            _ => None,
        }
    }
}
