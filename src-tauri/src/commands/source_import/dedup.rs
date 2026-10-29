//! Occupied import destinations from one validated shared catalog snapshot.
use annotator_core::{
    collaboration::{organization::Folder, CollaborationRepository},
    error::{AppError, Result},
    media::import_source::ImportPathKey,
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

pub(super) struct ActiveImportPaths {
    pub keys: HashSet<ImportPathKey>,
    pub source_paths: Vec<PathBuf>,
}
impl ActiveImportPaths {
    /// `current` is also used for the caller's loaded placement capture; never reload here.
    pub fn read(current: &CollaborationRepository) -> Result<Self> {
        let recycle = current.read_recycle()?;
        let recycled: HashSet<_> = recycle
            .trashed
            .iter()
            .map(|m| m.media_id.as_str())
            .collect();
        let active: HashSet<_> = current
            .manifest()
            .media
            .iter()
            .filter(|m| !recycled.contains(m.id.as_str()))
            .map(|m| m.id.as_str())
            .collect();
        let source_paths = current
            .manifest()
            .media
            .iter()
            .filter(|m| active.contains(m.id.as_str()))
            .map(|m| current.root().join(&m.source_ref))
            .collect();
        let folders: HashMap<_, _> = current
            .organization()
            .folders
            .iter()
            .map(|f| (f.id.as_str(), f))
            .collect();
        let mut paths = HashMap::new();
        let mut keys = HashSet::new();
        for member in &current.organization().media {
            if active.contains(member.media_id.as_str()) {
                let path = folder_path(member.folder_id.as_deref(), &folders, &mut paths)?;
                keys.insert(ImportPathKey::new(&path, &member.original_filename));
            }
        }
        Ok(Self { keys, source_paths })
    }
}
// The validated organization bounds parent chains to 16 components. Cache each
// folder once, including ancestors shared by many media memberships.
fn folder_path<'a>(
    id: Option<&'a str>,
    folders: &HashMap<&'a str, &'a Folder>,
    paths: &mut HashMap<&'a str, Vec<String>>,
) -> Result<Vec<String>> {
    let Some(id) = id else { return Ok(vec![]) };
    if let Some(path) = paths.get(id) {
        return Ok(path.clone());
    }
    let folder = folders
        .get(id)
        .ok_or_else(|| AppError::invalid("Media folder no longer exists"))?;
    let mut path = folder_path(folder.parent_id.as_deref(), folders, paths)?;
    path.push(folder.name.clone());
    paths.insert(id, path.clone());
    Ok(path)
}
