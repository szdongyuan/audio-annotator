use annotator_core::{error::ErrorCode, examples::*};
use std::{fs, path::PathBuf};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
struct Fixture {
    root: PathBuf,
    private: PathBuf,
    project: String,
    actor: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("example-test-{}", id()));
        fs::create_dir(&root).unwrap();
        let parent = root;
        let root = parent.join("project");
        fs::create_dir(&root).unwrap();
        let private = parent.join("local");
        fs::create_dir(&private).unwrap();
        Self {
            root,
            private,
            project: id(),
            actor: id(),
        }
    }
    fn repo(&self, actor: Option<String>) -> Repository {
        Repository::new(&self.root, &self.private, &self.project, actor).unwrap()
    }
    fn wave(&self) -> PathBuf {
        let path = self.root.join("original.wav");
        let mut b = Vec::new();
        b.extend(b"RIFF");
        b.extend(44u32.to_le_bytes());
        b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(8000u32.to_le_bytes());
        b.extend(16000u32.to_le_bytes());
        b.extend(2u16.to_le_bytes());
        b.extend(16u16.to_le_bytes());
        b.extend(b"data");
        b.extend(8u32.to_le_bytes());
        b.extend([0u8; 8]);
        fs::write(&path, b).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.root.parent().unwrap());
    }
}
#[test]
fn absent_store_is_empty_without_writing_and_guest_has_no_private_scope() {
    let f = Fixture::new();
    let r = f.repo(None);
    assert!(r.list(Scope::Shared).unwrap().entries.is_empty());
    assert!(!f.root.join("examples").exists());
    assert_eq!(fs::read_dir(&f.private).unwrap().count(), 0);
    assert!(r.list(Scope::Private).is_err());
}
#[test]
fn original_bytes_names_scope_actor_and_restart_are_isolated() {
    let f = Fixture::new();
    let r = f.repo(Some(f.actor.clone()));
    let source = f.wave();
    let a = r.import(Scope::Private, &source, "OK1", 0).unwrap();
    let b = r.import(Scope::Private, &source, "OK1", 1).unwrap();
    assert_ne!(a.sample_id, b.sample_id);
    assert_eq!(
        fs::read(r.resolve(&a).unwrap()).unwrap(),
        fs::read(&source).unwrap()
    );
    let shared = r.copy(&a, Scope::Shared, 0).unwrap();
    fs::remove_file(source).unwrap();
    assert!(r
        .resolve(&shared)
        .unwrap()
        .starts_with(f.root.canonicalize().unwrap().join("examples")));
    assert!(r
        .resolve(&a)
        .unwrap()
        .starts_with(f.private.canonicalize().unwrap()));
    assert_eq!(
        f.repo(Some(f.actor.clone()))
            .list(Scope::Private)
            .unwrap()
            .entries
            .len(),
        2
    );
    assert!(f
        .repo(Some(id()))
        .list(Scope::Private)
        .unwrap()
        .entries
        .is_empty());
    assert_eq!(f.repo(None).list(Scope::Shared).unwrap().entries.len(), 1);
    let other = Repository::new(&f.root, &f.private, &id(), Some(f.actor.clone())).unwrap();
    assert!(other.list(Scope::Private).unwrap().entries.is_empty());
    assert!(other.list(Scope::Shared).is_err());
    r.remove(&a, 2).unwrap();
    assert!(r.resolve(&shared).is_ok());
}
#[test]
fn ownership_conflicts_failed_import_and_changed_bytes_are_rejected() {
    let f = Fixture::new();
    let r = f.repo(Some(f.actor.clone()));
    let source = f.wave();
    let a = r.import(Scope::Shared, &source, "NG", 0).unwrap();
    assert!(f.repo(Some(id())).rename(&a, "bad", 1).is_err());
    assert_eq!(
        r.rename(&a, "renamed", 0).unwrap_err().code,
        ErrorCode::RevisionConflict
    );
    assert!(r.import(Scope::Shared, &source, " ", 1).is_err());
    assert!(r
        .import(Scope::Shared, &source, &"a".repeat(129), 1)
        .is_err());
    assert_eq!(r.list(Scope::Shared).unwrap().entries.len(), 1);
    fs::write(r.resolve(&a).unwrap(), b"changed").unwrap();
    assert_eq!(r.resolve(&a).unwrap_err().code, ErrorCode::IdentityMismatch);
}
#[test]
fn malformed_metadata_and_missing_bytes_are_isolated_errors() {
    let f = Fixture::new();
    let r = f.repo(Some(f.actor.clone()));
    let a = r.import(Scope::Shared, &f.wave(), "NG", 0).unwrap();
    let path = r.resolve(&a).unwrap();
    fs::remove_file(path).unwrap();
    assert!(r.resolve(&a).is_err());
    let manifest = f.root.join("examples").join(&f.actor).join("library.json");
    let old = fs::read(&manifest).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&old).unwrap();
    value["entries"][0]["media"]["sourceRef"] = "../../outside.wav".into();
    fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(r.list(Scope::Shared).is_err());
    assert!(Repository::new(&f.root, &f.private, "../bad", Some(f.actor.clone())).is_err());
}
#[test]
fn failed_decode_and_conflicting_commit_remove_only_new_audio() {
    let f = Fixture::new();
    let r = f.repo(Some(f.actor.clone()));
    let source = f.wave();
    let first = r.import(Scope::Shared, &source, "OK", 0).unwrap();
    let dir = f.root.join("examples").join(&f.actor);
    let before = fs::read_dir(&dir).unwrap().count();
    assert!(r.import(Scope::Shared, &source, "conflict", 0).is_err());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), before);
    let bad = f.root.join("bad.wav");
    fs::write(&bad, b"invalid").unwrap();
    assert!(r.import(Scope::Shared, &bad, "bad", 1).is_err());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), before);
    assert!(r.resolve(&first).is_ok());
}
#[test]
fn missing_manifest_is_an_explicit_library_error() {
    let f = Fixture::new();
    let r = f.repo(Some(f.actor.clone()));
    r.import(Scope::Shared, &f.wave(), "OK", 0).unwrap();
    fs::remove_file(f.root.join("examples").join(&f.actor).join("library.json")).unwrap();
    assert!(r.list(Scope::Shared).is_err());
}
#[test]
fn entry_limit_rejects_import_without_changing_metadata() {
    let f = Fixture::new();
    let r = f.repo(Some(f.actor.clone()));
    r.import(Scope::Shared, &f.wave(), "OK", 0).unwrap();
    let dir = f.root.join("examples").join(&f.actor);
    let manifest = dir.join("library.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    let template = value["entries"][0].clone();
    let items = (0..MAX_ENTRIES)
        .map(|_| {
            let mut item = template.clone();
            let uuid = id();
            item["sampleId"] = uuid.clone().into();
            item["media"]["id"] = uuid.clone().into();
            item["media"]["sourceRef"] = format!("{uuid}.wav").into();
            item
        })
        .collect::<Vec<_>>();
    value["entries"] = items.into();
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&manifest, &bytes).unwrap();
    assert_eq!(
        r.import(Scope::Shared, &f.wave(), "overflow", 1)
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(fs::read(&manifest).unwrap(), bytes);
    assert_eq!(fs::read_dir(dir).unwrap().count(), 3);
}
#[cfg(windows)]
#[test]
fn junctions_are_rejected_before_read_or_copy() {
    let f = Fixture::new();
    let target = f.root.join("target");
    fs::create_dir(&target).unwrap();
    let junction = f.root.join("junction");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(status.status.success());
    assert!(Repository::new(&junction, &f.private, &f.project, Some(f.actor.clone())).is_err());
    let source = f.wave();
    let linked = f.root.join("examples");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&linked)
        .arg(&target)
        .output()
        .unwrap();
    assert!(status.status.success());
    assert!(f
        .repo(Some(f.actor.clone()))
        .import(Scope::Shared, &source, "bad", 0)
        .is_err());
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    fs::remove_dir(junction).unwrap();
    fs::remove_dir(linked).unwrap();
}
#[test]
fn private_root_inside_the_shared_project_is_rejected() {
    let f = Fixture::new();
    let unsafe_local = f.root.join("private");
    fs::create_dir(&unsafe_local).unwrap();
    assert!(Repository::new(&f.root, &unsafe_local, &f.project, Some(f.actor.clone())).is_err());
}
#[test]
fn independent_authors_can_publish_same_name_without_overwriting_each_other() {
    let f = Fixture::new();
    let a = f.repo(Some(f.actor.clone()));
    let b = f.repo(Some(id()));
    let source = f.wave();
    let (one, two) = std::thread::scope(|s| {
        let x = s.spawn(|| a.import(Scope::Shared, &source, "OK1", 0).unwrap());
        let y = s.spawn(|| b.import(Scope::Shared, &source, "OK1", 0).unwrap());
        (x.join().unwrap(), y.join().unwrap())
    });
    assert_ne!(one.sample_id, two.sample_id);
    assert_ne!(one.creator_id, two.creator_id);
    let renamed = a.rename(&one, "NG1", 1).unwrap();
    assert_eq!(renamed.revision, 2);
    assert_eq!(b.rename(&two, "NG2", 1).unwrap().revision, 2);
    let reader = f.repo(None);
    let entries = reader.list(Scope::Shared).unwrap().entries;
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| reader.resolve(e).is_ok()));
    assert!(a.remove(&two, 2).is_err());
}
#[cfg(windows)]
#[test]
fn pcm_cache_junction_is_rejected_without_touching_its_target() {
    let f = Fixture::new();
    let target = f.root.join("shared-pcm-target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), b"untouched").unwrap();
    let junction = f.private.join("example-pcm");
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(status.status.success());
    let result = f
        .repo(Some(f.actor.clone()))
        .import(Scope::Shared, &f.wave(), "OK", 0);
    fs::remove_dir(junction).unwrap();
    assert!(result.is_err(), "decode must reject the cache junction");
    assert_eq!(fs::read(target.join("keep")).unwrap(), b"untouched");
    assert_eq!(fs::read_dir(target).unwrap().count(), 1);
}
