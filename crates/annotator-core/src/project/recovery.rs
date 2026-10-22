use crate::{
    error::{AppError, Result},
    model::ProjectDocument,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoverySource {
    Recovery,
    Backup,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    pub source: RecoverySource,
    pub document: ProjectDocument,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    pub primary: Option<ProjectDocument>,
    pub primary_error: Option<AppError>,
    pub candidates: Vec<RecoveryCandidate>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format_version: u32,
    project_id: String,
    revision: u64,
    checksum: String,
    payload: String,
}
pub fn encode(document: &ProjectDocument) -> Result<Vec<u8>> {
    let payload = serde_json::to_string(document).map_err(|e| AppError::invalid(e.to_string()))?;
    serde_json::to_vec(&Envelope {
        format_version: 1,
        project_id: document.project_id.clone(),
        revision: document.revision,
        checksum: format!("{:x}", Sha256::digest(payload.as_bytes())),
        payload,
    })
    .map_err(|e| AppError::invalid(e.to_string()))
}
pub fn decode(bytes: &[u8]) -> Result<ProjectDocument> {
    let e: Envelope =
        serde_json::from_slice(bytes).map_err(|_| AppError::invalid("恢复副本格式损坏"))?;
    if e.format_version != 1 || e.checksum != format!("{:x}", Sha256::digest(e.payload.as_bytes()))
    {
        return Err(AppError::invalid("恢复副本校验失败"));
    }
    let doc = ProjectDocument::from_json(&e.payload)?;
    if doc.project_id != e.project_id || doc.revision != e.revision {
        return Err(AppError::invalid("恢复副本身份或版本不一致"));
    }
    Ok(doc)
}
