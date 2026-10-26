//! Prepared media capabilities and transactional publication through the organization head.
use super::{atomic, atomic::short_lock, validation::*, *};
use crate::{
    error::{AppError, ErrorCode, Result},
    media::{
        decode,
        identity::{check_cancel, fingerprint, SourceStamp},
    },
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
};

pub(super) use super::catalog_storage::load;
#[cfg(test)]
use super::catalog_storage::CATALOG_LOADS;
use super::catalog_storage::{
    record_digest, CatalogRecord, DefaultManifest, MAX_CATALOG_ENTRIES, MAX_RECORD_BYTES,
};
pub use super::catalog_storage::{CatalogRevision, CatalogSnapshot};

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
    placement: organization::NativePlacementPlan,
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
    /// Attach native validated placement before passing the capability to consumers.
    pub fn with_placement(mut self, plan: organization::NativePlacementPlan) -> Result<Self> {
        require(
            plan.project_id == self.project_id,
            "Placement belongs to another project",
        )?;
        self.placement = plan;
        Ok(self)
    }
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
            catalog_version: 2,
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
        atomic::publish_new(
            &root.join("organization.json"),
            &organization::encode(&organization::Organization::empty(fixed.project_id.clone()))?,
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
        self.prepare_media_inner(source, cache_root, cancel, &mut progress, None, None, None)
    }
    /// Consume a plan sealed from the batch's immutable native head capture.
    /// Publication still revalidates the current head/layout under the commit lock.
    pub fn prepare_media_with_placement(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
        placement: organization::NativePlacementPlan,
        progress: impl FnMut(&str, u64),
    ) -> Result<PreparedCatalogMedia> {
        require(
            placement.project_id == self.manifest.project_id,
            "Placement belongs to another project",
        )?;
        self.prepare_media_inner(
            source,
            cache_root,
            cancel,
            progress,
            None,
            Some(placement),
            None,
        )
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
        self.prepare_media_inner(
            source,
            cache_root,
            cancel,
            progress,
            Some(expected),
            None,
            None,
        )
    }
    /// Verified copy with a trusted placement sealed once from the target layout capture.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_media_copy_with_placement(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
        expected: &crate::model::MediaDescriptor,
        placement: organization::NativePlacementPlan,
        progress: impl FnMut(&str, u64),
    ) -> Result<PreparedCatalogMedia> {
        require(
            placement.project_id == self.manifest.project_id,
            "Placement belongs to another project",
        )?;
        self.prepare_media_inner(
            source,
            cache_root,
            cancel,
            progress,
            Some(expected),
            Some(placement),
            None,
        )
    }
    /// Legacy ordinary copies reuse one target capture, deriving names after verified decode.
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_media_copy_in_capture(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
        expected: &crate::model::MediaDescriptor,
        capture: &organization::NativePlacementCapture,
        progress: impl FnMut(&str, u64),
    ) -> Result<PreparedCatalogMedia> {
        self.prepare_media_inner(
            source,
            cache_root,
            cancel,
            progress,
            Some(expected),
            None,
            Some(capture),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn prepare_media_inner(
        &self,
        source: &Path,
        cache_root: &Path,
        cancel: &AtomicBool,
        mut progress: impl FnMut(&str, u64),
        expected: Option<&crate::model::MediaDescriptor>,
        placement: Option<organization::NativePlacementPlan>,
        placement_capture: Option<&organization::NativePlacementCapture>,
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
        // Complete all placement preflight before creating an owned staging file.
        let placement = if let Some(placement) = placement {
            placement
        } else {
            let owned_capture;
            let capture = if let Some(capture) = placement_capture {
                capture
            } else {
                owned_capture = self.capture_media_placement(None)?;
                &owned_capture
            };
            let original_filename =
                native_original_filename(source, expected, extension, &media.id)?;
            capture.seal(vec![], original_filename)?
        };
        require(
            placement.project_id == self.manifest.project_id,
            "Placement belongs to another project",
        )?;
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
            placement,
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
    /// BeforeRecord/AfterRecord bracket immutable publication; other points affect the head.
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
        let next_organization = current
            .organization
            .add_media(&prepared.media.id, &prepared.placement)?;
        let head_bytes = organization::encode(&next_organization)?;
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
        let result = (|| {
            if fault == Some(atomic::PublishFault::BeforeRecord) {
                return Err(atomic::io(std::io::Error::other("Injected before record")));
            }
            // A prior failed head write may have left our immutable record. Reuse only exact bytes.
            if record_path.try_exists().map_err(atomic::io)? {
                require(
                    atomic::read(&record_path, MAX_RECORD_BYTES)? == record,
                    "Uncommitted record differs",
                )?;
            } else {
                atomic::publish_new(&record_path, &record, None, Some(cancel))?;
            }
            if fault == Some(atomic::PublishFault::AfterRecord) {
                return Err(atomic::io(std::io::Error::other("Injected after record")));
            }
            atomic::replace_metadata_controlled(
                &self.root.join("organization.json"),
                &head_bytes,
                fault,
                Some(cancel),
            )?;
            current.organization = next_organization;
            Ok(())
        })();
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

fn native_original_filename(
    source: &Path,
    expected: Option<&crate::model::MediaDescriptor>,
    extension: &str,
    id: &str,
) -> Result<String> {
    let valid = |candidate: &str| {
        candidate.chars().count() <= 255
            && candidate.len() <= 1024
            && !candidate
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            && candidate != "."
            && candidate != ".."
            && !candidate.is_empty()
    };
    let Some(expected) = expected else {
        // Direct imports preserve the native basename exactly, including no extension.
        return source
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| valid(name))
            .map(str::to_owned)
            .ok_or_else(|| AppError::invalid("Invalid original filename"));
    };
    let candidate = expected
        .display_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    // Invalid legacy names must fall back before an extension could disguise them.
    if !valid(candidate) {
        return Ok(format!("{id}.{extension}"));
    }
    let candidate = if Path::new(candidate).extension().is_none() {
        format!("{candidate}.{extension}")
    } else {
        candidate.to_owned()
    };
    if valid(&candidate) {
        Ok(candidate)
    } else {
        Ok(format!("{id}.{extension}"))
    }
}
