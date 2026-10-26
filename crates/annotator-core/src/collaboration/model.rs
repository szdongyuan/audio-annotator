use crate::model::{Annotation, Category, MediaDescriptor};
use serde::{Deserialize, Serialize};
pub const MANIFEST_KIND: &str = "audio-annotator-collaboration";
pub const LAYER_KIND: &str = "audio-annotator-author-layer";
pub const AUTHOR_KIND: &str = "audio-annotator-author";
pub const CURRENT_COLLABORATION_FORMAT: u32 = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationManifest {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub name: String,
    pub created_at: String,
    pub media: Vec<PublicMedia>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicMedia {
    pub id: String,
    pub display_name: String,
    pub source_ref: String,
    pub sha256: String,
    pub byte_length: u64,
    pub sample_rate: u32,
    pub frame_count: u64,
    pub channel_count: u8,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub channel_layout: Option<Vec<String>>,
}
impl PublicMedia {
    pub fn descriptor(&self) -> MediaDescriptor {
        MediaDescriptor {
            id: self.id.clone(),
            display_name: self.display_name.clone(),
            source_ref: self.source_ref.clone(),
            sha256: self.sha256.clone(),
            byte_length: self.byte_length,
            sample_rate: self.sample_rate,
            frame_count: self.frame_count,
            channel_count: self.channel_count,
            channel_layout: self.channel_layout.clone(),
            note: String::new(),
            channel_notes: vec![String::new(); self.channel_count as usize],
            category_ids: vec![],
            channel_category_ids: vec![vec![]; self.channel_count as usize],
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaLabels {
    pub media_id: String,
    pub note: String,
    pub channel_notes: Vec<String>,
    pub category_ids: Vec<String>,
    pub channel_category_ids: Vec<Vec<String>>,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerPayload {
    pub categories: Vec<Category>,
    pub annotations: Vec<Annotation>,
    pub media_labels: Vec<MediaLabels>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorIdentity {
    pub author_id: String,
    pub display_name: String,
    pub created_at: String,
}
// Public identity metadata; ownership authority is the held writer lease.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorRecord {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub identity: AuthorIdentity,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub revision: u64,
    pub hash: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorLayer {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub author_id: String,
    pub revision: u64,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub parent: Option<Checkpoint>,
    pub payload: LayerPayload,
    pub hash: String,
}
impl AuthorLayer {
    pub fn checkpoint(&self) -> Checkpoint {
        Checkpoint {
            revision: self.revision,
            hash: self.hash.clone(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorSnapshot {
    pub identity: AuthorIdentity,
    pub layer: Option<AuthorLayer>,
    pub error: Option<crate::error::AppError>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationSnapshot {
    pub project_id: String,
    pub authors: Vec<AuthorSnapshot>,
}
