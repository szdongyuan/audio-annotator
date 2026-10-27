use super::{
    atomic::{self, PublishFault},
    validation::*,
    *,
};
use crate::{
    error::{AppError, ErrorCode, Result},
    model::validation::MAX_SAFE_INTEGER,
};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub struct CollaborationRepository {
    pub(super) root: PathBuf,
    pub(super) organization: organization::Organization,
    pub(super) manifest: CollaborationManifest,
    pub(super) manifest_hash: String,
    pub(super) catalog_revision: Option<CatalogRevision>,
    // Exact bounded record hashes from this verified snapshot; never an authority cache.
    pub(super) catalog_record_hashes: Vec<(String, String)>,
}
/// Native-only capability: no Deserialize, public constructor, Clone, or caller-selected author path.
pub struct AuthorSession {
    root: PathBuf,
    project_id: String,
    identity: AuthorIdentity,
    _lock: File,
}
impl AuthorSession {
    pub(crate) fn belongs_to(&self, repo: &CollaborationRepository) -> bool {
        self.root == repo.root && self.project_id == repo.manifest.project_id
    }
    pub fn identity(&self) -> &AuthorIdentity {
        &self.identity
    }
}
fn conflict() -> AppError {
    AppError::new(
        ErrorCode::RevisionConflict,
        "Shared author baseline changed",
    )
}
struct ReadBudget {
    remaining: usize,
    exhausted: bool,
}
impl ReadBudget {
    fn new(remaining: usize) -> Self {
        Self {
            remaining,
            exhausted: false,
        }
    }
}
impl CollaborationRepository {
    pub fn open(root: &Path) -> Result<Self> {
        Self::open_catalog_interleaved(root, |_| Ok(()))
    }
    /// Same reader with a deterministic boundary after directory entry enumeration.
    pub fn open_catalog_interleaved(
        root: &Path,
        mut after_entry: impl FnMut(&Path) -> Result<()>,
    ) -> Result<Self> {
        atomic::safe_existing(root)?;
        let root = root.canonicalize().map_err(atomic::io)?;
        let bytes = atomic::read(&root.join("collaboration.json"), MAX_LAYER_BYTES)?;
        let loaded = super::catalog::load(&root, &bytes, &mut after_entry)?;
        let manifest = loaded.manifest;
        for name in ["authors", "annotations", "media"] {
            let path = root.join(name);
            atomic::safe_existing(&path)?;
            require(path.is_dir(), "Missing collaboration directory")?;
        }
        // load() has already validated every referenced source against this head.
        let repo = Self {
            root,
            manifest,
            manifest_hash: hash(&bytes),
            catalog_revision: loaded.revision,
            catalog_record_hashes: loaded.record_hashes,
            organization: loaded.organization,
        };
        repo.authors()?;
        Ok(repo)
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn manifest(&self) -> &CollaborationManifest {
        &self.manifest
    }
    pub(super) fn authority(&self) -> Result<()> {
        let bytes = atomic::read(&self.root.join("collaboration.json"), MAX_LAYER_BYTES)?;
        require(
            hash(&bytes) == self.manifest_hash,
            "Immutable collaboration manifest changed",
        )
    }
    fn author(&self, author_id: &str) -> Result<AuthorRecord> {
        uuid(author_id)?;
        let bytes = atomic::read(
            &self.root.join("authors").join(format!("{author_id}.json")),
            MAX_AUTHOR_BYTES,
        )?;
        let record = AuthorRecord::parse(&bytes, &self.manifest.project_id)?;
        require(
            record.identity.author_id == author_id,
            "Author filename identity mismatch",
        )?;
        Ok(record)
    }
    fn authors(&self) -> Result<Vec<AuthorRecord>> {
        let dir = self.root.join("authors");
        atomic::safe_existing(&dir)?;
        let mut records = Vec::new();
        let mut authors = HashSet::new();
        for (index, entry) in fs::read_dir(&dir).map_err(atomic::io)?.enumerate() {
            limit(index < 256)?;
            let entry = entry.map_err(atomic::io)?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| AppError::invalid("Invalid author filename"))?;
            if name == ".registration.lock" || (name.starts_with('.') && name.ends_with(".tmp")) {
                continue;
            }
            let id = name
                .strip_suffix(".json")
                .ok_or_else(|| AppError::invalid("Unknown author directory entry"))?;
            uuid(id)?;
            limit(records.len() < MAX_AUTHORS)?;
            let record = self.author(id)?;
            require(
                authors.insert(record.identity.author_id.clone()),
                "Duplicate author identity",
            )?;
            records.push(record);
        }
        records.sort_by(|a, b| a.identity.author_id.cmp(&b.identity.author_id));
        Ok(records)
    }
    /// Adopt the global UUID and hold its project-specific single-writer lease.
    pub fn adopt(&self, profile: &profiles::Profile) -> Result<AuthorSession> {
        profile.validate()?;
        self.authority()?;
        let dir = self.author_dir(&profile.author_id)?;
        atomic::ensure_dir(&dir)?;
        let mut lock = atomic::lock(&dir.join(".writer.lock"))?;
        lock.set_len(0).map_err(atomic::io)?;
        lock.write_all(uuid::Uuid::new_v4().to_string().as_bytes())
            .map_err(atomic::io)?;
        lock.sync_all().map_err(atomic::io)?;
        let session = AuthorSession {
            root: self.root.clone(),
            project_id: self.manifest.project_id.clone(),
            identity: profile.clone().into(),
            _lock: lock,
        };
        self.write_author(profile)?;
        self.session_authority(&session)?;
        Ok(session)
    }
    pub fn refresh_author(
        &self,
        session: &AuthorSession,
        profile: &profiles::Profile,
    ) -> Result<()> {
        self.session_authority(session)?;
        require(
            session.identity.author_id == profile.author_id,
            "Author UUID mismatch",
        )?;
        self.write_author(profile)
    }
    fn write_author(&self, profile: &profiles::Profile) -> Result<()> {
        profile.validate()?;
        self.authority()?;
        let _registration = atomic::short_lock(&self.root.join("authors/.registration.lock"))?;
        let existing = self.authors()?;
        let old = existing
            .iter()
            .find(|a| a.identity.author_id == profile.author_id);
        let record = AuthorRecord {
            kind: AUTHOR_KIND.into(),
            format_version: 1,
            project_id: self.manifest.project_id.clone(),
            identity: profile.clone().into(),
        };
        if old == Some(&record) {
            return Ok(());
        }
        limit(old.is_some() || existing.len() < MAX_AUTHORS)?;
        let bytes =
            serde_json::to_vec(&record).map_err(|_| AppError::invalid("Cannot encode author"))?;
        limit(bytes.len() <= MAX_AUTHOR_BYTES)?;
        let target = self
            .root
            .join("authors")
            .join(format!("{}.json", profile.author_id));
        self.authority()?;
        if old.is_none() {
            return atomic::publish_new(&target, &bytes, None, None);
        }
        atomic::replace_metadata(&target, &bytes)
    }
    fn author_dir(&self, author: &str) -> Result<PathBuf> {
        uuid(author)?;
        Ok(self.root.join("annotations").join(author))
    }
    pub(super) fn session_authority(&self, session: &AuthorSession) -> Result<()> {
        require(
            session.root == self.root && session.project_id == self.manifest.project_id,
            "Author capability belongs to another project",
        )?;
        self.authority()?;
        self.author(&session.identity.author_id)?;
        atomic::verify_lock_path(
            &self
                .author_dir(&session.identity.author_id)?
                .join(".writer.lock"),
            &session._lock,
        )
    }
    fn revisions(&self, author: &str) -> Result<Vec<u64>> {
        let dir = self.author_dir(author)?;
        if !dir.try_exists().map_err(atomic::io)? {
            atomic::safe_existing(dir.parent().unwrap())?;
            return Ok(vec![]);
        }
        atomic::safe_existing(&dir)?;
        let mut revisions = Vec::new();
        for (index, entry) in fs::read_dir(dir).map_err(atomic::io)?.enumerate() {
            limit(index < 256)?;
            let entry = entry.map_err(atomic::io)?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| AppError::invalid("Invalid layer filename"))?;
            if name == ".writer.lock" || (name.starts_with('.') && name.ends_with(".tmp")) {
                continue;
            }
            require(
                name.len() == 25
                    && name.ends_with(".json")
                    && name[..20].bytes().all(|b| b.is_ascii_digit()),
                "Invalid published revision filename",
            )?;
            let revision = name[..20]
                .parse::<u64>()
                .map_err(|_| AppError::invalid("Invalid revision number"))?;
            require(
                (1..=MAX_SAFE_INTEGER).contains(&revision),
                "Unsafe revision number",
            )?;
            atomic::safe_existing(&entry.path())?;
            revisions.push(revision);
        }
        revisions.sort_unstable();
        for pair in revisions.windows(2) {
            require(pair[0] + 1 == pair[1], "Missing published author revision")?;
        }
        Ok(revisions)
    }
    fn read_revision(
        &self,
        author: &str,
        revision: u64,
        budget: &mut ReadBudget,
    ) -> Result<AuthorLayer> {
        let path = self
            .author_dir(author)?
            .join(format!("{revision:020}.json"));
        atomic::safe_existing(&path)?;
        let size = fs::metadata(&path).map_err(atomic::io)?.len();
        limit(size <= MAX_LAYER_BYTES as u64)?;
        if size > budget.remaining as u64 {
            budget.exhausted = true;
            limit(false)?;
        }
        let bytes =
            atomic::read(&path, MAX_LAYER_BYTES.min(budget.remaining)).inspect_err(|error| {
                if error.code == ErrorCode::ResourceLimit && budget.remaining < MAX_LAYER_BYTES {
                    budget.exhausted = true;
                }
            })?;
        budget.remaining -= bytes.len();
        let layer = AuthorLayer::parse(&bytes, &self.manifest, author)?;
        require(
            layer.revision == revision,
            "Layer filename revision mismatch",
        )?;
        Ok(layer)
    }
    fn head(&self, author: &str, budget: &mut ReadBudget) -> Result<Option<AuthorLayer>> {
        let revisions = self.revisions(author)?;
        let Some(revision) = revisions.last() else {
            return Ok(None);
        };
        let layer = self.read_revision(author, *revision, budget)?;
        if revisions.len() > 1 {
            let previous = self.read_revision(author, revisions[revisions.len() - 2], budget)?;
            require(
                layer.parent.as_ref() == Some(&previous.checkpoint()),
                "Parent checkpoint mismatch",
            )?;
        }
        Ok(Some(layer))
    }
    pub fn read_author(&self, author: &str) -> Result<Option<AuthorLayer>> {
        self.authority()?;
        require(
            self.authors()?
                .iter()
                .any(|a| a.identity.author_id == author),
            "Unknown author",
        )?;
        let mut budget = ReadBudget::new(MAX_TOTAL_LAYER_BYTES);
        self.head(author, &mut budget)
    }
    pub fn publish(
        &self,
        session: &AuthorSession,
        base: Option<&Checkpoint>,
        payload: &LayerPayload,
    ) -> Result<Checkpoint> {
        self.publish_controlled(session, base, payload, None, None)
    }
    /// Same production path with deterministic interruption/cancellation boundaries for integration tests.
    pub fn publish_controlled(
        &self,
        session: &AuthorSession,
        base: Option<&Checkpoint>,
        payload: &LayerPayload,
        fault: Option<PublishFault>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Checkpoint> {
        self.session_authority(session)?;
        payload.project(&self.manifest)?;
        if let Some(base) = base {
            require(
                base.revision > 0 && base.revision < MAX_SAFE_INTEGER,
                "Unsafe base revision",
            )?;
            digest(&base.hash)?;
        }
        let author = &session.identity.author_id;
        let mut layer = AuthorLayer {
            kind: LAYER_KIND.into(),
            format_version: 2,
            project_id: self.manifest.project_id.clone(),
            author_id: author.clone(),
            revision: base.map_or(1, |b| b.revision + 1),
            parent: base.cloned(),
            payload: payload.clone(),
            hash: String::new(),
        };
        layer.hash = layer.computed_hash()?;
        let mut budget = ReadBudget::new(MAX_TOTAL_LAYER_BYTES);
        let head = self.head(author, &mut budget)?;
        let checkpoint = layer.checkpoint();
        if head.as_ref().map(AuthorLayer::checkpoint) != Some(checkpoint.clone()) {
            if head.as_ref().map(AuthorLayer::checkpoint).as_ref() != base {
                return Err(conflict());
            }
            let bytes =
                serde_json::to_vec(&layer).map_err(|_| AppError::invalid("Cannot encode layer"))?;
            limit(bytes.len() <= MAX_LAYER_BYTES)?;
            self.session_authority(session)?;
            atomic::publish_new(
                &self
                    .author_dir(author)?
                    .join(format!("{:020}.json", layer.revision)),
                &bytes,
                fault,
                cancel,
            )?;
        }
        self.session_authority(session)?;
        let mut budget = ReadBudget::new(MAX_TOTAL_LAYER_BYTES);
        if self
            .head(author, &mut budget)?
            .as_ref()
            .map(AuthorLayer::checkpoint)
            != Some(checkpoint.clone())
        {
            return Err(conflict());
        }
        self.prune(session)?;
        Ok(checkpoint)
    }
    fn prune(&self, session: &AuthorSession) -> Result<()> {
        let author = &session.identity.author_id;
        let revisions = self.revisions(author)?;
        for revision in revisions.iter().take(revisions.len().saturating_sub(16)) {
            self.session_authority(session)?;
            let mut budget = ReadBudget::new(MAX_LAYER_BYTES);
            self.read_revision(author, *revision, &mut budget)?;
            fs::remove_file(
                self.author_dir(author)?
                    .join(format!("{revision:020}.json")),
            )
            .map_err(atomic::io)?;
        }
        Ok(())
    }
    pub fn snapshot(&self) -> Result<CollaborationSnapshot> {
        if self.manifest.format_version == crate::collaboration::CURRENT_COLLABORATION_FORMAT {
            let mut result = self.snapshot_with_catalog()?;
            // Legacy snapshot consumers retain their last verified layer on this explicit
            // deferred condition; catalog-aware callers receive the complete staged payload.
            for layer in result.deferred_authors {
                if let Some(author) = result
                    .snapshot
                    .authors
                    .iter_mut()
                    .find(|a| a.identity.author_id == layer.author_id)
                {
                    let mut error = AppError::new(
                        ErrorCode::RevisionConflict,
                        "New shared media is available; update the catalog to view this author layer",
                    );
                    error.details = Some(serde_json::json!({"catalogUpdateRequired":true}));
                    author.error = Some(error);
                }
            }
            return Ok(result.snapshot);
        }
        self.snapshot_loaded()
    }
    pub(super) fn snapshot_loaded(&self) -> Result<CollaborationSnapshot> {
        self.authority()?;
        let accounts = self.authors()?;
        let mut authors = Vec::new();
        let mut budget = ReadBudget::new(MAX_TOTAL_LAYER_BYTES);
        for account in accounts {
            let result = self.head(&account.identity.author_id, &mut budget);
            let (layer, error) = match result {
                Ok(layer) => (layer, None),
                Err(error) if budget.exhausted => return Err(error),
                Err(error) => (None, Some(error)),
            };
            authors.push(AuthorSnapshot {
                identity: account.identity,
                layer,
                error,
            });
        }
        self.authority()?;
        Ok(CollaborationSnapshot {
            project_id: self.manifest.project_id.clone(),
            authors,
        })
    }
}
