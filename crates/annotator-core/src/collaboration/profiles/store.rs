use super::{normalize_name, Profile, MAX_PROFILES, MAX_STORE_BYTES, PROFILE_FORMAT_VERSION};
use crate::{
    collaboration::{
        atomic,
        atomic::short_lock,
        validation::{limit, require},
    },
    error::{AppError, ErrorCode, Result},
    model::validation::MAX_SAFE_INTEGER,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const STORE_KIND: &str = "annotator.profile-store";
pub const STORE_FILE_NAME: &str = "profiles.json";
const LOCK_FILE_NAME: &str = ".profiles.lock";

/// Last-selected is a launch preference, not a command to rebind a running editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSnapshot {
    pub revision: u64,
    pub last_selected_author_id: String,
    pub profiles: Vec<Profile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileMutation {
    pub snapshot: ProfileSnapshot,
    pub profile: Profile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportResult {
    pub snapshot: ProfileSnapshot,
    pub profile: Profile,
    pub already_exists: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    kind: String,
    format_version: u32,
    revision: u64,
    last_selected_author_id: String,
    profiles: Vec<Profile>,
}
impl Document {
    fn validate(&self) -> Result<()> {
        require(self.kind == STORE_KIND, "Invalid profile store kind")?;
        if self.format_version != PROFILE_FORMAT_VERSION {
            return Err(AppError::new(
                ErrorCode::UnsupportedVersion,
                "Unsupported profile store version",
            ));
        }
        require(
            (1..=MAX_SAFE_INTEGER).contains(&self.revision),
            "Invalid profile store revision",
        )?;
        limit(self.profiles.len() <= MAX_PROFILES)?;
        let mut ids = HashSet::new();
        for profile in &self.profiles {
            profile.validate()?;
            require(ids.insert(&profile.author_id), "Duplicate profile UUID")?;
        }
        require(
            ids.contains(&self.last_selected_author_id),
            "Selected profile does not exist",
        )
    }
    fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|_| AppError::invalid("Cannot encode profile store"))?;
        limit(bytes.len() <= MAX_STORE_BYTES)?;
        Ok(bytes)
    }
    fn snapshot(self) -> ProfileSnapshot {
        ProfileSnapshot {
            revision: self.revision,
            last_selected_author_id: self.last_selected_author_id,
            profiles: self.profiles,
        }
    }
}

