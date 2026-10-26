use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Organization {
    pub kind: String,
    pub format_version: u32,
    pub project_id: String,
    pub revision: u64,
    pub layout_revision: u64,
    pub folders: Vec<Folder>,
    pub media: Vec<MediaMembership>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Folder {
    pub id: String,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub parent_id: Option<String>,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaMembership {
    pub media_id: String,
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub folder_id: Option<String>,
    pub original_filename: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum OrganizationOperation {
    CreateFolder {
        id: String,
        #[serde(
            rename = "parentId",
            deserialize_with = "crate::model::required_nullable"
        )]
        parent_id: Option<String>,
        name: String,
    },
    RenameFolder {
        id: String,
        name: String,
    },
    MoveFolder {
        id: String,
        #[serde(
            rename = "parentId",
            deserialize_with = "crate::model::required_nullable"
        )]
        parent_id: Option<String>,
    },
    RemoveFolder {
        id: String,
    },
    MoveMedia {
        #[serde(rename = "mediaId")]
        media_id: String,
        #[serde(
            rename = "folderId",
            deserialize_with = "crate::model::required_nullable"
        )]
        folder_id: Option<String>,
    },
}
/// Native-only validated placement authority, bound to one project and layout capture.
/// Not serializable and has no public field/DTO constructor.
#[derive(Debug)]
pub struct NativePlacementPlan {
    pub(crate) project_id: String,
    pub(crate) layout_revision: u64,
    pub(crate) target_folder_id: Option<String>,
    pub(crate) relative_folder_segments: Vec<String>,
    pub(crate) original_filename: String,
}
/// One bounded immutable native head capture, reusable for an entire preparation batch.
/// It has no serde/DTO constructor and cannot be populated by a renderer descriptor.
#[derive(Debug)]
pub struct NativePlacementCapture {
    pub(super) head: Organization,
    pub(super) target_folder_id: Option<String>,
    pub(super) target_path: Vec<String>,
    pub(super) siblings: std::collections::HashMap<(Option<String>, String), String>,
}
impl Organization {
    pub fn empty(project_id: String) -> Self {
        Self {
            kind: "audio-annotator-organization".into(),
            format_version: 1,
            project_id,
            revision: 0,
            layout_revision: 0,
            folders: vec![],
            media: vec![],
        }
    }
}
