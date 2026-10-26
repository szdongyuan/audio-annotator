//! Immutable v2 metadata plus one immutable record per committed media item.
use super::{atomic, atomic::short_lock, validation::*, *};
use crate::{
    error::{AppError, ErrorCode, Result},
    media::{
        decode,
        identity::{check_cancel, fingerprint, SourceStamp},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};

const MAX_RECORD_BYTES: usize = 65536;
const MAX_CATALOG_ENTRIES: usize = MAX_MEDIA + 256;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefaultManifest {
    kind: String,
    format_version: u32,
    project_id: String,
    name: String,
    created_at: String,
    catalog_version: u32,
}
impl DefaultManifest {
    fn effective(self) -> Result<CollaborationManifest> {
        require(self.kind == MANIFEST_KIND, "Invalid default manifest kind")?;
        if self.format_version != crate::collaboration::CURRENT_COLLABORATION_FORMAT
            || self.catalog_version != 1
        {
            return Err(AppError::new(
                ErrorCode::UnsupportedVersion,
                "Unsupported default catalog format",
            ));
        }
        let manifest = CollaborationManifest {
            kind: self.kind,
            format_version: CURRENT_COLLABORATION_FORMAT,
            project_id: self.project_id,
            name: self.name,
            created_at: self.created_at,
            media: vec![],
        };
        manifest.validate()?;
        Ok(manifest)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogRecord {
    kind: String,
    format_version: u32,
    project_id: String,
    media: PublicMedia,
}
impl CatalogRecord {
    fn new(project_id: &str, media: PublicMedia) -> Self {
        Self {
            kind: "audio-annotator-media-record".into(),
            format_version: 1,
            project_id: project_id.into(),
            media,
        }
    }
    fn parse(bytes: &[u8], manifest: &CollaborationManifest) -> Result<Self> {
        let record: Self = decode(bytes, MAX_RECORD_BYTES, "audio-annotator-media-record")?;
        require(
            record.project_id == manifest.project_id,
            "Catalog project mismatch",
        )?;
        let mut check = manifest.clone();
        check.media = vec![record.media.clone()];
        check.validate()?;
        Ok(record)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogRevision {
    pub media_count: usize,
    pub byte_length: usize,
    pub digest: String,
}
/// Native result. Deferred layers retain their complete verified payload and original hash.
pub struct CatalogSnapshot {
    pub snapshot: CollaborationSnapshot,
    pub catalog_update_available: bool,
    pub revision: Option<CatalogRevision>,
    pub deferred_authors: Vec<AuthorLayer>,
}

pub(super) struct LoadedCatalog {
    pub manifest: CollaborationManifest,
    pub revision: Option<CatalogRevision>,
    pub record_hashes: Vec<(String, String)>,
}
fn record_digest(records: &[(String, String)]) -> Result<String> {
    Ok(hash(
        &serde_json::to_vec(records).map_err(|_| AppError::invalid("Cannot hash catalog"))?,
    ))
}
#[cfg(test)]
std::thread_local! {
    static CATALOG_LOADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn load(
    root: &Path,
    bytes: &[u8],
    after_entry: &mut impl FnMut(&Path) -> Result<()>,
) -> Result<LoadedCatalog> {
    #[cfg(test)]
    CATALOG_LOADS.with(|count| count.set(count.get() + 1));
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Header {
        format_version: u32,
    }
    limit(bytes.len() <= MAX_LAYER_BYTES)?;
    let header: Header =
        serde_json::from_slice(bytes).map_err(|_| AppError::invalid("Invalid manifest header"))?;
    if header.format_version != crate::collaboration::CURRENT_COLLABORATION_FORMAT {
        return Err(AppError::new(
            ErrorCode::UnsupportedVersion,
            "Unsupported collaboration version; use the prior app or exchange/export workflow",
        ));
    }
    let fixed: DefaultManifest = serde_json::from_slice(bytes)
        .map_err(|_| AppError::invalid("Invalid default manifest structure"))?;
    let mut manifest = fixed.effective()?;
    let dir = root.join("catalog");
    atomic::safe_existing(&dir)?;
    let mut records = Vec::new();
    let mut byte_length = bytes.len();
    for (index, entry) in fs::read_dir(&dir).map_err(atomic::io)?.enumerate() {
        limit(index < MAX_CATALOG_ENTRIES)?;
        let entry = entry.map_err(atomic::io)?;
        after_entry(&entry.path())?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| AppError::invalid("Invalid catalog filename"))?;
        if name.starts_with('.') && name.ends_with(".tmp") {
            atomic::safe_existing(&dir)?;
            // Publication may rename/remove a temporary after read_dir yielded its name.
            // Existing links still fail closed; absence is normal only for ignored temporaries.
            match fs::symlink_metadata(entry.path()) {
                Ok(metadata) => require(
                    !atomic::is_link(&metadata),
                    "Symlink/reparse paths are forbidden",
                )?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(atomic::io(error)),
            }
            continue;
        }
        atomic::safe_existing(&entry.path())?;
        if name == ".commit.lock" {
            continue;
        }
        limit(records.len() < MAX_MEDIA)?;
        let id = name
            .strip_suffix(".json")
            .ok_or_else(|| AppError::invalid("Unknown catalog entry"))?;
        uuid(id)?;
        let bytes = atomic::read(
            &entry.path(),
            MAX_RECORD_BYTES.min(MAX_LAYER_BYTES - byte_length),
        )?;
        byte_length += bytes.len();
        let record = CatalogRecord::parse(&bytes, &manifest)?;
        require(record.media.id == id, "Catalog filename identity mismatch")?;
        let path = root.join(&record.media.source_ref);
        atomic::safe_existing(&path)?;
        require(
            path.is_file()
                && fs::metadata(&path).map_err(atomic::io)?.len() == record.media.byte_length,
            "Missing or changed catalog media",
        )?;
        records.push((record.media, hash(&bytes)));
    }
    records.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    let record_hashes = records
        .iter()
        .map(|r| (r.0.id.clone(), r.1.clone()))
        .collect::<Vec<_>>();
    let digest = record_digest(&record_hashes)?;
    manifest.media = records.into_iter().map(|r| r.0).collect();
    manifest.validate()?;
    let revision = CatalogRevision {
        media_count: manifest.media.len(),
        byte_length,
        digest,
    };
    Ok(LoadedCatalog {
        manifest,
        revision: Some(revision),
        record_hashes,
    })
}

/// Caller owns precopy staging until it drops this capability. No DTO constructor or serde.
pub struct PreparedCatalogMedia {
    root: PathBuf,
    project_id: String,
    media: PublicMedia,
    staged: PathBuf,
    owned_file: File,
    source: PathBuf,
    stamp: SourceStamp,
    decoded: Arc<decode::DecodedMedia>,
}
fn placement_identity_handle(file: &File) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        use windows_sys::Win32::{
            Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE},
            Storage::FileSystem::{
                ReOpenFile, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
                FILE_SHARE_WRITE,
            },
        };
        // ReOpenFile retains this exact object without a pathname handoff. A duplicate
        // writable handle would let SMB defer last-write time until capability release,
        // after native has captured its published SourceStamp. Retain identity read-only;
        // the separate copy writer is synced and closed before preparation returns.
        let handle = unsafe {
            ReOpenFile(
                file.as_raw_handle(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_FLAG_OPEN_REPARSE_POINT,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        // Successful ReOpenFile returns a new owned handle, independent of the writer.
        Ok(unsafe { File::from_raw_handle(handle) })
    }
    #[cfg(not(windows))]
    file.try_clone()
}
impl PreparedCatalogMedia {
    pub fn media(&self) -> &PublicMedia {
        &self.media
    }
    /// Set a native-derived name before the capability is exposed to consumers.
    pub fn with_display_name(mut self, name: String) -> Result<Self> {
        require(
            !name.trim().is_empty() && name.chars().count() <= 1024,
            "Invalid media display name",
        )?;
        Arc::get_mut(&mut self.decoded)
            .ok_or_else(|| AppError::invalid("Prepared media already exposed"))?
            .descriptor
            .display_name = name.clone();
        self.media.display_name = name;
        Ok(self)
    }
    /// Use before emitting Ready: descriptor, pending item and committed record share this UUID.
    /// The source binding is still the original import path; after commit native rebinds its
    /// registry entry to the returned PublicMedia descriptor and the shared source path.
    pub fn decoded(&self) -> Arc<decode::DecodedMedia> {
        self.decoded.clone()
    }
    fn retained_error(&self, mut error: AppError) -> AppError {
        error.details =
            Some(serde_json::json!({"mediaRecoveryRequired":true,"mediaId":self.media.id}));
        error
    }
    fn owned_placement(&self) -> Result<PathBuf> {
        for path in [&self.staged, &self.root.join(&self.media.source_ref)] {
            if atomic::verify_lock_path(path, &self.owned_file).is_ok() {
                return Ok(path.to_path_buf());
            }
        }
        let mut error = AppError::new(
            ErrorCode::IdentityMismatch,
            "Prepared media placement is unavailable or changed; retained files require recovery",
        );
        error.retryable = true;
        Err(self.retained_error(error))
    }
}
impl Drop for PreparedCatalogMedia {
    fn drop(&mut self) {
        // A failed rollback may leave a foreign file at our old staging name.
        if atomic::verify_lock_path(&self.staged, &self.owned_file).is_ok() {
            let _ = fs::remove_file(&self.staged);
        }
    }
}

impl CollaborationRepository {
    pub fn manifest_identity(&self) -> &str {
        &self.manifest_hash
    }
    pub fn catalog_revision(&self) -> Option<&CatalogRevision> {
        self.catalog_revision.as_ref()
    }
    pub fn create_default(
        root: &Path,
        name: &str,
        identity: &profiles::Profile,
    ) -> Result<(Self, AuthorSession)> {
        atomic::safe_existing(root)?;
        require(
            root.is_dir() && fs::read_dir(root).map_err(atomic::io)?.next().is_none(),
            "New project directory must be empty",
        )?;
        let document = crate::model::ProjectDocument::create(name.to_owned())?;
        let fixed = DefaultManifest {
            kind: MANIFEST_KIND.into(),
            format_version: CURRENT_COLLABORATION_FORMAT,
            project_id: document.project_id,
            name: document.name,
            created_at: document.created_at,
            catalog_version: 1,
        };
        // Do not recursively remove a caller's root after an error; native owns target cleanup.
        for dir in ["media", "authors", "annotations", "catalog"] {
            fs::create_dir(root.join(dir)).map_err(atomic::io)?;
        }
        atomic::publish_new(
            &root.join("collaboration.json"),
            &serde_json::to_vec(&fixed).map_err(|_| AppError::invalid("Cannot encode manifest"))?,
            None,
            None,
        )?;
        let repo = Self::open(root)?;
        let actor = repo.adopt(identity)?;
        Ok((repo, actor))
    }
    /// Returns a new view without mutating the caller's loaded catalog or author lease.
    pub fn reload_catalog(&self) -> Result<Self> {
        self.authority()?;
        let current = Self::open(&self.root)?;
        require(
            current.manifest_hash == self.manifest_hash,
            "Immutable manifest changed",
        )?;
        for old in &self.manifest.media {
            require(
                current.manifest.media.iter().any(|m| m == old),
                "Previously loaded catalog media changed or disappeared",
            )?;
        }
        Ok(current)
    }
    /// Decode and copy outside all application-state locks. Only this function creates the capability.
    pub fn prepare_media(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
    ) -> Result<PreparedCatalogMedia> {
        self.prepare_media_with_progress(source, cache_root, cancel, |_, _| {})
    }
    pub fn prepare_media_with_progress(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
        mut progress: impl FnMut(&str, u64),
    ) -> Result<PreparedCatalogMedia> {
        self.prepare_media_inner(source, cache_root, cancel, &mut progress, None)
    }
    /// Independently decode/copy existing document media, retaining its validated UUID.
    /// A supplied descriptor is never proof: every identity field is checked against decoder output.
    pub fn prepare_media_copy(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
        expected: &crate::model::MediaDescriptor,
        progress: impl FnMut(&str, u64),
    ) -> Result<PreparedCatalogMedia> {
        self.prepare_media_inner(source, cache_root, cancel, progress, Some(expected))
    }
    fn prepare_media_inner(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
        mut progress: impl FnMut(&str, u64),
        expected: Option<&crate::model::MediaDescriptor>,
    ) -> Result<PreparedCatalogMedia> {
        self.authority()?;
        require(
            self.manifest.format_version == crate::collaboration::CURRENT_COLLABORATION_FORMAT,
            "Legacy project catalog is immutable",
        )?;
        atomic::safe_existing(source)?;
        let mut decoded = decode::decode(source, cache_root, cancel, &mut progress)?;
        if let Some(expected) = expected {
            uuid(&expected.id)?;
            require(
                crate::media::registry::same_identity(expected, &decoded.descriptor),
                "Source media identity changed",
            )?;
            decoded.descriptor.id = expected.id.clone();
            decoded.descriptor.display_name = expected.display_name.clone();
        }
        let decoded = Arc::new(decoded);
        let d = &decoded.descriptor;
        // Exchange archives deliberately use extensionless entries; inspect verified bytes.
        let mut header = [0u8; 12];
        let n = File::open(source)
            .map_err(atomic::io)?
            .read(&mut header)
            .map_err(atomic::io)?;
        let extension = if n >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WAVE" {
            "wav"
        } else if n >= 4 && &header[..4] == b"fLaC" {
            "flac"
        } else {
            "mp3"
        };
        let media = PublicMedia {
            id: d.id.clone(),
            display_name: d.display_name.clone(),
            source_ref: format!("media/{}.{}", d.id, extension),
            sha256: d.sha256.clone(),
            byte_length: d.byte_length,
            sample_rate: d.sample_rate,
            frame_count: d.frame_count,
            channel_count: d.channel_count,
            channel_layout: d.channel_layout.clone(),
        };
        let mut check = self.manifest.clone();
        check.media = vec![media.clone()];
        check.validate()?;
        let staged = self
            .root
            .join("media")
            .join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        atomic::safe_existing(staged.parent().unwrap())?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged)
            .map_err(atomic::io)?;
        let owned_file = placement_identity_handle(&output)
            .inspect_err(|_| {
                if atomic::verify_lock_path(&staged, &output).is_ok() {
                    let _ = fs::remove_file(&staged);
                }
            })
            .map_err(atomic::io)?;
        let prepared = PreparedCatalogMedia {
            root: self.root.clone(),
            project_id: self.manifest.project_id.clone(),
            media,
            staged,
            owned_file,
            source: decoded.source_path.clone(),
            stamp: decoded.stamp.clone(),
            decoded: decoded.clone(),
        };
        let mut input = File::open(&prepared.source).map_err(atomic::io)?;
        let mut buffer = [0u8; 65536];
        let mut count = 0u64;
        loop {
            check_cancel(cancel)?;
            let n = input.read(&mut buffer).map_err(atomic::io)?;
            if n == 0 {
                break;
            }
            count += n as u64;
            require(
                count <= prepared.media.byte_length,
                "Source grew during copy",
            )?;
            output.write_all(&buffer[..n]).map_err(atomic::io)?;
            progress("copyMedia", count);
        }
        output.sync_all().map_err(atomic::io)?;
        drop(output);
        decoded.verify_source()?;
        require(
            count == prepared.media.byte_length
                && fingerprint(&prepared.staged, cancel, |_| {})? == prepared.media.sha256,
            "Copied media fingerprint mismatch",
        )?;
        Ok(prepared)
    }
    pub fn append_media(
        &self,
        session: &AuthorSession,
        prepared: &PreparedCatalogMedia,
        cancel: &AtomicBool,
    ) -> Result<PublicMedia> {
        self.append_media_controlled(session, prepared, cancel, None)
    }
    /// Fault points affect only the catalog-record publication, after verified media placement.
    pub fn append_media_controlled(
        &self,
        session: &AuthorSession,
        prepared: &PreparedCatalogMedia,
        cancel: &AtomicBool,
        fault: Option<atomic::PublishFault>,
    ) -> Result<PublicMedia> {
        self.append_media_interleaved(session, prepared, cancel, fault, || Ok(()))
    }
    /// Same writer with a deterministic interruption boundary after media placement.
    pub fn append_media_interleaved(
        &self,
        session: &AuthorSession,
        prepared: &PreparedCatalogMedia,
        cancel: &AtomicBool,
        fault: Option<atomic::PublishFault>,
        after_placement: impl FnOnce() -> Result<()>,
    ) -> Result<PublicMedia> {
        self.append_media_with_catalog_interleaved(
            session,
            prepared,
            cancel,
            fault,
            after_placement,
        )
        .map(|(media, _)| media)
    }
    /// Return the coherent, fully validated catalog captured by this commit.
    /// Later independent appends are discovered by the normal explicit-update protocol.
    pub fn append_media_with_catalog(
        &self,
        session: &AuthorSession,
        prepared: &PreparedCatalogMedia,
        cancel: &AtomicBool,
    ) -> Result<(PublicMedia, Self)> {
        self.append_media_with_catalog_interleaved(session, prepared, cancel, None, || Ok(()))
    }
    pub fn append_media_with_catalog_interleaved(
        &self,
        session: &AuthorSession,
        prepared: &PreparedCatalogMedia,
        cancel: &AtomicBool,
        fault: Option<atomic::PublishFault>,
        after_placement: impl FnOnce() -> Result<()>,
    ) -> Result<(PublicMedia, Self)> {
        self.session_authority(session)?;
        require(
            self.manifest.format_version == crate::collaboration::CURRENT_COLLABORATION_FORMAT,
            "Legacy project catalog is immutable",
        )?;
        require(
            prepared.root == self.root && prepared.project_id == self.manifest.project_id,
            "Prepared media belongs to another project",
        )?;
        // Expensive source/hash work precedes the short commit lock. Retry after committed/lost ack
        // works even when the source disappears or cancellation arrives after commit.
        let record_path = self
            .root
            .join("catalog")
            .join(format!("{}.json", prepared.media.id));
        atomic::safe_existing(record_path.parent().unwrap())?;
        // A new UUID cannot be an acknowledged retry. Only that retry needs a complete
        // read before source/cancel checks; every new commit still reads under the lock.
        if record_path.try_exists().map_err(atomic::io)? {
            let current = self.reload_catalog()?;
            if let Some(existing) = current
                .manifest
                .media
                .iter()
                .find(|m| m.id == prepared.media.id)
            {
                require(
                    existing == &prepared.media,
                    "Committed media differs from retry",
                )?;
                return Ok((existing.clone(), current));
            }
        }
        check_cancel(cancel)?;
        atomic::safe_existing(&prepared.source)?;
        prepared.stamp.verify(&prepared.source)?;
        let placement = prepared.owned_placement()?;
        require(
            fs::metadata(&placement).map_err(atomic::io)?.len() == prepared.media.byte_length
                && fingerprint(&placement, cancel, |_| {})? == prepared.media.sha256,
            "Staged media changed",
        )
        .map_err(|error| prepared.retained_error(error))?;
        let _lock = short_lock(&self.root.join("catalog/.commit.lock"))?;
        self.session_authority(session)?;
        let mut current = self.reload_catalog()?;
        if let Some(existing) = current
            .manifest
            .media
            .iter()
            .find(|m| m.id == prepared.media.id)
        {
            require(
                existing == &prepared.media,
                "Committed media differs from retry",
            )?;
            return Ok((existing.clone(), current));
        }
        limit(current.manifest.media.len() < MAX_MEDIA)?;
        check_cancel(cancel)?;
        atomic::safe_existing(&prepared.source)?;
        prepared.stamp.verify(&prepared.source)?;
        let target = self.root.join(&prepared.media.source_ref);
        atomic::safe_existing(target.parent().unwrap())?;
        let record = serde_json::to_vec(&CatalogRecord::new(
            &self.manifest.project_id,
            prepared.media.clone(),
        ))
        .map_err(|_| AppError::invalid("Cannot encode catalog record"))?;
        limit(record.len() <= MAX_RECORD_BYTES)?;
        limit(
            current.catalog_revision.as_ref().unwrap().byte_length + record.len()
                <= MAX_LAYER_BYTES,
        )?;
        // Reserve one directory slot for the record temporary/final name while holding
        // the catalog commit lock. Foreign abandoned temporaries count and remain untouched.
        for (index, entry) in fs::read_dir(self.root.join("catalog"))
            .map_err(atomic::io)?
            .enumerate()
        {
            entry.map_err(atomic::io)?;
            limit(index < MAX_CATALOG_ENTRIES - 1)?;
        }
        // Copying was completed before the lock; move staging into place and return it on failure.
        if prepared.owned_placement()? == prepared.staged {
            atomic::no_replace(&prepared.staged, &target).map_err(atomic::io)?;
        }
        atomic::verify_lock_path(&target, &prepared.owned_file)
            .map_err(|error| prepared.retained_error(error))?;
        after_placement().map_err(|error| prepared.retained_error(error))?;
        // Derive the next snapshot from this lock's fully verified records plus the
        // exact bytes we are about to publish. Never reserialize old records for hashes.
        current.manifest.media.push(prepared.media.clone());
        current.manifest.media.sort_by(|a, b| a.id.cmp(&b.id));
        current
            .catalog_record_hashes
            .push((prepared.media.id.clone(), hash(&record)));
        current.catalog_record_hashes.sort_by(|a, b| a.0.cmp(&b.0));
        let digest = record_digest(&current.catalog_record_hashes)?;
        current.manifest.validate()?;
        let revision = current.catalog_revision.as_mut().unwrap();
        revision.media_count = current.manifest.media.len();
        revision.byte_length += record.len();
        revision.digest = digest;
        let result = atomic::publish_new(&record_path, &record, fault, Some(cancel));
        if result.is_err()
            && !record_path
                .try_exists()
                .map_err(|error| prepared.retained_error(atomic::io(error)))?
        {
            // Return precisely our unpublished media to caller-owned staging; never delete a record.
            atomic::verify_lock_path(&target, &prepared.owned_file)
                .map_err(|error| prepared.retained_error(error))?;
            atomic::no_replace(&target, &prepared.staged)
                .map_err(|error| prepared.retained_error(atomic::io(error)))?;
        }
        result?;
        Ok((prepared.media.clone(), current))
    }
    pub fn snapshot_with_catalog(&self) -> Result<CatalogSnapshot> {
        self.snapshot_with_catalog_interleaved(|_| Ok(()))
    }
    /// Same reader with a deterministic boundary after catalog capture for concurrency tests.
    pub fn snapshot_with_catalog_interleaved(
        &self,
        mut after_catalog: impl FnMut(usize) -> Result<()>,
    ) -> Result<CatalogSnapshot> {
        for attempt in 0..3 {
            let current = self.reload_catalog()?;
            after_catalog(attempt)?;
            let mut snapshot = current.snapshot_loaded()?;
            // Author heads are published after their media records. A head read against
            // a catalog captured earlier can therefore fail validation without being corrupt.
            // Only classify layers once the catalog brackets the author read unchanged.
            if current.reload_catalog()?.catalog_revision != current.catalog_revision {
                continue;
            }
            let mut deferred_authors = vec![];
            for author in &mut snapshot.authors {
                if author
                    .layer
                    .as_ref()
                    .is_some_and(|l| l.payload.project(&self.manifest).is_err())
                {
                    deferred_authors.push(author.layer.take().unwrap());
                }
            }
            return Ok(CatalogSnapshot {
                snapshot,
                catalog_update_available: current.catalog_revision != self.catalog_revision,
                revision: current.catalog_revision,
                deferred_authors,
            });
        }
        let mut error = AppError::new(
            ErrorCode::RevisionConflict,
            "Shared media catalog is changing; retry the snapshot",
        );
        error.retryable = true;
        error.details = Some(serde_json::json!({"catalogUpdateRequired":true}));
        Err(error)
    }
}

#[cfg(all(test, windows))]
mod import_scan_regression {
    use super::*;
    #[test]
    fn prepared_placement_identity_handle_cannot_write() {
        let root =
            std::env::temp_dir().join(format!("readonly-placement-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("local")).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        let identity = profiles::Profile::new("Test").unwrap();
        let (repo, actor) = CollaborationRepository::create_default(
            &root.join("project"),
            "readonly identity",
            &identity,
        )
        .unwrap();
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let prepared = repo
            .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
            .unwrap();
        let mut duplicate = prepared.owned_file.try_clone().unwrap();
        let result = duplicate.write_all(b"owned fixture write probe");
        drop((duplicate, prepared, actor, repo));
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            result.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }
    #[test]
    fn new_catalog_import_performs_one_verified_catalog_scan() {
        let root = std::env::temp_dir().join(format!("one-catalog-scan-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("local")).unwrap();
        fs::create_dir(root.join("project")).unwrap();
        let identity = profiles::Profile::new("Test").unwrap();
        let (repo, actor) =
            CollaborationRepository::create_default(&root.join("project"), "one scan", &identity)
                .unwrap();
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let prepared = repo
            .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
            .unwrap();
        // Exercise a new UUID in a nonempty catalog, not only initial creation.
        repo.append_media(&actor, &prepared, &AtomicBool::new(false))
            .unwrap();
        let next = repo
            .prepare_media(&source, &root.join("next-pcm"), &AtomicBool::new(false))
            .unwrap();
        CATALOG_LOADS.with(|count| count.set(0));
        repo.append_media(&actor, &next, &AtomicBool::new(false))
            .unwrap();
        let count = CATALOG_LOADS.with(|count| count.get());
        drop((next, prepared, actor, repo));
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            count, 1,
            "new UUID publication must read the full catalog only under its commit lock"
        );
    }
}
