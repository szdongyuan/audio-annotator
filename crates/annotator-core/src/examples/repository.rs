//! Optional sidecar, independently versioned. Each actor owns one bounded manifest.
use super::*;
use crate::{
    collaboration::atomic,
    media::{decode::decode, identity::fingerprint},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
pub const MAX_ENTRIES: usize = 1000;
pub const MAX_BATCH: usize = 32;
const MAX_MANIFEST: usize = 4 * 1024 * 1024;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_AUTHORS: usize = 256;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    project_id: String,
    creator_id: String,
    scope: Scope,
    revision: u64,
    entries: Vec<Entry>,
}
#[derive(Clone)]
pub struct Repository {
    shared: PathBuf,
    local: PathBuf,
    project: String,
    actor: Option<String>,
}
pub struct PreparedImport {
    entry: Entry,
    path: PathBuf,
    committed: bool,
    owned: bool,
}
impl PreparedImport {
    pub fn set_original_filename(&mut self, name: &str) {
        self.entry.original_filename = name.into();
    }
}
impl Drop for PreparedImport {
    fn drop(&mut self) {
        if self.owned && !self.committed && atomic::safe_existing(&self.path).is_ok() {
            let _ = fs::remove_file(&self.path);
        }
    }
}
impl Repository {
    pub fn new(shared: &Path, local: &Path, project: &str, actor: Option<String>) -> Result<Self> {
        valid_id(project)?;
        if let Some(actor) = &actor {
            valid_id(actor)?;
        }
        check_root(shared)?;
        check_root(local)?;
        let shared = shared.canonicalize().map_err(io)?;
        let local = local.canonicalize().map_err(io)?;
        require(
            !local.starts_with(&shared),
            "Private example storage must be outside the shared project",
        )?;
        Ok(Self {
            shared,
            local,
            project: project.into(),
            actor,
        })
    }
    fn actor(&self) -> Result<&str> {
        self.actor
            .as_deref()
            .ok_or_else(|| AppError::invalid("请选择身份以使用我的示例或修改示例"))
    }
    fn root(&self, scope: Scope) -> Result<PathBuf> {
        Ok(match scope {
            Scope::Shared => self.shared.join("examples"),
            Scope::Private => {
                self.actor()?;
                self.local.join("example-libraries").join(&self.project)
            }
        })
    }
    fn author_root(&self, scope: Scope, actor: &str) -> Result<PathBuf> {
        valid_id(actor)?;
        Ok(self.root(scope)?.join(actor))
    }
    fn empty(&self, scope: Scope, actor: &str) -> Manifest {
        Manifest {
            format_version: 1,
            project_id: self.project.clone(),
            creator_id: actor.into(),
            scope,
            revision: 0,
            entries: vec![],
        }
    }
    fn load(&self, scope: Scope, actor: &str) -> Result<Manifest> {
        let dir = self.author_root(scope, actor)?;
        let path = dir.join("library.json");
        check_root(&path)?;
        if !path.try_exists().map_err(io)? {
            if dir.try_exists().map_err(io)? {
                for item in fs::read_dir(&dir).map_err(io)? {
                    let item = item.map_err(io)?;
                    atomic::safe_existing(&item.path())?;
                    require(
                        item.file_name() == "writer.lock",
                        "示例库元数据缺失，请恢复或重试",
                    )?;
                }
            }
            return Ok(self.empty(scope, actor));
        }
        let bytes = atomic::read(&path, MAX_MANIFEST)?;
        let m: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| AppError::invalid("示例库记录损坏"))?;
        require(
            m.format_version == 1
                && m.project_id == self.project
                && m.creator_id == actor
                && m.scope == scope,
            "示例库项目或身份不匹配",
        )?;
        limit(m.entries.len() <= MAX_ENTRIES && m.revision <= 9_007_199_254_740_991)?;
        let mut ids = std::collections::HashSet::new();
        for e in &m.entries {
            self.validate(e)?;
            require(
                e.creator_id == actor
                    && e.scope == scope
                    && e.revision == m.revision
                    && ids.insert(&e.sample_id),
                "Invalid example manifest entry",
            )?;
        }
        Ok(m)
    }
    fn validate(&self, e: &Entry) -> Result<()> {
        valid_id(&e.sample_id)?;
        valid_id(&e.creator_id)?;
        require(
            e.project_id == self.project && e.media.id == e.sample_id,
            "Example project or media mismatch",
        )?;
        valid_name(&e.name)?;
        require(
            e.original_filename.len() <= 512
                && !e.original_filename.contains(['/', '\\'])
                && !e.original_filename.chars().any(char::is_control),
            "Invalid example filename",
        )?;
        let extension = extension(Path::new(&e.original_filename))?;
        require(
            e.media.source_ref == format!("{}.{}", e.sample_id, extension),
            "Unsafe example media path",
        )?;
        let mut doc = crate::model::ProjectDocument::create("Example validation".into())?;
        doc.media.push(e.media.clone());
        doc.analysis.insert(e.sample_id.clone(), Default::default());
        doc.playback_mix
            .insert(e.sample_id.clone(), Default::default());
        doc.validate()?;
        limit(e.media.byte_length <= MAX_BYTES)?;
        Ok(())
    }
    pub fn get(&self, scope: Scope, creator: &str, sample: &str) -> Result<Entry> {
        valid_id(sample)?;
        if scope == Scope::Private {
            require(self.actor()? == creator, "Private example actor mismatch")?;
        }
        self.load(scope, creator)?
            .entries
            .into_iter()
            .find(|e| e.sample_id == sample)
            .ok_or_else(|| AppError::new(ErrorCode::MissingMedia, "示例记录不存在"))
    }
    pub fn list(&self, scope: Scope) -> Result<Library> {
        let root = self.root(scope)?;
        check_root(&root)?;
        let mut out = Library {
            entries: vec![],
            revisions: Default::default(),
        };
        if !root.try_exists().map_err(io)? {
            return Ok(out);
        }
        let actors: Vec<String> = match scope {
            Scope::Private => vec![self.actor()?.into()],
            Scope::Shared => {
                let mut actors = vec![];
                for item in fs::read_dir(root).map_err(io)? {
                    let item = item.map_err(io)?;
                    atomic::safe_existing(&item.path())?;
                    let actor = item.file_name().to_string_lossy().into_owned();
                    valid_id(&actor)?;
                    require(
                        item.file_type().map_err(io)?.is_dir(),
                        "Invalid example author directory",
                    )?;
                    actors.push(actor);
                    limit(actors.len() <= MAX_AUTHORS)?;
                }
                actors
            }
        };
        for actor in actors {
            let m = self.load(scope, &actor)?;
            out.revisions.insert(actor, m.revision);
            out.entries.extend(m.entries);
            limit(out.entries.len() <= MAX_ENTRIES * MAX_AUTHORS)?;
        }
        out.entries.sort_by(|a, b| a.sample_id.cmp(&b.sample_id));
        Ok(out)
    }
    pub fn prepare(&self, scope: Scope, source: &Path, name: &str) -> Result<PreparedImport> {
        valid_name(name)?;
        let actor = self.actor()?;
        let ext = extension(source)?;
        atomic::safe_existing(source)?;
        let metadata = fs::metadata(source).map_err(io)?;
        require(metadata.is_file(), "Example source must be a regular file")?;
        limit(metadata.len() <= MAX_BYTES)?;
        let dir = self.author_root(scope, actor)?;
        ensure_tree(&dir)?;
        {
            let _lock = atomic::short_lock(&dir.join("writer.lock"))?;
            let manifest = dir.join("library.json");
            if !manifest.try_exists().map_err(io)? {
                let empty = self.load(scope, actor)?;
                atomic::publish_new(
                    &manifest,
                    &serde_json::to_vec(&empty)
                        .map_err(|_| AppError::invalid("Cannot initialize examples"))?,
                    None,
                    None,
                )?;
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(format!("{id}.{ext}"));
        let mut pending = PreparedImport {
            entry: Entry {
                sample_id: id.clone(),
                project_id: self.project.clone(),
                creator_id: actor.into(),
                scope,
                name: name.into(),
                original_filename: source
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| AppError::invalid("Invalid example filename"))?
                    .into(),
                media: placeholder(),
                revision: 0,
            },
            path: path.clone(),
            committed: false,
            owned: false,
        };
        let mut input = File::open(source).map_err(io)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io)?;
        pending.owned = true;
        let copied = std::io::copy(
            &mut std::io::Read::by_ref(&mut input).take(MAX_BYTES + 1),
            &mut output,
        )
        .map_err(io)?;
        limit(copied <= MAX_BYTES)?;
        output.flush().map_err(io)?;
        output.sync_all().map_err(io)?;
        drop(output);
        atomic::safe_existing(source)?;
        atomic::safe_existing(&path)?;
        let cancel = AtomicBool::new(false);
        let source_hash = fingerprint(source, &cancel, |_| {})?;
        require(
            source_hash == fingerprint(&path, &cancel, |_| {})?,
            "Example source changed during copy",
        )?;
        let cache_root = self.local.join("example-pcm");
        ensure_tree(&cache_root)?;
        let decoded = decode(&path, &cache_root, &cancel, |_, _| {})?;
        let mut media = decoded.descriptor.clone();
        media.id = id;
        media.source_ref = path.file_name().unwrap().to_string_lossy().into_owned();
        media.display_name = name.into();
        pending.entry.media = media;
        self.validate(&pending.entry)?;
        Ok(pending)
    }
    pub fn commit(&self, mut pending: PreparedImport, expected: u64) -> Result<Entry> {
        self.owned(&pending.entry)?;
        let dir = self.author_root(pending.entry.scope, self.actor()?)?;
        require(
            pending.path == dir.join(&pending.entry.media.source_ref),
            "Prepared example root mismatch",
        )?;
        let _lock = atomic::short_lock(&dir.join("writer.lock"))?;
        let mut m = self.load(pending.entry.scope, self.actor()?)?;
        revision(&m, expected)?;
        limit(m.entries.len() < MAX_ENTRIES)?;
        m.entries.push(pending.entry.clone());
        self.save(&dir, &mut m)?;
        pending.committed = true;
        let mut entry = pending.entry.clone();
        entry.revision = m.revision;
        Ok(entry)
    }
    pub fn import(&self, scope: Scope, source: &Path, name: &str, expected: u64) -> Result<Entry> {
        let prepared = self.prepare(scope, source, name)?;
        self.commit(prepared, expected)
    }
    pub fn copy(&self, entry: &Entry, scope: Scope, expected: u64) -> Result<Entry> {
        let source = self.resolve(entry)?;
        let mut pending = self.prepare(scope, &source, &entry.name)?;
        pending.entry.original_filename = entry.original_filename.clone();
        self.commit(pending, expected)
    }
    pub fn resolve(&self, e: &Entry) -> Result<PathBuf> {
        self.validate(e)?;
        if e.scope == Scope::Private {
            require(
                self.actor()? == e.creator_id,
                "Private example actor mismatch",
            )?;
        }
        let m = self.load(e.scope, &e.creator_id)?;
        let stored = m
            .entries
            .iter()
            .find(|x| x.sample_id == e.sample_id)
            .ok_or_else(|| AppError::new(ErrorCode::MissingMedia, "示例记录不存在"))?;
        require(stored.media == e.media, "Example record changed")?;
        let path = self
            .author_root(e.scope, &e.creator_id)?
            .join(&e.media.source_ref);
        atomic::safe_existing(&path)?;
        if fingerprint(&path, &AtomicBool::new(false), |_| {})? != e.media.sha256 {
            return Err(AppError::new(
                ErrorCode::IdentityMismatch,
                "示例音频已改变，请重新导入",
            ));
        }
        Ok(path)
    }
    fn owned(&self, e: &Entry) -> Result<()> {
        self.validate(e)?;
        require(self.actor()? == e.creator_id, "只有创建者可以修改示例")
    }
    pub fn rename(&self, e: &Entry, name: &str, expected: u64) -> Result<Entry> {
        valid_name(name)?;
        self.owned(e)?;
        let dir = self.author_root(e.scope, self.actor()?)?;
        let _lock = atomic::short_lock(&dir.join("writer.lock"))?;
        let mut m = self.load(e.scope, self.actor()?)?;
        revision(&m, expected)?;
        let target = m
            .entries
            .iter_mut()
            .find(|x| x.sample_id == e.sample_id)
            .ok_or_else(|| AppError::invalid("Unknown example"))?;
        target.name = name.into();
        self.save(&dir, &mut m)?;
        Ok(m.entries
            .into_iter()
            .find(|x| x.sample_id == e.sample_id)
            .unwrap())
    }
    pub fn remove(&self, e: &Entry, expected: u64) -> Result<()> {
        self.owned(e)?;
        let dir = self.author_root(e.scope, self.actor()?)?;
        let _lock = atomic::short_lock(&dir.join("writer.lock"))?;
        let mut m = self.load(e.scope, self.actor()?)?;
        revision(&m, expected)?;
        let index = m
            .entries
            .iter()
            .position(|x| x.sample_id == e.sample_id)
            .ok_or_else(|| AppError::invalid("Unknown example"))?;
        let removed = m.entries.remove(index);
        self.save(&dir, &mut m)?;
        let path = dir.join(removed.media.source_ref);
        if atomic::safe_existing(&path).is_ok() {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }
    fn save(&self, dir: &Path, m: &mut Manifest) -> Result<()> {
        limit(m.revision < 9_007_199_254_740_991)?;
        m.revision += 1;
        for e in &mut m.entries {
            e.revision = m.revision;
        }
        let bytes =
            serde_json::to_vec(m).map_err(|_| AppError::invalid("Cannot serialize examples"))?;
        limit(bytes.len() <= MAX_MANIFEST)?;
        let path = dir.join("library.json");
        if path.try_exists().map_err(io)? {
            atomic::replace_metadata(&path, &bytes)
        } else {
            atomic::publish_new(&path, &bytes, None, None)
        }
    }
}
fn revision(m: &Manifest, expected: u64) -> Result<()> {
    if m.revision != expected {
        Err(AppError::new(
            ErrorCode::RevisionConflict,
            "示例库已更新，请刷新后重试",
        ))
    } else {
        Ok(())
    }
}
fn io(e: std::io::Error) -> AppError {
    let mut e = AppError::new(ErrorCode::SaveFailed, format!("示例文件操作失败：{e}"));
    e.retryable = true;
    e
}
fn extension(path: &Path) -> Result<String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    require(
        matches!(ext.as_str(), "wav" | "flac" | "mp3"),
        "示例仅支持 WAV、FLAC、MP3",
    )?;
    Ok(ext)
}
fn check_root(path: &Path) -> Result<()> {
    require(
        path.is_absolute()
            && !path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir)),
        "Unsafe example root",
    )?;
    let mut existing = path;
    while !existing.try_exists().map_err(io)? {
        existing = existing
            .parent()
            .ok_or_else(|| AppError::invalid("Missing example root"))?;
    }
    atomic::safe_existing(existing)
}
fn ensure_tree(path: &Path) -> Result<()> {
    check_root(path)?;
    if !path.try_exists().map_err(io)? {
        ensure_tree(
            path.parent()
                .ok_or_else(|| AppError::invalid("Missing example parent"))?,
        )?;
        atomic::ensure_dir(path)?;
    }
    atomic::safe_existing(path)
}
fn placeholder() -> MediaDescriptor {
    MediaDescriptor {
        id: String::new(),
        display_name: String::new(),
        source_ref: String::new(),
        sha256: String::new(),
        byte_length: 0,
        sample_rate: 0,
        frame_count: 0,
        channel_count: 0,
        channel_layout: None,
        note: String::new(),
        channel_notes: vec![],
        category_ids: vec![],
        channel_category_ids: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_never_removes_a_file_it_did_not_create() {
        let root = std::env::temp_dir().join(format!("example-owned-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("existing.wav");
        fs::write(&path, b"existing").unwrap();
        let p = PreparedImport {
            entry: Entry {
                sample_id: String::new(),
                project_id: String::new(),
                creator_id: String::new(),
                scope: Scope::Private,
                name: String::new(),
                original_filename: String::new(),
                media: placeholder(),
                revision: 0,
            },
            path: path.clone(),
            committed: false,
            owned: false,
        };
        drop(p);
        assert_eq!(fs::read(&path).unwrap(), b"existing");
        fs::remove_dir_all(root).unwrap();
    }
}
