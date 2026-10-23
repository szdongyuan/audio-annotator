use super::{
    operations::{reset_resources, Transition},
    runtime::{self, Expected},
};
use crate::{commands::project::info_shared, state::AppState};
use annotator_core::{
    collaboration::*,
    error::{AppError, Result},
    model::ProjectDocument,
    project::LocalProject,
};
use annotator_core::{
    error::ErrorCode,
    media::{
        decode::decode,
        identity::{check_cancel, fingerprint, SourceStamp},
        registry::same_identity,
    },
};
use serde::{Deserialize, Serialize};
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
struct Owned {
    files: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
    keep: bool,
}
impl Owned {
    fn new() -> Self {
        Self {
            files: vec![],
            dirs: vec![],
            keep: false,
        }
    }
    fn dir(&mut self, p: &Path) -> Result<()> {
        fs::create_dir(p).map_err(io)?;
        self.dirs.push(p.into());
        Ok(())
    }
    fn inventory(&mut self, root: &Path) -> Result<()> {
        for entry in fs::read_dir(root).map_err(io)? {
            let path = entry.map_err(io)?.path();
            atomic::safe_existing(&path)?;
            if path.is_dir() {
                self.dirs.push(path.clone());
                self.inventory(&path)?;
            } else {
                self.files.push(path);
            }
        }
        Ok(())
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.keep {
            for p in self.files.iter().rev() {
                let _ = fs::remove_file(p);
            }
            for p in self.dirs.iter().rev() {
                let _ = fs::remove_dir(p);
            }
        }
    }
}
// Field order releases the private cache and author lease before rollback touches owned files.
struct PreparedCopy {
    project: LocalProject,
    repo: Arc<CollaborationRepository>,
    owned: Owned,
}
impl PreparedCopy {
    fn commit(self) -> (LocalProject, Arc<CollaborationRepository>) {
        let Self {
            project,
            repo,
            mut owned,
        } = self;
        owned.keep = true;
        (project, repo)
    }
}