pub struct ProfileStore {
    root: PathBuf,
}
impl ProfileStore {
    /// The caller supplies an existing application-local directory, never a project root.
    pub fn load_or_create(local_root: &Path) -> Result<Self> {
        atomic::safe_existing(local_root)?;
        require(
            fs::metadata(local_root).map_err(atomic::io)?.is_dir(),
            "Expected profile directory",
        )?;
        let store = Self {
            root: fs::canonicalize(local_root).map_err(atomic::io)?,
        };
        let _lock = short_lock(&store.root.join(LOCK_FILE_NAME))?;
        let path = store.root.join(STORE_FILE_NAME);
        if path.try_exists().map_err(atomic::io)? {
            store.read()?;
        } else {
            let mut profile = Profile::new("本机身份")?;
            profile.display_name = format!("本机身份 · {}", &profile.author_id[..8]);
            let document = Document {
                kind: STORE_KIND.into(),
                format_version: PROFILE_FORMAT_VERSION,
                revision: 1,
                last_selected_author_id: profile.author_id.clone(),
                profiles: vec![profile],
            };
            atomic::publish_new(&path, &document.encode()?, None, None)?;
        }
        Ok(store)
    }
    pub fn snapshot(&self) -> Result<ProfileSnapshot> {
        Ok(self.read()?.snapshot())
    }
    /// Creation is persisted without changing the launch preference. Selection is explicit.
    pub fn create(&self, expected_revision: u64, display_name: &str) -> Result<ProfileMutation> {
        let profile = Profile::new(display_name)?;
        let (snapshot, profile) = self.mutate(expected_revision, |document| {
            document.profiles.push(profile.clone());
            Ok((profile, true))
        })?;
        Ok(ProfileMutation { snapshot, profile })
    }
    pub fn rename(
        &self,
        expected_revision: u64,
        author_id: &str,
        display_name: &str,
    ) -> Result<ProfileMutation> {
        let display_name = normalize_name(display_name)?;
        let (snapshot, profile) = self.mutate(expected_revision, |document| {
            let profile = document
                .profiles
                .iter_mut()
                .find(|p| p.author_id == author_id)
                .ok_or_else(|| AppError::invalid("Profile does not exist"))?;
            let changed = profile.display_name != display_name;
            profile.display_name = display_name;
            Ok((profile.clone(), changed))
        })?;
        Ok(ProfileMutation { snapshot, profile })
    }
    pub fn select(&self, expected_revision: u64, author_id: &str) -> Result<ProfileSnapshot> {
        let (snapshot, ()) = self.mutate(expected_revision, |document| {
            require(
                document.profiles.iter().any(|p| p.author_id == author_id),
                "Profile does not exist",
            )?;
            let changed = document.last_selected_author_id != author_id;
            document.last_selected_author_id = author_id.to_owned();
            Ok(((), changed))
        })?;
        Ok(snapshot)
    }
    /// Record a real process identity change, even if another process already chose this launch preference.
    /// Callers must handle selection of their own active UUID as a separate no-op.
    pub fn select_for_process(
        &self,
        expected_revision: u64,
        author_id: &str,
    ) -> Result<ProfileSnapshot> {
        self.mutate(expected_revision, |document| {
            require(
                document.profiles.iter().any(|p| p.author_id == author_id),
                "Profile does not exist",
            )?;
            document.last_selected_author_id = author_id.to_owned();
            Ok(((), true))
        })
        .map(|(snapshot, ())| snapshot)
    }
    /// Validate the complete portable file before acquiring the mutation lock. Import never selects.
    pub fn import(&self, expected_revision: u64, path: &Path) -> Result<ImportResult> {
        self.import_profile(expected_revision, super::read_transfer(path)?)
    }
    /// Commit a completely read/validated transfer without further I/O to its source.
    pub fn import_profile(&self, expected_revision: u64, profile: Profile) -> Result<ImportResult> {
        super::encode_transfer(&profile)?;
        let (snapshot, (profile, already_exists)) = self.mutate(expected_revision, |document| {
            if let Some(local) = document
                .profiles
                .iter()
                .find(|p| p.author_id == profile.author_id)
            {
                return Ok(((local.clone(), true), false));
            }
            document.profiles.push(profile.clone());
            Ok(((profile, false), true))
        })?;
        Ok(ImportResult {
            snapshot,
            profile,
            already_exists,
        })
    }
    /// Check a no-write operation under the same interprocess revision lock as mutations.
    pub fn check_revision(&self, expected_revision: u64) -> Result<ProfileSnapshot> {
        self.mutate(expected_revision, |_| Ok(((), false)))
            .map(|(snapshot, ())| snapshot)
    }
    pub fn capture_export(
        &self,
        expected_revision: u64,
        author_id: &str,
    ) -> Result<(ProfileSnapshot, Vec<u8>)> {
        self.mutate(expected_revision, |document| {
            let profile = document
                .profiles
                .iter()
                .find(|p| p.author_id == author_id)
                .ok_or_else(|| AppError::invalid("Profile does not exist"))?;
            Ok((super::encode_transfer(profile)?, false))
        })
    }
    /// Export only the requested identity, with atomic create-new/no-clobber semantics.
    pub fn export(&self, author_id: &str, path: &Path) -> Result<()> {
        let document = self.read()?;
        let profile = document
            .profiles
            .iter()
            .find(|p| p.author_id == author_id)
            .ok_or_else(|| AppError::invalid("Profile does not exist"))?;
        atomic::publish_new(path, &super::encode_transfer(profile)?, None, None)
    }
    fn mutate<T>(
        &self,
        expected_revision: u64,
        change: impl FnOnce(&mut Document) -> Result<(T, bool)>,
    ) -> Result<(ProfileSnapshot, T)> {
        let _lock = short_lock(&self.root.join(LOCK_FILE_NAME))?;
        let mut document = self.read()?;
        if document.revision != expected_revision {
            return Err(AppError::new(
                ErrorCode::RevisionConflict,
                "Profile store changed; refresh and retry",
            ));
        }
        let (result, changed) = change(&mut document)?;
        if changed {
            document.revision = document
                .revision
                .checked_add(1)
                .ok_or_else(|| AppError::invalid("Profile revision overflow"))?;
            self.replace(&document.encode()?)?;
        }
        Ok((document.snapshot(), result))
    }
    fn replace(&self, bytes: &[u8]) -> Result<()> {
        limit(bytes.len() <= MAX_STORE_BYTES)?;
        atomic::safe_existing(&self.root)?;
        let target = self.root.join(STORE_FILE_NAME);
        let temporary = self
            .root
            .join(format!(".profiles.{}.tmp", uuid::Uuid::new_v4()));
        let mut owned = false;
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(atomic::io)?;
            owned = true;
            file.write_all(bytes).map_err(atomic::io)?;
            file.flush().map_err(atomic::io)?;
            file.sync_all().map_err(atomic::io)?;
            drop(file);
            atomic::safe_existing(&target)?;
            crate::project::store::atomic_replace(&temporary, &target).map_err(atomic::io)
        })();
        if owned && result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
    fn read(&self) -> Result<Document> {
        let bytes = atomic::read(&self.root.join(STORE_FILE_NAME), MAX_STORE_BYTES)?;
        let document: Document = serde_json::from_slice(&bytes)
            .map_err(|_| AppError::invalid("Invalid profile store structure"))?;
        document.validate()?;
        Ok(document)
    }
}
