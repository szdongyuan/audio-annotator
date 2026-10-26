use super::{
    operations::{reset_resources, Transition},
    runtime::{self, Expected},
};
use crate::{commands::project::info_shared, state::AppState};
#[cfg(test)]
use annotator_core::media::{decode::decode, identity::fingerprint};
use annotator_core::{
    collaboration::*,
    error::{AppError, Result},
    project::LocalProject,
};
use annotator_core::{error::ErrorCode, media::identity::check_cancel};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{ipc::Channel, State};
fn io(e: std::io::Error) -> AppError {
    AppError::new(
        ErrorCode::SaveFailed,
        format!("Collaboration copy failed: {e}"),
    )
}

// Track exact paths. Cleanup never recursively removes a target directory or unknown entries.
pub(crate) struct Owned {
    files: Vec<(PathBuf, fs::File)>,
    dirs: Vec<PathBuf>,
    keep: bool,
}
impl Owned {
    pub(crate) fn new() -> Self {
        Self {
            files: vec![],
            dirs: vec![],
            keep: false,
        }
    }
    pub(crate) fn keep(&mut self) {
        self.keep = true;
    }
    pub(crate) fn own_parent(&mut self, path: PathBuf) {
        self.dirs.insert(0, path);
    }
    pub(crate) fn record_file(&mut self, path: PathBuf) -> Result<()> {
        let handle = fs::File::open(&path).map_err(io)?;
        atomic::verify_lock_path(&path, &handle)?;
        self.files.push((path, handle));
        Ok(())
    }
    pub(crate) fn dir(&mut self, p: &Path) -> Result<()> {
        fs::create_dir(p).map_err(io)?;
        self.dirs.push(p.into());
        Ok(())
    }
    pub(crate) fn inventory(&mut self, root: &Path) -> Result<()> {
        for entry in fs::read_dir(root).map_err(io)? {
            let path = entry.map_err(io)?.path();
            atomic::safe_existing(&path)?;
            if path.is_dir() {
                self.dirs.push(path.clone());
                self.inventory(&path)?;
            } else {
                self.record_file(path)?;
            }
        }
        Ok(())
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.keep {
            for (path, handle) in self.files.drain(..).rev() {
                if atomic::verify_lock_path(&path, &handle).is_ok() {
                    let _ = fs::remove_file(&path);
                }
                drop(handle);
            }
            for p in self.dirs.iter().rev() {
                let _ = fs::remove_dir(p);
            }
        }
    }
}
// Field order releases the private cache and author lease before rollback touches owned files.
pub(crate) struct PreparedCopy {
    pub(crate) project: LocalProject,
    pub(crate) repo: Arc<CollaborationRepository>,
    pub(crate) owned: Owned,
}
impl PreparedCopy {
    pub(crate) fn commit(self) -> (LocalProject, Arc<CollaborationRepository>) {
        let Self {
            project,
            repo,
            mut owned,
        } = self;
        owned.keep = true;
        (project, repo)
    }
}