fn copy_project(
    document: &ProjectDocument,
    source: &Path,
    target: &Path,
    local: &Path,
    credentials: &Credentials,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64),
) -> Result<PreparedCopy> {
    check_cancel(cancel)?;
    atomic::safe_existing(target)?;
    let target = target.canonicalize().map_err(io)?;
    if fs::read_dir(&target).map_err(io)?.next().is_some() {
        return Err(AppError::invalid("Select an empty collaboration directory"));
    }
    let stage = target.join(format!(".create-{}", uuid::Uuid::new_v4()));
    let mut staged = Owned::new();
    staged.dir(&stage)?;
    for name in ["media", "accounts", "annotations"] {
        staged.dir(&stage.join(name))?;
    }
    let mut manifest = CollaborationManifest {
        kind: MANIFEST_KIND.into(),
        format_version: 1,
        project_id: uuid::Uuid::new_v4().to_string(),
        name: document.name.clone(),
        created_at: document.created_at.clone(),
        media: vec![],
    };
    for media in &document.media {
        check_cancel(cancel)?;
        let path = Path::new(&media.source_ref);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            source.join(path)
        };
        let stamp = SourceStamp::read(&path)?;
        let decoded = decode(
            &path,
            &std::env::temp_dir().join("audio-annotator-pcm"),
            cancel,
            |phase, n| progress(phase, n),
        )?;
        if !same_identity(media, &decoded.descriptor) {
            return Err(AppError::new(
                ErrorCode::IdentityMismatch,
                "Source media identity changed",
            ));
        }
        let mut input = fs::File::open(&path).map_err(io)?;
        let mut magic = [0u8; 12];
        let read = input.read(&mut magic).map_err(io)?;
        let ext = if read >= 12 && &magic[..4] == b"RIFF" && &magic[8..12] == b"WAVE" {
            "wav"
        } else if read >= 4 && &magic[..4] == b"fLaC" {
            "flac"
        } else {
            "mp3"
        };
        let relative = format!("media/{}.{}", media.id, ext);
        let copied = stage.join(&relative);
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&copied)
            .map_err(io)?;
        staged.files.push(copied.clone());
        let mut input = fs::File::open(&path).map_err(io)?;
        let mut buffer = [0u8; 65536];
        let mut count = 0;
        loop {
            check_cancel(cancel)?;
            let n = input.read(&mut buffer).map_err(io)?;
            if n == 0 {
                break;
            }
            output.write_all(&buffer[..n]).map_err(io)?;
            count += n as u64;
            progress("copyMedia", count);
        }
        output.sync_all().map_err(io)?;
        drop(output);
        stamp.verify(&path)?;
        if count != media.byte_length || fingerprint(&copied, cancel, |_| {})? != media.sha256 {
            return Err(AppError::new(
                ErrorCode::IdentityMismatch,
                "Copied media fingerprint mismatch",
            ));
        }
        manifest.media.push(PublicMedia {
            id: media.id.clone(),
            display_name: media.display_name.clone(),
            source_ref: relative,
            sha256: media.sha256.clone(),
            byte_length: media.byte_length,
            sample_rate: media.sample_rate,
            frame_count: media.frame_count,
            channel_count: media.channel_count,
            channel_layout: media.channel_layout.clone(),
        });
    }
    manifest.validate()?;
    let bytes = serde_json::to_vec(&manifest).map_err(|_| runtime::unavailable())?;
    atomic::publish_new(
        &stage.join("collaboration.json"),
        &bytes,
        None,
        Some(cancel),
    )?;
    staged.files.push(stage.join("collaboration.json"));
    let preparation = (|| {
        let repo = CollaborationRepository::open(&stage)?;
        repo.register(
            &credentials.login,
            &credentials.display_name,
            &credentials.password,
        )?;
        check_cancel(cancel)?;
        let actor = repo.login(&credentials.login, &credentials.password)?;
        repo.publish(&actor, None, &LayerPayload::from_document(document)?)?;
        Ok(())
    })();
    // Capture every file created by registration/publication even on failure.
    staged.inventory(&stage)?;
    preparation?;
    check_cancel(cancel)?;
    if fs::read_dir(&target).map_err(io)?.count() != 1 {
        return Err(AppError::invalid("Target changed during creation"));
    }
    let mut published = Owned::new();
    for name in ["media", "accounts", "annotations"] {
        atomic::safe_existing(&target)?;
        let dest = target.join(name);
        // create_dir is a no-clobber reservation. Transfer each owned file individually.
        published.dir(&dest)?;
        transfer(&stage.join(name), &dest, &mut published, cancel)?;
    }
    for media in &manifest.media {
        let path = target.join(&media.source_ref);
        if SourceStamp::read(&path)?.bytes != media.byte_length
            || fingerprint(&path, cancel, |_| {})? != media.sha256
        {
            return Err(AppError::new(
                ErrorCode::IdentityMismatch,
                "Final media fingerprint mismatch",
            ));
        }
    }
    progress("publishManifest", manifest.media.len() as u64);
    atomic::publish_new(
        &target.join("collaboration.json"),
        &bytes,
        None,
        Some(cancel),
    )?;
    published.files.push(target.join("collaboration.json"));
    let repo = Arc::new(CollaborationRepository::open(&target)?);
    // Capabilities are bound to the canonical root. Authenticate again after relocation.
    let actor = Arc::new(repo.login(&credentials.login, &credentials.password)?);
    let mut project = LocalProject::open_shared(repo.clone(), Some(actor), local)?;
    let mut private = document.clone();
    private.project_id = manifest.project_id.clone();
    private.revision = private.revision.max(project.snapshot()?.document.revision);
    for media in &mut private.media {
        media.source_ref = manifest
            .media
            .iter()
            .find(|m| m.id == media.id)
            .ok_or_else(runtime::stale)?
            .source_ref
            .clone();
    }
    project.initialize_shared_private(private)?;
    Ok(PreparedCopy {
        project,
        repo,
        owned: published,
    })
}
fn transfer(from: &Path, to: &Path, owned: &mut Owned, cancel: &AtomicBool) -> Result<()> {
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
            owned.files.push(dest);
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credentials {
    pub login: String,
    pub display_name: String,
    pub password: String,
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
    credentials: Credentials,
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
        let prepared = copy_project(
            &document,
            &root,
            Path::new(&target),
            &state.6.local()?,
            &credentials,
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
        let credentials = Credentials {
            login: "alice".into(),
            display_name: "Alice".into(),
            password: "password123".into(),
        };
        let (created, repo) = copy_project(
            &document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &credentials,
            &AtomicBool::new(false),
            |_, _| assert!(!root.join("target/collaboration.json").exists()),
        )
        .unwrap()
        .commit();
        assert!(created.is_shared());
        assert_eq!(
            repo.manifest()
                .media
                .iter()
                .map(|m| Path::new(&m.source_ref)
                    .extension()
                    .unwrap()
                    .to_str()
                    .unwrap())
                .collect::<Vec<_>>(),
            vec!["wav", "flac", "mp3"]
        );
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
                        processing_version: 1,
                    },
                },
            )
            .unwrap();
        source.save(&d.project_id, next.document.revision).unwrap();
        let document = source.snapshot().unwrap().document;
        let original = fs::read(root.join("source/project.json")).unwrap();
        let credentials = Credentials {
            login: "alice".into(),
            display_name: "Alice".into(),
            password: "password123".into(),
        };
        let cancel = AtomicBool::new(false);
        let result = copy_project(
            &document,
            source.root(),
            &root.join("cancel"),
            &root.join("local"),
            &credentials,
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
        assert!(copy_project(
            &incorrect,
            source.root(),
            &root.join("failure"),
            &root.join("local"),
            &credentials,
            &AtomicBool::new(false),
            |_, _| {}
        )
        .is_err());
        assert_eq!(fs::read_dir(root.join("failure")).unwrap().count(), 0);
        let (created, repo) = copy_project(
            &document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &credentials,
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
        assert!(copy_project(
            &document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &credentials,
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
        let credentials = Credentials {
            login: "alice".into(),
            display_name: "Alice".into(),
            password: "password123".into(),
        };
        let prepared = copy_project(
            &source.snapshot().unwrap().document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &credentials,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        fs::write(root.join("target/media/foreign.txt"), b"not ours").unwrap();
        drop(prepared);
        assert!(!root.join("target/collaboration.json").exists());
        assert!(!root.join("target/accounts").exists());
        assert!(!root.join("target/annotations").exists());
        assert_eq!(
            fs::read(root.join("target/media/foreign.txt")).unwrap(),
            b"not ours"
        );
        drop(source);
        fs::remove_dir_all(root).unwrap();
    }
}
