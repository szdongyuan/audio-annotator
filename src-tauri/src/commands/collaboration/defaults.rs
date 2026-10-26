use super::{
    creation::{transfer, Owned, PreparedCopy},
    operations::reset_resources,
    runtime,
};
use crate::{
    commands::project::{info_shared, OpenProject},
    state::AppState,
};
use annotator_core::{
    collaboration::*,
    error::{AppError, Result},
    media::identity::check_cancel,
    project::LocalProject,
};
use std::{
    fs,
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

pub(super) fn empty(
    target: &Path,
    name: &str,
    local: &Path,
    identity: &profiles::Profile,
    cancel: &AtomicBool,
) -> Result<PreparedCopy> {
    atomic::safe_existing(target)?;
    let target = target
        .canonicalize()
        .map_err(|_| AppError::invalid("Invalid target"))?;
    if fs::read_dir(&target)
        .map_err(|_| runtime::unavailable())?
        .next()
        .is_some()
    {
        return Err(AppError::invalid("Select an empty directory"));
    }
    if target
        .ancestors()
        .any(|p| p.join("collaboration.json").exists() || p.join("project.json").exists())
    {
        return Err(AppError::invalid("Create outside an existing project"));
    }
    let mut stage = Owned::new();
    let staging = target.join(format!(".create-{}", uuid::Uuid::new_v4()));
    stage.dir(&staging)?;
    let result = CollaborationRepository::create_default(&staging, name, identity);
    stage.inventory(&staging)?;
    let (repo, actor) = result?;
    drop((repo, actor));
    check_cancel(cancel)?;
    let bytes = fs::read(staging.join("collaboration.json")).map_err(|_| runtime::unavailable())?;
    let mut owned = Owned::new();
    for name in ["media", "authors", "annotations", "catalog"] {
        owned.dir(&target.join(name))?;
        transfer(&staging.join(name), &target.join(name), &mut owned, cancel)?;
    }
    atomic::publish_new(
        &target.join("collaboration.json"),
        &bytes,
        None,
        Some(cancel),
    )?;
    // Inventory only the exact final file; directories were already recorded.
    owned.record_file(target.join("collaboration.json"))?;
    let repo = Arc::new(CollaborationRepository::open(&target)?);
    let actor = Arc::new(repo.adopt(identity)?);
    let project = LocalProject::open_shared(repo.clone(), Some(actor), local)?;
    Ok(PreparedCopy {
        project,
        repo,
        owned,
    })
}
pub(super) fn copy(
    document: &annotator_core::model::ProjectDocument,
    source: &Path,
    target: &Path,
    local: &Path,
    identity: &profiles::Profile,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64),
) -> Result<PreparedCopy> {
    atomic::safe_existing(target)?;
    let target = target.canonicalize().map_err(|_| runtime::unavailable())?;
    let source = source.canonicalize().map_err(|_| runtime::unavailable())?;
    if target.starts_with(&source)
        || source.starts_with(&target)
        || target
            .ancestors()
            .any(|p| p.join("collaboration.json").exists() || p.join("project.json").exists())
    {
        return Err(AppError::invalid(
            "Choose a target outside the current project",
        ));
    }
    if fs::read_dir(&target)
        .map_err(|_| runtime::unavailable())?
        .next()
        .is_some()
    {
        return Err(AppError::invalid("Select an empty directory"));
    }
    let staging = target.join(format!(".create-{}", uuid::Uuid::new_v4()));
    let mut staged = Owned::new();
    staged.dir(&staging)?;
    let result = (|| {
        let (repo, actor) =
            CollaborationRepository::create_default(&staging, &document.name, identity)?;
        for media in &document.media {
            check_cancel(cancel)?;
            let path = Path::new(&media.source_ref);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                source.join(path)
            };
            let prepared = repo.prepare_media_copy(
                &path,
                &std::env::temp_dir().join("audio-annotator-pcm"),
                cancel,
                media,
                &mut progress,
            )?;
            repo.append_media(&actor, &prepared, cancel)?;
        }
        let repo = repo.reload_catalog()?;
        repo.publish(&actor, None, &LayerPayload::from_document(document)?)?;
        Ok(())
    })();
    staged.inventory(&staging)?;
    result?;
    check_cancel(cancel)?;
    if fs::read_dir(&target)
        .map_err(|_| runtime::unavailable())?
        .count()
        != 1
    {
        return Err(AppError::invalid("Target changed during creation"));
    }
    let bytes = fs::read(staging.join("collaboration.json")).map_err(|_| runtime::unavailable())?;
    let mut owned = Owned::new();
    for name in ["media", "authors", "annotations", "catalog"] {
        owned.dir(&target.join(name))?;
        transfer(&staging.join(name), &target.join(name), &mut owned, cancel)?;
    }
    // Publication exposes only final bytes reverified after the staging transfer.
    let staged_repo = CollaborationRepository::open(&staging)?;
    for public in &staged_repo.manifest().media {
        if annotator_core::media::identity::fingerprint(
            &target.join(&public.source_ref),
            cancel,
            |_| {},
        )? != public.sha256
        {
            return Err(AppError::invalid("Final copied media fingerprint mismatch"));
        }
    }
    progress("publishManifest", document.media.len() as u64);
    atomic::publish_new(
        &target.join("collaboration.json"),
        &bytes,
        None,
        Some(cancel),
    )?;
    owned.record_file(target.join("collaboration.json"))?;
    let repo = Arc::new(CollaborationRepository::open(&target)?);
    let actor = Arc::new(repo.adopt(identity)?);
    let mut project = LocalProject::open_shared(repo.clone(), Some(actor), local)?;
    let mut private = document.clone();
    private.project_id = repo.manifest().project_id.clone();
    private.created_at = repo.manifest().created_at.clone();
    private.updated_at = private.updated_at.max(private.created_at.clone());
    private.revision = private.revision.max(project.snapshot()?.document.revision);
    for media in &mut private.media {
        media.source_ref = repo
            .manifest()
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
        owned,
    })
}
pub async fn save_as(
    state: &AppState,
    runtime_nonce: Option<String>,
    path: String,
    project_id: String,
    expected_revision: u64,
) -> Result<OpenProject> {
    save_as_controlled(
        state,
        runtime_nonce,
        path,
        project_id,
        expected_revision,
        None,
        None,
    )
    .await
}
pub async fn save_as_controlled(
    state: &AppState,
    runtime_nonce: Option<String>,
    path: String,
    project_id: String,
    expected_revision: u64,
    operation_id: Option<String>,
    on_progress: Option<tauri::ipc::Channel<super::creation::CopyProgress>>,
) -> Result<OpenProject> {
    let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err(AppError::invalid("Invalid copy operation ID"));
    }
    let permit = state.6.begin(operation_id.clone())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (expected, document, root, preferences, hidden) = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let p = current.as_ref().ok_or_else(runtime::stale)?;
            runtime::check_mutation(p, &state.6, runtime_nonce.as_deref())?;
            let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            let expected = runtime::Expected {
                runtime_nonce: r.nonce.clone(),
                project_id,
                expected_revision,
            };
            // Save As is also the recovery path after source persistence fails.
            // Capture the current revision, without requiring a source save.
            expected.check(p, &r, false)?;
            (
                expected,
                p.snapshot()?.document,
                p.root().to_path_buf(),
                p.workspace().ok().map(|w| w.preferences().clone()),
                p.workspace()
                    .ok()
                    .map(|w| w.hidden_media_ids().to_vec())
                    .unwrap_or_default(),
            )
        };
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let mut last_phase = String::new();
        let mut prepared = copy(
            &document,
            &root,
            Path::new(&path),
            &state.6.local()?,
            &state.6.selected_profile()?,
            &permit.cancel,
            |phase, completed| {
                if let Some(channel) = on_progress.as_ref() {
                    if phase != last_phase
                        || last.elapsed() >= std::time::Duration::from_millis(100)
                    {
                        last = std::time::Instant::now();
                        last_phase = phase.to_owned();
                        if channel
                            .send(super::creation::CopyProgress {
                                operation_id: operation_id.clone(),
                                phase: phase.into(),
                                completed,
                            })
                            .is_err()
                        {
                            permit
                                .cancel
                                .store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }
                }
            },
        )?;
        if let Some(preferences) = preferences {
            prepared
                .project
                .workspace_mut()?
                .save_preferences(preferences)?;
        }
        prepared
            .project
            .workspace_mut()?
            .set_hidden_media_ids(hidden)?;
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        expected.check(
            current.as_ref().ok_or_else(runtime::stale)?,
            &*state.6.current.lock().map_err(|_| runtime::unavailable())?,
            false,
        )?;
        check_cancel(&permit.cancel)?;
        reset_resources(&state)?;
        let (project, repo) = prepared.commit();
        state.6.install(Some(repo))?;
        let opened = info_shared(&project, &state.6)?;
        *current = Some(project);
        Ok(opened)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
pub async fn create(state: &AppState, path: String, name: String) -> Result<OpenProject> {
    let permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let nonce = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            if current.is_some() {
                return Err(runtime::stale());
            }
            state
                .6
                .current
                .lock()
                .map_err(|_| runtime::unavailable())?
                .nonce
                .clone()
        };
        let prepared = empty(
            Path::new(&path),
            &name,
            &state.6.local()?,
            &state.6.selected_profile()?,
            &permit.cancel,
        )?;
        #[cfg(test)]
        state.6.run_hook();
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        check_cancel(&permit.cancel)?;
        if current.is_some()
            || state
                .6
                .current
                .lock()
                .map_err(|_| runtime::unavailable())?
                .nonce
                != nonce
        {
            return Err(runtime::stale());
        }
        reset_resources(&state)?;
        let (project, repo) = prepared.commit();
        state.6.install(Some(repo))?;
        let opened = info_shared(&project, &state.6)?;
        *current = Some(project);
        Ok(opened)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn open_project_view_only(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<OpenProject> {
    super::operations::open_mode(&state, path, true).await
}

#[cfg(test)]
mod tests {
    use crate::{
        commands::collaboration::{operations::*, runtime::Expected},
        state::AppState,
    };
    use std::fs;
    fn expected(s: &AppState) -> Expected {
        let c = s.0.lock().unwrap();
        let d = c.as_ref().unwrap().snapshot().unwrap().document;
        Expected {
            runtime_nonce: s.6.current.lock().unwrap().nonce.clone(),
            project_id: d.project_id,
            expected_revision: d.revision,
        }
    }
    #[test]
    fn prepared_import_events_folder_scan_and_retired_runtime_are_safe() {
        use std::{sync::mpsc, time::Duration};
        let root = std::env::temp_dir().join(format!("native-prepare-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(super::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Prepared".into(),
        ))
        .unwrap();
        let audio = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio/mono16.wav")
            .canonicalize()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let e = expected(&state);
        tauri::async_runtime::block_on(crate::commands::media::start(
            &state,
            Some(e.runtime_nonce.clone()),
            e.project_id.clone(),
            vec![audio.to_string_lossy().into()],
            None,
            tauri::ipc::Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                    tx.send(serde_json::from_str::<serde_json::Value>(&json).unwrap())
                        .unwrap();
                }
                Ok(())
            }),
        ))
        .unwrap();
        let mut ready = None;
        loop {
            let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if event["type"] == "ready" {
                ready = Some(
                    serde_json::from_value::<annotator_core::model::MediaDescriptor>(
                        event["media"].clone(),
                    )
                    .unwrap(),
                );
            }
            if event["type"] == "finished" {
                break;
            }
        }
        let ready = ready.expect("real prepare emits Ready");
        let admitted = expected(&state);
        let imported = tauri::async_runtime::block_on(super::super::catalog::import(
            &state,
            admitted.clone(),
            ready.clone(),
        ))
        .unwrap();
        assert_eq!(imported.document.media[0].id, ready.id);
        // Lost IPC acknowledgement retries the old revision, retaining the sealed UUID.
        assert_eq!(
            tauri::async_runtime::block_on(super::super::catalog::import(
                &state,
                admitted,
                ready.clone()
            ))
            .unwrap()
            .document,
            imported.document
        );
        let (tx, rx) = mpsc::channel();
        let e = expected(&state);
        tauri::async_runtime::block_on(crate::commands::folders::start(
            &state,
            Some(e.runtime_nonce),
            e.project_id,
            audio.parent().unwrap().to_string_lossy().into(),
            false,
            tauri::ipc::Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                    tx.send(serde_json::from_str::<serde_json::Value>(&json).unwrap())
                        .unwrap();
                }
                Ok(())
            }),
        ))
        .unwrap();
        let mut completed = false;
        for _ in 0..10 {
            let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if event["type"] == "result" {
                completed = true;
                break;
            }
            if event["type"] == "failed" {
                panic!("{event}");
            }
        }
        assert!(completed);
        let stale = expected(&state);
        {
            let mut current = state.0.lock().unwrap();
            let p = current.as_mut().unwrap();
            p.workspace_mut()
                .unwrap()
                .set_media_hidden(&ready.id, true)
                .unwrap();
            p.workspace_mut()
                .unwrap()
                .save_preferences(annotator_core::collaboration::PlaybackPreferences {
                    volume: 0.35,
                    ..Default::default()
                })
                .unwrap();
        }
        fs::create_dir(root.join("copy")).unwrap();
        tauri::async_runtime::block_on(super::save_as(
            &state,
            Some(stale.runtime_nonce.clone()),
            root.join("copy").to_string_lossy().into(),
            stale.project_id.clone(),
            stale.expected_revision,
        ))
        .unwrap();
        {
            let current = state.0.lock().unwrap();
            let workspace = current.as_ref().unwrap().workspace().unwrap();
            assert_eq!(
                workspace.hidden_media_ids(),
                std::slice::from_ref(&ready.id)
            );
            assert_eq!(workspace.preferences().volume, 0.35);
        }
        assert!(
            tauri::async_runtime::block_on(super::super::catalog::import(
                &state,
                stale.clone(),
                ready.clone()
            ))
            .is_err()
        );
        *state.0.lock().unwrap() = None;
        state.6.retire();
        assert!(
            tauri::async_runtime::block_on(super::super::catalog::import(&state, stale, ready))
                .is_err()
        );
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn saved_background_publication_holds_bounded_admission_then_save_as_retries() {
        use std::{sync::mpsc, time::Duration};
        let root = std::env::temp_dir().join(format!("native-save-as-{}", uuid::Uuid::new_v4()));
        for d in ["project", "target"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(super::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Saved".into(),
        ))
        .unwrap();
        {
            let mut c = state.0.lock().unwrap();
            let p = c.as_mut().unwrap();
            let d = p.snapshot().unwrap().document;
            let n = p
                .apply_change(
                    &d.project_id,
                    d.revision,
                    annotator_core::model::Change::AddCategory {
                        category: annotator_core::model::Category {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: "saved draft".into(),
                            color: "#aabbcc".into(),
                        },
                    },
                )
                .unwrap();
            p.save(&d.project_id, n.document.revision).unwrap();
        }
        let (enter, arrival) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        *state.6.hook.lock().unwrap() = Some(Box::new(move || {
            enter.send(()).unwrap();
            wait.recv().unwrap();
        }));
        super::super::operations::schedule(state.clone());
        arrival.recv_timeout(Duration::from_secs(10)).unwrap();
        let e = expected(&state);
        let error = tauri::async_runtime::block_on(super::save_as(
            &state,
            Some(e.runtime_nonce.clone()),
            root.join("target").to_string_lossy().into(),
            e.project_id.clone(),
            e.expected_revision,
        ))
        .err()
        .unwrap();
        assert_eq!(error.code, annotator_core::error::ErrorCode::ResourceLimit);
        assert!(error.retryable);
        assert_eq!(error.details.unwrap()["operationBusy"], true);
        assert_eq!(fs::read_dir(root.join("target")).unwrap().count(), 0);
        release.send(()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while state.6.busy() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        tauri::async_runtime::block_on(super::save_as(
            &state,
            Some(e.runtime_nonce),
            root.join("target").to_string_lossy().into(),
            e.project_id.clone(),
            e.expected_revision,
        ))
        .unwrap();
        let d = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document;
        assert_ne!(d.project_id, e.project_id);
        assert_eq!(d.categories[0].name, "saved draft");
        assert!(root.join("project/collaboration.json").exists());
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn parallel_actor_imports_and_post_commit_retirement_report_durable_identity() {
        use std::sync::{Arc, Barrier};
        let root = std::env::temp_dir().join(format!("native-parallel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        let a = AppState::default();
        a.6.set_local(root.join("a")).unwrap();
        tauri::async_runtime::block_on(super::create(
            &a,
            root.join("project").to_string_lossy().into(),
            "Parallel".into(),
        ))
        .unwrap();
        let b = AppState::default();
        b.6.set_local(root.join("b")).unwrap();
        tauri::async_runtime::block_on(open(&b, root.join("project").to_string_lossy().into()))
            .unwrap();
        let audio = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio/mono16.wav")
            .canonicalize()
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let mut workers = vec![];
        for state in [&a, &b] {
            let repo = state.6.current.lock().unwrap().repo.clone().unwrap();
            let prepared = repo
                .prepare_media(
                    &audio,
                    &root.join("pcm"),
                    &std::sync::atomic::AtomicBool::new(false),
                )
                .unwrap();
            let descriptor = prepared.decoded().descriptor.clone();
            super::super::catalog::store_prepared(
                &state.6,
                &expected(state).runtime_nonce,
                "task",
                prepared,
            )
            .unwrap();
            let barrier = barrier.clone();
            let state = state.clone();
            let e = expected(&state);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                tauri::async_runtime::block_on(super::super::catalog::import(&state, e, descriptor))
                    .unwrap()
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let repo =
            a.6.current
                .lock()
                .unwrap()
                .repo
                .clone()
                .unwrap()
                .reload_catalog()
                .unwrap();
        assert_eq!(repo.manifest().media.len(), 2);
        assert_ne!(repo.manifest().media[0].id, repo.manifest().media[1].id);
        let prepared = repo
            .prepare_media(
                &audio,
                &root.join("pcm"),
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        let descriptor = prepared.decoded().descriptor.clone();
        super::super::catalog::store_prepared(
            &a.6,
            &expected(&a).runtime_nonce,
            "retire",
            prepared,
        )
        .unwrap();
        let retired = a.clone();
        *a.6.after_io.lock().unwrap() = Some(Box::new(move || {
            *retired.0.lock().unwrap() = None;
            retired.6.retire();
        }));
        let error = tauri::async_runtime::block_on(super::super::catalog::import(
            &a,
            expected(&a),
            descriptor.clone(),
        ))
        .err()
        .unwrap();
        assert_eq!(error.details.unwrap()["catalogCommitted"], true);
        assert!(a.0.lock().unwrap().is_none());
        assert!(repo
            .reload_catalog()
            .unwrap()
            .manifest()
            .media
            .iter()
            .any(|m| m.id == descriptor.id));
        drop((a, b, repo));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retired_default_creation_rolls_back_its_target() {
        let root =
            std::env::temp_dir().join(format!("native-create-stale-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        let service = state.6.clone();
        *state.6.hook.lock().unwrap() = Some(Box::new(move || service.retire()));
        assert!(tauri::async_runtime::block_on(super::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Stale".into()
        ))
        .is_err());
        assert!(state.0.lock().unwrap().is_none());
        assert_eq!(fs::read_dir(root.join("project")).unwrap().count(), 0);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn default_copy_preserves_media_ids_and_personal_state() {
        use annotator_core::{
            media::decode::decode,
            model::{Change, Region, SpectralEdit},
            project::LocalProject,
        };
        let root = std::env::temp_dir().join(format!("default-copy-{}", uuid::Uuid::new_v4()));
        for d in ["source", "target", "local"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let mut source = LocalProject::create(&root.join("source"), "Original".into()).unwrap();
        let audio = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio/mono16.wav")
            .canonicalize()
            .unwrap();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let decoded = decode(&audio, &root.join("pcm"), &cancel, |_, _| {}).unwrap();
        let d = source.snapshot().unwrap().document;
        let n = source
            .apply_change(
                &d.project_id,
                d.revision,
                Change::ImportMedia {
                    media: decoded.descriptor.clone(),
                },
            )
            .unwrap();
        let n = source
            .apply_change(
                &d.project_id,
                n.document.revision,
                Change::AddEdit {
                    edit: SpectralEdit {
                        id: uuid::Uuid::new_v4().to_string(),
                        region: Region {
                            media_id: decoded.descriptor.id.clone(),
                            channel_index: 0,
                            start_seconds: 0.0,
                            end_seconds: 0.01,
                            low_hz: 10.0,
                            high_hz: 100.0,
                        },
                        enabled: true,
                        processing_version: 1,
                    },
                },
            )
            .unwrap();
        let (copy, repo) = super::copy(
            &n.document,
            source.root(),
            &root.join("target"),
            &root.join("local"),
            &annotator_core::collaboration::profiles::Profile::new("Copy").unwrap(),
            &cancel,
            |_, _| {},
        )
        .unwrap()
        .commit();
        assert_eq!(
            repo.manifest().format_version,
            annotator_core::collaboration::CURRENT_COLLABORATION_FORMAT
        );
        assert_ne!(repo.manifest().project_id, d.project_id);
        assert_eq!(copy.snapshot().unwrap().document.edits, n.document.edits);
        assert_eq!(repo.manifest().media[0].id, decoded.descriptor.id);
        assert!(copy.export_document().unwrap().edits.is_empty());
        drop((copy, repo, source, decoded));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn catalog_import_and_poll_requires_explicit_adoption() {
        use annotator_core::model::{Category, Change};
        let root = std::env::temp_dir().join(format!("catalog-native-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        let a = AppState::default();
        a.6.set_local(root.join("a")).unwrap();
        tauri::async_runtime::block_on(super::create(
            &a,
            root.join("project").to_string_lossy().into(),
            "Test".into(),
        ))
        .unwrap();
        let b = AppState::default();
        b.6.set_local(root.join("b")).unwrap();
        tauri::async_runtime::block_on(open(&b, root.join("project").to_string_lossy().into()))
            .unwrap();
        let expected = |s: &AppState| {
            let p = s.0.lock().unwrap();
            let d = p.as_ref().unwrap().snapshot().unwrap().document;
            Expected {
                runtime_nonce: s.6.current.lock().unwrap().nonce.clone(),
                project_id: d.project_id,
                expected_revision: d.revision,
            }
        };
        let repo = a.6.current.lock().unwrap().repo.clone().unwrap();
        let audio = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio/mono16.wav")
            .canonicalize()
            .unwrap();
        let prepared = repo
            .prepare_media(
                &audio,
                &root.join("pcm"),
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        let descriptor = prepared.decoded().descriptor.clone();
        {
            let mut c = a.0.lock().unwrap();
            let p = c.as_mut().unwrap();
            let d = p.snapshot().unwrap().document;
            let n = p
                .apply_change(
                    &d.project_id,
                    d.revision,
                    Change::AddCategory {
                        category: Category {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: "prior remote".into(),
                            color: "#aabbcc".into(),
                        },
                    },
                )
                .unwrap();
            p.save(&d.project_id, n.document.revision).unwrap();
        }
        tauri::async_runtime::block_on(refresh(&a, expected(&a))).unwrap();
        tauri::async_runtime::block_on(refresh(&b, expected(&b))).unwrap();
        super::super::catalog::store_prepared(&a.6, &expected(&a).runtime_nonce, "task", prepared)
            .unwrap();
        let mut forged = descriptor.clone();
        forged.display_name = "forged".into();
        assert!(
            tauri::async_runtime::block_on(super::super::catalog::import(&a, expected(&a), forged))
                .is_err()
        );
        let snapshot = tauri::async_runtime::block_on(super::super::catalog::import(
            &a,
            expected(&a),
            descriptor.clone(),
        ))
        .unwrap();
        assert_eq!(snapshot.document.media[0].id, descriptor.id);
        let retry = tauri::async_runtime::block_on(super::super::catalog::import(
            &a,
            expected(&a),
            descriptor,
        ))
        .unwrap();
        assert_eq!(retry.document.revision, snapshot.document.revision);
        let media_id = &snapshot.document.media[0].id;
        super::super::catalog::release(&a.6, "wrong-task", media_id).unwrap();
        assert!(a.6.prepared.lock().unwrap().contains_key(media_id));
        super::super::catalog::release(&a.6, "task", media_id).unwrap();
        assert!(!a.6.prepared.lock().unwrap().contains_key(media_id));
        assert!(repo
            .root()
            .join(&snapshot.document.media[0].source_ref)
            .exists());
        // Publish a full new-media author payload while the other client still has no catalog.
        {
            let mut c = a.0.lock().unwrap();
            let p = c.as_mut().unwrap();
            let d = p.snapshot().unwrap().document;
            let n = p
                .apply_change(
                    &d.project_id,
                    d.revision,
                    Change::AddCategory {
                        category: Category {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: "remote".into(),
                            color: "#aabbcc".into(),
                        },
                    },
                )
                .unwrap();
            p.save(&d.project_id, n.document.revision).unwrap();
        }
        tauri::async_runtime::block_on(refresh(&a, expected(&a))).unwrap();
        let before = expected(&b);
        let status = tauri::async_runtime::block_on(refresh(&b, before.clone())).unwrap();
        assert!(status
            .snapshot
            .as_ref()
            .unwrap()
            .authors
            .iter()
            .all(|a| a.error.is_none()));
        assert!(status.catalog_pending);
        assert!(b
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document
            .media
            .is_empty());
        {
            let mut current = b.0.lock().unwrap();
            let p = current.as_mut().unwrap();
            let d = p.snapshot().unwrap().document;
            let n = p
                .apply_change(
                    &d.project_id,
                    d.revision,
                    Change::AddCategory {
                        category: Category {
                            id: uuid::Uuid::new_v4().to_string(),
                            name: "draft".into(),
                            color: "#aabbcc".into(),
                        },
                    },
                )
                .unwrap();
            p.save(&d.project_id, n.document.revision).unwrap();
        }
        tauri::async_runtime::block_on(super::super::catalog::adopt(
            &b,
            expected(&b),
            "adopt".into(),
        ))
        .unwrap();
        let d =
            b.0.lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .snapshot()
                .unwrap()
                .document;
        assert_eq!(d.media.len(), 1);
        assert_eq!(d.categories[0].name, "draft");
        assert!(tauri::async_runtime::block_on(super::super::catalog::adopt(
            &b,
            before,
            "stale".into()
        ))
        .is_err());
        drop((a, b, repo));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn default_create_reopen_identity_switch_and_explicit_view_only() {
        let root = std::env::temp_dir().join(format!("default-native-{}", uuid::Uuid::new_v4()));
        for d in ["project", "local", "other"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(super::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Default".into(),
        ))
        .unwrap();
        let status = tauri::async_runtime::block_on(status(&state)).unwrap();
        assert_eq!(
            serde_json::to_value(&status).unwrap()["projectFlavor"],
            "default"
        );
        assert_eq!(
            serde_json::to_value(&status).unwrap()["identityMode"],
            "profile"
        );
        let actor = status.actor.unwrap().author_id;
        assert!(!root.join("project/project.json").exists());
        let second = AppState::default();
        second.6.set_local(root.join("local")).unwrap();
        assert!(tauri::async_runtime::block_on(open(
            &second,
            root.join("project").to_string_lossy().into()
        ))
        .is_err());
        tauri::async_runtime::block_on(open_mode(
            &second,
            root.join("project").to_string_lossy().into(),
            true,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(
                tauri::async_runtime::block_on(super::super::operations::status(&second)).unwrap()
            )
            .unwrap()["identityMode"],
            "viewOnly"
        );
        drop(second);
        let expected = |s: &AppState| {
            let c = s.0.lock().unwrap();
            let d = c.as_ref().unwrap().snapshot().unwrap().document;
            Expected {
                runtime_nonce: s.6.current.lock().unwrap().nonce.clone(),
                project_id: d.project_id,
                expected_revision: d.revision,
            }
        };
        tauri::async_runtime::block_on(
            crate::commands::collaboration::test_profiles::select_named(
                &state,
                expected(&state),
                "register".into(),
                Some("alice"),
            ),
        )
        .unwrap();
        assert_ne!(
            tauri::async_runtime::block_on(super::super::operations::status(&state))
                .unwrap()
                .actor
                .unwrap()
                .author_id,
            actor
        );
        tauri::async_runtime::block_on(
            crate::commands::collaboration::test_profiles::select_named(
                &state,
                expected(&state),
                "logout".into(),
                None,
            ),
        )
        .unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(super::super::operations::status(&state))
                .unwrap()
                .actor
                .unwrap()
                .author_id,
            actor
        );
        drop(state);
        let reopened = AppState::default();
        reopened.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(open(
            &reopened,
            root.join("project").to_string_lossy().into(),
        ))
        .unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(super::super::operations::status(&reopened))
                .unwrap()
                .actor
                .unwrap()
                .author_id,
            actor
        );
        let other = AppState::default();
        other.6.set_local(root.join("other")).unwrap();
        tauri::async_runtime::block_on(open(&other, root.join("project").to_string_lossy().into()))
            .unwrap();
        assert_ne!(
            tauri::async_runtime::block_on(super::super::operations::status(&other))
                .unwrap()
                .actor
                .unwrap()
                .author_id,
            actor
        );
        drop((other, reopened));
        let identity_path = root.join("local/profiles.json");
        fs::write(&identity_path, b"corrupt").unwrap();
        let corrupt = AppState::default();
        corrupt.6.set_local(root.join("local")).unwrap();
        assert!(tauri::async_runtime::block_on(open(
            &corrupt,
            root.join("project").to_string_lossy().into()
        ))
        .is_err());
        assert!(corrupt.0.lock().unwrap().is_none());
        assert_eq!(fs::read(&identity_path).unwrap(), b"corrupt");
        assert!(tauri::async_runtime::block_on(open_mode(
            &corrupt,
            root.join("project").to_string_lossy().into(),
            true,
        ))
        .is_err());
        drop(corrupt);
        fs::remove_dir_all(root).unwrap();
    }
}