pub(crate) fn transfer(
    from: &Path,
    to: &Path,
    owned: &mut Owned,
    cancel: &AtomicBool,
) -> Result<()> {
    for entry in fs::read_dir(from).map_err(io)? {
        check_cancel(cancel)?;
        let entry = entry.map_err(io)?;
        let dest = to.join(entry.file_name());
        if entry.file_type().map_err(io)?.is_dir() {
            owned.dir(&dest)?;
            transfer(&entry.path(), &dest, owned, cancel)?;
        } else {
            atomic::safe_existing(&entry.path())?;
            let mut input = fs::File::open(entry.path()).map_err(io)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)
                .map_err(io)?;
            owned.record_file(dest)?;
            let mut block = [0u8; 65536];
            loop {
                check_cancel(cancel)?;
                let n = input.read(&mut block).map_err(io)?;
                if n == 0 {
                    break;
                }
                output.write_all(&block[..n]).map_err(io)?;
            }
            output.sync_all().map_err(io)?;
        }
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgress {
    pub operation_id: String,
    pub phase: String,
    pub completed: u64,
}
#[tauri::command]
pub async fn collaboration_create(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
    target: String,
    on_progress: Channel<CopyProgress>,
) -> Result<Transition> {
    let permit = state.6.begin(operation_id.clone())?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let permit = permit;
        let (document, root) = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let p = current.as_ref().ok_or_else(runtime::stale)?;
            expected.check(
                p,
                &*state.6.current.lock().map_err(|_| runtime::unavailable())?,
                true,
            )?;
            if p.is_shared() {
                return Err(AppError::invalid("Create a personal copy first"));
            }
            (p.snapshot()?.document, p.root().to_path_buf())
        };
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let mut last_phase = String::new();
        let prepared = crate::commands::collaboration::defaults::copy(
            &document,
            &root,
            Path::new(&target),
            &state.6.local()?,
            &state.6.selected_profile()?,
            &permit.cancel,
            |phase, completed| {
                if last.elapsed() < std::time::Duration::from_millis(100) && phase == last_phase {
                    return;
                }
                last = std::time::Instant::now();
                last_phase = phase.into();
                if on_progress
                    .send(CopyProgress {
                        operation_id: operation_id.clone(),
                        phase: phase.into(),
                        completed,
                    })
                    .is_err()
                {
                    permit.cancel.store(true, Ordering::Relaxed);
                }
            },
        )?;
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        expected.check(
            current.as_ref().ok_or_else(runtime::stale)?,
            &*state.6.current.lock().map_err(|_| runtime::unavailable())?,
            true,
        )?;
        check_cancel(&permit.cancel)?;
        let (project, repo) = prepared.commit();
        reset_resources(&state)?;
        state.6.install(Some(repo))?;
        let opened = info_shared(&project, &state.6)?;
        *current = Some(project);
        drop(permit);
        Ok(Transition {
            opened,
            status: runtime::status(current.as_ref(), &state.6)?,
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_cleanup_preserves_a_replacement_at_an_owned_file_path() {
        let root = std::env::temp_dir().join(format!("owned-cleanup-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = root.join("owned");
        fs::write(&file, b"ours").unwrap();
        let mut owned = Owned::new();
        owned.record_file(file.clone()).unwrap();
        fs::remove_file(&file).unwrap();
        fs::write(&file, b"foreign").unwrap();
        drop(owned);
        assert_eq!(fs::read(&file).unwrap(), b"foreign");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn creator_copy_publishes_manifest_last_and_preserves_source() {
        let root = std::env::temp_dir().join(format!("nas-create-{}", uuid::Uuid::new_v4()));
        for name in ["source", "target", "local"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let mut source = LocalProject::create(&root.join("source"), "original".into()).unwrap();
        for name in ["mono16.wav", "six.flac", "stereo.mp3"] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/audio")
                .join(name);
            let decoded =
                decode(&path, &root.join("pcm"), &AtomicBool::new(false), |_, _| {}).unwrap();
            let d = source.snapshot().unwrap().document;
            let snapshot = source
                .apply_change(
                    &d.project_id,
                    d.revision,
                    annotator_core::model::Change::ImportMedia {
                        media: decoded.descriptor.clone(),
                    },
                )
                .unwrap();
            source
                .save(&d.project_id, snapshot.document.revision)
                .unwrap();
        }
        let document = source.snapshot().unwrap().document;
        let original = std::fs::read(root.join("source/project.json")).unwrap();
        let profile = profiles::Profile::new("Alice").unwrap();
        let (created, repo) = crate::commands::collaboration::defaults::copy(
            &document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &profile,
            &AtomicBool::new(false),
            |_, _| assert!(!root.join("target/collaboration.json").exists()),
        )
        .unwrap()
        .commit();
        assert!(created.is_shared());
        let extensions = repo
            .manifest()
            .media
            .iter()
            .map(|m| {
                Path::new(&m.source_ref)
                    .extension()
                    .unwrap()
                    .to_str()
                    .unwrap()
            })
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(extensions, ["wav", "flac", "mp3"].into_iter().collect());
        for media in &repo.manifest().media {
            assert_eq!(
                fingerprint(
                    &repo.root().join(&media.source_ref),
                    &AtomicBool::new(false),
                    |_| {}
                )
                .unwrap(),
                media.sha256
            );
        }
        assert_ne!(repo.manifest().project_id, document.project_id);
        assert!(created.workspace().unwrap().actor().is_some());
        assert_eq!(
            std::fs::read(root.join("source/project.json")).unwrap(),
            original
        );
        drop((created, repo, source));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn real_media_copy_cancellation_failure_and_private_export_boundaries() {
        use annotator_core::model::{Change, Region, SpectralEdit};
        let root = std::env::temp_dir().join(format!("nas-media-create-{}", uuid::Uuid::new_v4()));
        for name in ["source", "target", "cancel", "failure", "local"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let mut source = LocalProject::create(&root.join("source"), "original".into()).unwrap();
        let audio = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio/mono16.wav")
            .canonicalize()
            .unwrap();
        let decoded = decode(
            &audio,
            &root.join("pcm"),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        let descriptor = decoded.descriptor.clone();
        let original_hash = descriptor.sha256.clone();
        let d = source.snapshot().unwrap().document;
        let next = source
            .apply_change(
                &d.project_id,
                d.revision,
                Change::ImportMedia {
                    media: descriptor.clone(),
                },
            )
            .unwrap();
        let next = source
            .apply_change(
                &d.project_id,
                next.document.revision,
                Change::AddEdit {
                    edit: SpectralEdit {
                        id: uuid::Uuid::new_v4().to_string(),
                        region: Region {
                            media_id: descriptor.id.clone(),
                            channel_index: 0,
                            start_seconds: 0.0,
                            end_seconds: descriptor.duration() / 2.0,
                            low_hz: 10.0,
                            high_hz: 100.0,
                        },
                        enabled: true,
                        processing_version: 2,
                        operation: annotator_core::model::EditOperation::Mask,
                    },
                },
            )
            .unwrap();
        source.save(&d.project_id, next.document.revision).unwrap();
        let document = source.snapshot().unwrap().document;
        let original = fs::read(root.join("source/project.json")).unwrap();
        let profile = profiles::Profile::new("Alice").unwrap();
        let cancel = AtomicBool::new(false);
        let result = crate::commands::collaboration::defaults::copy(
            &document,
            source.root(),
            &root.join("cancel"),
            &root.join("local"),
            &profile,
            &cancel,
            |phase, _| {
                if phase == "copyMedia" {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read_dir(root.join("cancel")).unwrap().count(), 0);
        let mut incorrect = document.clone();
        incorrect.media[0].sha256 = "0".repeat(64);
        assert!(crate::commands::collaboration::defaults::copy(
            &incorrect,
            source.root(),
            &root.join("failure"),
            &root.join("local"),
            &profile,
            &AtomicBool::new(false),
            |_, _| {}
        )
        .is_err());
        assert_eq!(fs::read_dir(root.join("failure")).unwrap().count(), 0);
        let (created, repo) = crate::commands::collaboration::defaults::copy(
            &document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &profile,
            &AtomicBool::new(false),
            |_, _| assert!(!root.join("target/collaboration.json").exists()),
        )
        .unwrap()
        .commit();
        assert_eq!(created.snapshot().unwrap().document.edits, document.edits);
        assert!(created.export_document().unwrap().edits.is_empty());
        let copied = root
            .join("target")
            .join(&repo.manifest().media[0].source_ref);
        assert_eq!(
            fingerprint(&copied, &AtomicBool::new(false), |_| {}).unwrap(),
            original_hash
        );
        assert_eq!(
            fs::read(root.join("source/project.json")).unwrap(),
            original
        );
        assert_eq!(
            fingerprint(&audio, &AtomicBool::new(false), |_| {}).unwrap(),
            original_hash
        );
        for forbidden in ["workspace.json", ".project.lock", "recovery.json"] {
            assert!(!root.join("target").join(forbidden).exists());
        }
        assert!(crate::commands::collaboration::defaults::copy(
            &document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &profile,
            &AtomicBool::new(false),
            |_, _| {}
        )
        .is_err());
        drop((created, repo, source, decoded));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unadopted_copy_rolls_back_only_owned_files_after_releasing_author_lease() {
        let root = std::env::temp_dir().join(format!("nas-rollback-{}", uuid::Uuid::new_v4()));
        for name in ["source", "target", "local"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let source = LocalProject::create(&root.join("source"), "original".into()).unwrap();
        let profile = profiles::Profile::new("Alice").unwrap();
        let prepared = crate::commands::collaboration::defaults::copy(
            &source.snapshot().unwrap().document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &profile,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        fs::write(root.join("target/media/foreign.txt"), b"not ours").unwrap();
        drop(prepared);
        assert!(!root.join("target/collaboration.json").exists());
        assert!(!root.join("target/authors").exists());
        assert!(!root.join("target/annotations").exists());
        assert_eq!(
            fs::read(root.join("target/media/foreign.txt")).unwrap(),
            b"not ours"
        );
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }
}
