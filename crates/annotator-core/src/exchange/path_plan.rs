//! One deterministic physical path plan, shared by preview, serialization, writer and reader.
use super::{invalid, limits::safe_path};
use crate::{
    collaboration::organization::{MediaMembership, Organization},
    error::{AppError, Result},
    model::ProjectDocument,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Exact source entry binding for independent copies. The returned commit guard
/// orders final target publication against source retirement without app locks.
pub struct SharedSourceAuthority {
    root: std::path::PathBuf,
    entry_hash: String,
}
impl SharedSourceAuthority {
    pub fn capture(repo: &crate::collaboration::CollaborationRepository) -> Self {
        Self {
            root: repo.root().to_path_buf(),
            entry_hash: repo.manifest_identity().into(),
        }
    }
    pub fn lock(&self) -> Result<std::fs::File> {
        use crate::collaboration::atomic;
        use sha2::{Digest, Sha256};
        let guard = atomic::short_lock(&self.root.join("catalog/.commit.lock"))?;
        let bytes = atomic::read(
            &self.root.join("collaboration.json"),
            crate::collaboration::MAX_LAYER_BYTES,
        )?;
        if format!("{:x}", Sha256::digest(&bytes)) != self.entry_hash {
            return Err(AppError::new(
                crate::error::ErrorCode::RevisionConflict,
                "Source retirement authority changed; refresh and retry",
            ));
        }
        Ok(guard)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathChange {
    pub kind: String,
    pub id: String,
    pub original_path: String,
    pub planned_path: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPathPlan {
    pub organization: Organization,
    pub bundle: bool,
    pub preserve_folders: bool,
    pub directories: Vec<String>,
    pub media_paths: BTreeMap<String, String>,
    pub changes: Vec<PathChange>,
}
/// Keep every folder, but only adopted personal media (including hidden media).
pub fn capture_organization(
    doc: &ProjectDocument,
    organization: &Organization,
) -> Result<Organization> {
    doc.validate()?;
    organization.validate()?;
    if serde_json::to_vec(organization)
        .map_err(|_| super::invalid("Cannot encode organization"))?
        .len()
        > crate::collaboration::organization::MAX_ORGANIZATION_BYTES
    {
        return Err(super::limit());
    }
    if doc.project_id != organization.project_id {
        return Err(AppError::invalid("Organization project mismatch"));
    }
    let ids: HashSet<_> = doc.media.iter().map(|m| m.id.as_str()).collect();
    let mut head = organization.clone();
    head.media.retain(|m| ids.contains(m.media_id.as_str()));
    if head.media.len() != ids.len() {
        return Err(AppError::invalid("Organization is missing adopted media"));
    }
    head.validate()?;
    Ok(head)
}
pub fn root_organization(doc: &ProjectDocument) -> Result<Organization> {
    doc.validate()?;
    let mut head = Organization::empty(doc.project_id.clone());
    for media in &doc.media {
        let name = media.display_name.rsplit(['/', '\\']).next().unwrap_or("");
        let mut member = MediaMembership {
            media_id: media.id.clone(),
            folder_id: None,
            original_filename: name.into(),
        };
        let mut probe = Organization::empty(doc.project_id.clone());
        probe.media.push(member.clone());
        if probe.validate().is_err() {
            member.original_filename = media.id.clone();
        }
        head.media.push(member);
    }
    head.validate()?;
    Ok(head)
}
pub(crate) fn reserved(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or("").to_uppercase();
    ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|p| {
            stem.strip_prefix(p).is_some_and(|s| {
                matches!(
                    s,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}
fn sanitized(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut value = value.trim_end_matches(['.', ' ']).to_string();
    if value.is_empty() {
        value = "_".into();
    }
    if reserved(&value) {
        value.insert(0, '_');
    }
    value
}
fn truncate(value: &str, max: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}
fn component(name: &str, id: &str, file: bool, suffix: Option<&str>) -> String {
    let (stem, extension) = if file {
        name.rsplit_once('.')
            .filter(|(s, e)| !s.is_empty() && e.len() <= 16)
            .map(|(s, e)| (s, format!(".{e}")))
            .unwrap_or((name, String::new()))
    } else {
        (name, String::new())
    };
    if suffix.is_none() && name.encode_utf16().count() <= 120 {
        return name.into();
    }
    let suffix = format!("-{id}{}", suffix.unwrap_or(""));
    format!(
        "{}{}{}",
        truncate(
            stem,
            120 - suffix.encode_utf16().count() - extension.encode_utf16().count()
        )
        .trim_end_matches(['.', ' ']),
        suffix,
        extension
    )
}
#[derive(Clone)]
struct Item {
    id: String,
    folder: bool,
    name: String,
}
fn names(items: Vec<Item>) -> HashMap<(bool, String), String> {
    let mut counts = HashMap::new();
    for i in &items {
        *counts.entry(i.name.to_lowercase()).or_insert(0usize) += 1;
    }
    let mut used: HashSet<_> = items
        .iter()
        .filter(|i| counts[&i.name.to_lowercase()] == 1)
        .map(|i| i.name.to_lowercase())
        .collect();
    let mut items = items;
    items.sort_by(|a, b| (a.folder, &a.id).cmp(&(b.folder, &b.id)));
    let mut out = HashMap::new();
    for item in items {
        let mut name = item.name.clone();
        if counts[&name.to_lowercase()] > 1 {
            name = component(&item.name, &item.id, !item.folder, Some(""));
            let mut n = 0;
            while used.contains(&name.to_lowercase()) {
                n += 1;
                name = component(
                    &item.name,
                    &item.id,
                    !item.folder,
                    Some(&format!(
                        "-{}-{n}",
                        if item.folder { "folder" } else { "media" }
                    )),
                );
            }
            used.insert(name.to_lowercase());
        }
        out.insert((item.folder, item.id), name);
    }
    out
}
impl ExportPathPlan {
    pub fn build(
        doc: &ProjectDocument,
        organization: &Organization,
        bundle: bool,
        preserve_folders: bool,
    ) -> Result<Self> {
        let organization = capture_organization(doc, organization)?;
        let mut plan = Self {
            organization,
            bundle,
            preserve_folders,
            directories: vec![],
            media_paths: BTreeMap::new(),
            changes: vec![],
        };
        if !bundle {
            return Ok(plan);
        }
        let mut groups: HashMap<Option<String>, Vec<Item>> = HashMap::new();
        if preserve_folders {
            for f in &plan.organization.folders {
                groups.entry(f.parent_id.clone()).or_default().push(Item {
                    id: f.id.clone(),
                    folder: true,
                    name: component(&sanitized(&f.name), &f.id, false, None),
                });
            }
        }
        for m in &plan.organization.media {
            groups
                .entry(if preserve_folders {
                    m.folder_id.clone()
                } else {
                    None
                })
                .or_default()
                .push(Item {
                    id: m.media_id.clone(),
                    folder: false,
                    name: component(&sanitized(&m.original_filename), &m.media_id, true, None),
                });
        }
        let names: HashMap<_, _> = groups.into_values().flat_map(names).collect();
        let folders: HashMap<_, _> = plan
            .organization
            .folders
            .iter()
            .map(|f| (f.id.as_str(), f))
            .collect();
        let folder_path = |id: Option<&str>, physical: bool| -> String {
            let mut parts = vec![];
            let mut parent = id;
            while let Some(id) = parent {
                let f = folders[id];
                parts.push(if physical {
                    names[&(true, id.to_owned())].clone()
                } else {
                    f.name.clone()
                });
                parent = f.parent_id.as_deref();
            }
            parts.reverse();
            parts.join("/")
        };
        plan.directories.push("audio/".into());
        if preserve_folders {
            for f in &plan.organization.folders {
                let planned = format!("audio/{}/", folder_path(Some(&f.id), true));
                let original = format!("audio/{}/", folder_path(Some(&f.id), false));
                if planned != original {
                    plan.changes.push(PathChange {
                        kind: "folder".into(),
                        id: f.id.clone(),
                        original_path: original,
                        planned_path: planned.clone(),
                    });
                }
                plan.directories.push(planned);
            }
        }
        for m in &plan.organization.media {
            let parent = if preserve_folders {
                folder_path(m.folder_id.as_deref(), true)
            } else {
                String::new()
            };
            let path = format!(
                "audio/{}{}{}",
                parent,
                if parent.is_empty() { "" } else { "/" },
                names[&(false, m.media_id.clone())]
            );
            let original_parent = folder_path(m.folder_id.as_deref(), false);
            let original = format!(
                "audio/{}{}{}",
                original_parent,
                if original_parent.is_empty() { "" } else { "/" },
                m.original_filename
            );
            if path != original {
                plan.changes.push(PathChange {
                    kind: "media".into(),
                    id: m.media_id.clone(),
                    original_path: original,
                    planned_path: path.clone(),
                });
            }
            plan.media_paths.insert(m.media_id.clone(), path);
        }
        plan.directories.sort_by(|a, b| {
            a.matches('/')
                .count()
                .cmp(&b.matches('/').count())
                .then(a.cmp(b))
        });
        plan.changes
            .sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
        for path in plan.directories.iter().chain(plan.media_paths.values()) {
            if safe_path(path).is_err() {
                return Err(AppError::invalid(format!(
                    "导出路径过长或不安全：{path}；请缩短目录名或选择平铺导出"
                )));
            }
        }
        if plan.directories.len() + plan.media_paths.len() + 1 > 20002 {
            return Err(super::limit());
        }
        Ok(plan)
    }
    pub fn validate_document(&self, doc: &ProjectDocument) -> Result<()> {
        if Self::build(doc, &self.organization, self.bundle, self.preserve_folders)? != *self {
            return Err(invalid("Export path plan does not match captured document"));
        }
        Ok(())
    }
}
