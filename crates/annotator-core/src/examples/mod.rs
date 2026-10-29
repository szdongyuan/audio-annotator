use crate::{
    error::{AppError, ErrorCode, Result},
    model::MediaDescriptor,
};
pub use repository::{PreparedImport, Repository, MAX_BATCH, MAX_ENTRIES};
use serde::{Deserialize, Serialize};
mod repository;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Private,
    Shared,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub sample_id: String,
    pub project_id: String,
    pub creator_id: String,
    pub scope: Scope,
    pub name: String,
    pub original_filename: String,
    pub media: MediaDescriptor,
    pub revision: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub entries: Vec<Entry>,
    pub revisions: std::collections::BTreeMap<String, u64>,
}
fn require(ok: bool, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(AppError::invalid(message))
    }
}
fn valid_id(id: &str) -> Result<()> {
    require(
        uuid::Uuid::parse_str(id).is_ok_and(|u| u.to_string() == id),
        "Invalid example UUID",
    )
}
fn valid_name(name: &str) -> Result<()> {
    require(
        !name.trim().is_empty()
            && name.chars().count() <= 128
            && !name.chars().any(char::is_control),
        "示例名称须为 1–128 个字符",
    )
}
fn limit(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::ResourceLimit,
            "Example library limit exceeded",
        ))
    }
}
