use crate::{
    collaboration::{organization::Organization, LayerPayload},
    error::{AppError, Result},
    model::ProjectDocument,
};
use std::collections::HashSet;

/// Only explicit, currently available media can enter a partial export.
pub fn select_document(doc: &ProjectDocument, ids: &[String]) -> Result<ProjectDocument> {
    let selected: HashSet<_> = ids.iter().map(String::as_str).collect();
    if selected.is_empty()
        || selected.len() != ids.len()
        || selected.len() > 10000
        || selected
            .iter()
            .any(|id| !doc.media.iter().any(|m| m.id == *id))
    {
        return Err(AppError::invalid(
            "导出选择为空、重复或包含已移除音频，请重新选择",
        ));
    }
    let mut out = doc.clone();
    out.media.retain(|m| selected.contains(m.id.as_str()));
    out.annotations
        .retain(|a| selected.contains(a.region.media_id.as_str()));
    // Personal playback, analysis, processing and view state are never portable.
    out.edits.clear();
    out.analysis = out
        .media
        .iter()
        .map(|m| (m.id.clone(), Default::default()))
        .collect();
    out.playback_mix = out
        .media
        .iter()
        .map(|m| (m.id.clone(), Default::default()))
        .collect();
    out.view_state = Default::default();
    out.validate()?;
    Ok(out)
}

pub fn select_payload(payload: &LayerPayload, ids: &HashSet<String>) -> LayerPayload {
    let mut out = payload.clone();
    out.annotations.retain(|a| ids.contains(&a.region.media_id));
    out.media_labels.retain(|m| ids.contains(&m.media_id));
    // Keep category definitions so recipients can classify yet-unlabelled audio.
    out
}

/// Retain selected memberships and their ancestors, never unrelated empty folders.
pub fn select_organization(doc: &ProjectDocument, source: &Organization) -> Result<Organization> {
    let mut out = super::capture_organization(doc, source)?;
    let folders: std::collections::HashMap<_, _> = out
        .folders
        .iter()
        .map(|f| (f.id.clone(), f.parent_id.clone()))
        .collect();
    let mut used = HashSet::new();
    for member in &out.media {
        let mut parent = member.folder_id.clone();
        while let Some(id) = parent {
            if !used.insert(id.clone()) {
                break;
            }
            parent = folders[&id].clone();
        }
    }
    out.folders.retain(|f| used.contains(&f.id));
    out.validate()?;
    Ok(out)
}
