#![allow(dead_code)]
use annotator_core::collaboration::{profiles::*, *};
use annotator_core::error::Result;
use std::{fs, path::Path};
/// Stable test identities shared by isolated subprocesses; production uses random UUID v4.
pub fn profile(name: &str) -> Profile {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut hasher);
    let h = hasher.finish();
    let id = ((u128::from(h) << 64) | u128::from(!h)).to_be_bytes();
    Profile {
        author_id: uuid::Uuid::from_bytes(id).to_string(),
        display_name: name.into(),
        created_at: "2026-10-26T00:00:00Z".into(),
    }
}
pub fn seed(repo: &CollaborationRepository, name: &str, display: &str) -> Result<AuthorIdentity> {
    let mut p = profile(name);
    p.display_name = display.into();
    Ok(repo.adopt(&p)?.identity().clone())
}
pub fn selected(path: &Path) -> Result<Profile> {
    let s = ProfileStore::load_or_create(path)?.snapshot()?;
    Ok(s.profiles
        .into_iter()
        .find(|p| p.author_id == s.last_selected_author_id)
        .unwrap())
}
pub fn write_manifest(root: &Path, manifest: &CollaborationManifest) {
    fs::create_dir_all(root.join("catalog")).unwrap();
    for media in &manifest.media {
        fs::OpenOptions::new()
            .write(true)
            .open(root.join(&media.source_ref))
            .unwrap()
            .set_len(media.byte_length)
            .unwrap();
        let record = serde_json::json!({"kind":"audio-annotator-media-record","formatVersion":1,"projectId":manifest.project_id,"media":media});
        fs::write(
            root.join("catalog").join(format!("{}.json", media.id)),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
    let fixed = serde_json::json!({"kind":MANIFEST_KIND,"formatVersion":CURRENT_COLLABORATION_FORMAT,"projectId":manifest.project_id,"name":manifest.name,"createdAt":manifest.created_at,"catalogVersion":1});
    fs::write(
        root.join("collaboration.json"),
        serde_json::to_vec(&fixed).unwrap(),
    )
    .unwrap();
}
