use super::{catalog, defaults, operations, runtime::Expected};
use crate::state::AppState;
use annotator_core::{
    collaboration::*,
    error::ErrorCode,
    model::{Category, Change},
};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
struct Fixture {
    root: PathBuf,
    state: AppState,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("native-review-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(defaults::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Review".into(),
        ))
        .unwrap();
        Self { root, state }
    }
    fn repo(&self) -> Arc<CollaborationRepository> {
        self.state.6.current.lock().unwrap().repo.clone().unwrap()
    }
    fn expected(&self) -> Expected {
        expected(&self.state)
    }
    fn append(&self) -> PublicMedia {
        let actor = self
            .state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .workspace()
            .unwrap()
            .author_session()
            .unwrap();
        append(&self.repo(), &actor, &self.root)
    }
    fn save_category(&self) {
        let mut current = self.state.0.lock().unwrap();
        let p = current.as_mut().unwrap();
        let d = p.snapshot().unwrap().document;
        let n = p
            .apply_change(
                &d.project_id,
                d.revision,
                Change::AddCategory {
                    category: Category {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "saved draft".into(),
                        color: "#aabbcc".into(),
                    },
                },
            )
            .unwrap();
        p.save(&d.project_id, n.document.revision).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        *self.state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.state.6.retire();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn expected(state: &AppState) -> Expected {
    let current = state.0.lock().unwrap();
    let d = current.as_ref().unwrap().snapshot().unwrap().document;
    Expected {
        runtime_nonce: state.6.current.lock().unwrap().nonce.clone(),
        project_id: d.project_id,
        expected_revision: d.revision,
    }
}
fn append(
    repo: &CollaborationRepository,
    actor: &AuthorSession,
    root: &std::path::Path,
) -> PublicMedia {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/audio/mono16.wav")
        .canonicalize()
        .unwrap();
    let prepared = repo
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    repo.append_media(actor, &prepared, &AtomicBool::new(false))
        .unwrap()
}
#[test]
fn local_logout_is_a_workspace_preserving_noop() {
    let f = Fixture::new();
    for saved in [false, true] {
        if saved {
            f.save_category();
            let mut c = f.state.0.lock().unwrap();
            c.as_mut()
                .unwrap()
                .workspace_mut()
                .unwrap()
                .save_preferences(PlaybackPreferences {
                    monitor_gain_db: 0.0,
                    media_monitor_gain_db: Default::default(),
                    volume: 0.24,
                    ..Default::default()
                })
                .unwrap();
        }
        let before = f
            .state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap();
        let expected = f.expected();
        let result = tauri::async_runtime::block_on(
            crate::commands::collaboration::test_profiles::select_named(
                &f.state,
                expected.clone(),
                "logout".into(),
                None,
            ),
        )
        .unwrap();
        assert_eq!(result.profiles.runtime_nonce, expected.runtime_nonce);
        assert_eq!(
            serde_json::to_value(
                f.state
                    .0
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .snapshot()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(before).unwrap()
        );
        if saved {
            assert_eq!(
                tauri::async_runtime::block_on(operations::status(&f.state))
                    .unwrap()
                    .preferences
                    .unwrap()
                    .volume,
                0.24
            );
        }
    }
}
#[test]
fn failed_catalog_layer_validation_does_not_commit_document_or_runtime() {
    let f = Fixture::new();
    f.save_category();
    let repo = f.repo();
    let authors = (0..MAX_AUTHORS)
        .map(|i| AuthorSnapshot {
            identity: AuthorIdentity {
                author_id: uuid::Uuid::new_v4().to_string(),
                display_name: format!("Old {i}"),
                created_at: repo.manifest().created_at.clone(),
            },
            layer: None,
            error: None,
        })
        .collect();
    f.state
        .6
        .current
        .lock()
        .unwrap()
        .layers
        .as_mut()
        .unwrap()
        .update(CollaborationSnapshot {
            project_id: repo.manifest().project_id.clone(),
            authors,
        })
        .unwrap();
    let before = serde_json::to_value(
        f.state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap(),
    )
    .unwrap();
    let persisted = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .persisted_revision();
    let layers = f
        .state
        .6
        .current
        .lock()
        .unwrap()
        .layers
        .as_ref()
        .unwrap()
        .snapshot()
        .clone();
    let envelope = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .workspace()
        .unwrap()
        .envelope()
        .clone();
    f.append();
    let error =
        tauri::async_runtime::block_on(catalog::adopt(&f.state, f.expected(), "adopt".into()))
            .err()
            .unwrap();
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    let current = f.state.0.lock().unwrap();
    let p = current.as_ref().unwrap();
    assert_eq!(serde_json::to_value(p.snapshot().unwrap()).unwrap(), before);
    assert_eq!(p.persisted_revision(), persisted);
    assert_eq!(p.workspace().unwrap().envelope(), &envelope);
    let r = f.state.6.current.lock().unwrap();
    assert!(Arc::ptr_eq(r.repo.as_ref().unwrap(), &repo));
    assert_eq!(r.layers.as_ref().unwrap().snapshot(), &layers);
    drop(r);
    drop(current);
    let mut current = f.state.0.lock().unwrap();
    let p = current.as_mut().unwrap();
    let d = p.snapshot().unwrap().document;
    let undone = p.undo(&d.project_id, d.revision).unwrap();
    assert!(undone.document.media.is_empty());
    assert!(undone.document.categories.is_empty());
    let redone = p.redo(&d.project_id, undone.document.revision).unwrap();
    assert!(redone.document.media.is_empty());
    assert_eq!(redone.document.categories, d.categories);
}
#[test]
fn adoption_catalog_race_retains_last_good_layer_and_pending_flag() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("other")).unwrap();
    let repo = f.repo();
    let local = profiles::Profile::new("Other").unwrap();
    let actor = Arc::new(repo.adopt(&local).unwrap());
    let initial = repo
        .publish(
            &actor,
            None,
            &LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap(),
        )
        .unwrap();
    tauri::async_runtime::block_on(operations::refresh(&f.state, f.expected())).unwrap();
    append(&repo, &actor, &f.root);
    let other_repo = repo.clone();
    let root = f.root.clone();
    let other_actor = actor.clone();
    *f.state.6.hook.lock().unwrap() = Some(Box::new(move || {
        append(&other_repo, &other_actor, &root);
        let updated = other_repo.reload_catalog().unwrap();
        let mut doc = updated.manifest().base_document().unwrap();
        doc.media[1].note = "new media note".into();
        updated
            .publish(
                &other_actor,
                Some(&initial),
                &LayerPayload::from_document(&doc).unwrap(),
            )
            .unwrap();
    }));
    let transition =
        tauri::async_runtime::block_on(catalog::adopt(&f.state, f.expected(), "adopt".into()))
            .unwrap();
    assert!(transition.status.catalog_pending);
    let layer = transition
        .status
        .snapshot
        .unwrap()
        .authors
        .into_iter()
        .find(|a| a.identity.author_id == actor.identity().author_id)
        .unwrap();
    assert!(layer.error.is_none(), "{:?}", layer.error);
    assert_eq!(layer.layer.unwrap().revision, 1);
    assert_eq!(
        f.state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document
            .media
            .len(),
        1
    );
    let transition = tauri::async_runtime::block_on(catalog::adopt(
        &f.state,
        f.expected(),
        "adopt-again".into(),
    ))
    .unwrap();
    assert!(!transition.status.catalog_pending);
    let layer = transition
        .status
        .snapshot
        .unwrap()
        .authors
        .into_iter()
        .find(|a| a.identity.author_id == actor.identity().author_id)
        .unwrap();
    assert_eq!(layer.layer.unwrap().revision, 2);
    let path = repo.root().join(format!(
        "annotations/{}/00000000000000000002.json",
        actor.identity().author_id
    ));
    let bytes = fs::read(&path).unwrap();
    fs::write(&path, b"corrupt").unwrap();
    let transition = tauri::async_runtime::block_on(catalog::adopt(
        &f.state,
        f.expected(),
        "adopt-corrupt".into(),
    ))
    .unwrap();
    let layer = transition
        .status
        .snapshot
        .unwrap()
        .authors
        .into_iter()
        .find(|a| a.identity.author_id == actor.identity().author_id)
        .unwrap();
    assert!(layer.error.is_some());
    assert_eq!(layer.layer.unwrap().revision, 2);
    fs::write(path, bytes).unwrap();
}

#[test]
fn save_as_progress_can_cancel_without_retiring_source() {
    let f = Fixture::new();
    f.append();
    tauri::async_runtime::block_on(catalog::adopt(&f.state, f.expected(), "adopt".into())).unwrap();
    make_unsaved_category(&f);
    fs::create_dir(f.root.join("copy")).unwrap();
    let before = f.expected();
    let snapshot = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .document;
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = events.clone();
    let service = f.state.6.clone();
    let progress = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            let event: serde_json::Value = serde_json::from_str(&json).unwrap();
            if event["phase"] == "copyMedia" {
                service.cancel("save-as-operation").unwrap();
            }
            capture.lock().unwrap().push(event);
        }
        Ok(())
    });
    let error = tauri::async_runtime::block_on(defaults::save_as_controlled(
        &f.state,
        Some(before.runtime_nonce.clone()),
        f.root.join("copy").to_string_lossy().into(),
        before.project_id.clone(),
        before.expected_revision,
        Some("save-as-operation".into()),
        Some(progress),
    ))
    .err()
    .unwrap();
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(!events.lock().unwrap().is_empty());
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .all(|e| e["operationId"] == "save-as-operation"));
    assert_eq!(f.expected().runtime_nonce, before.runtime_nonce);
    assert_eq!(
        f.state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document,
        snapshot
    );
    assert_eq!(fs::read_dir(f.root.join("copy")).unwrap().count(), 0);
}

fn make_unsaved_category(f: &Fixture) {
    let mut current = f.state.0.lock().unwrap();
    let p = current.as_mut().unwrap();
    let d = p.snapshot().unwrap().document;
    let next = p
        .apply_change(
            &d.project_id,
            d.revision,
            Change::AddCategory {
                category: Category {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: "captured unsaved".into(),
                    color: "#abcdef".into(),
                },
            },
        )
        .unwrap();
    assert!(next.document.revision > p.persisted_revision());
}

// A real owned filesystem obstruction, not a mocked save result. Restore even
// when a regression assertion panics; never remove anything except our marker.
struct BlockedWorkspace {
    path: PathBuf,
    retained: PathBuf,
}
impl BlockedWorkspace {
    fn new(path: PathBuf) -> Self {
        let retained = path.with_extension(format!("retained-{}", uuid::Uuid::new_v4()));
        fs::rename(&path, &retained).unwrap();
        fs::create_dir(&path).unwrap();
        Self { path, retained }
    }
}
impl Drop for BlockedWorkspace {
    fn drop(&mut self) {
        // Only an empty directory created above is removed; any foreign entry
        // makes remove_dir fail instead of being deleted.
        fs::remove_dir(&self.path).unwrap();
        fs::rename(&self.retained, &self.path).unwrap();
    }
}
fn save_as_unsaved_case(block_source_save: bool) {
    use annotator_core::model::{Region, SpectralEdit};
    let f = Fixture::new();
    let media = f.append();
    tauri::async_runtime::block_on(catalog::adopt(&f.state, f.expected(), "adopt".into())).unwrap();
    let (document, storage, persisted, preferences) = {
        let mut current = f.state.0.lock().unwrap();
        let p = current.as_mut().unwrap();
        let mut preferences = p.workspace().unwrap().preferences().clone();
        preferences.volume = 0.17;
        p.workspace_mut()
            .unwrap()
            .save_preferences(preferences.clone())
            .unwrap();
        p.workspace_mut()
            .unwrap()
            .set_hidden_media_ids(vec![media.id.clone()])
            .unwrap();
        for change in [
            Change::UpdateMediaNote {
                media_id: media.id.clone(),
                note: "unsaved rescue".into(),
                merge_key: None,
            },
            Change::AddEdit {
                edit: SpectralEdit {
                    id: uuid::Uuid::new_v4().to_string(),
                    region: Region {
                        media_id: media.id.clone(),
                        channel_index: 0,
                        start_seconds: 0.0,
                        end_seconds: 0.01,
                        low_hz: 10.0,
                        high_hz: 100.0,
                    },
                    enabled: true,
                    processing_version: 2,
                    operation: annotator_core::model::EditOperation::Mask,
                },
            },
        ] {
            let d = p.snapshot().unwrap().document;
            p.apply_change(&d.project_id, d.revision, change).unwrap();
        }
        (
            p.snapshot().unwrap().document,
            p.storage_root().to_path_buf(),
            p.persisted_revision(),
            preferences,
        )
    };
    assert!(document.revision > persisted);
    let private_bytes = fs::read(storage.join("workspace.json")).unwrap();
    let manifest_bytes = fs::read(f.root.join("project/collaboration.json")).unwrap();
    let source_audio = fs::read(f.root.join("project").join(&media.source_ref)).unwrap();
    let blocked =
        block_source_save.then(|| BlockedWorkspace::new(storage.join("workspace.recovery.json")));
    if block_source_save {
        let mut current = f.state.0.lock().unwrap();
        let p = current.as_mut().unwrap();
        let failure = p.save(&document.project_id, document.revision).unwrap_err();
        eprintln!("actual owned source persistence failure: {failure:?}");
        assert_eq!(p.persisted_revision(), persisted);
        assert_eq!(p.snapshot().unwrap().document, document);
    }
    fs::create_dir(f.root.join("copy")).unwrap();
    let expected = f.expected();
    let opened = tauri::async_runtime::block_on(defaults::save_as(
        &f.state,
        Some(expected.runtime_nonce.clone()),
        f.root.join("copy").to_string_lossy().into(),
        expected.project_id,
        expected.expected_revision,
    ))
    .unwrap();
    let copied = opened.snapshot.unwrap().document;
    assert_ne!(copied.project_id, document.project_id);
    assert_eq!(copied.media[0].note, "unsaved rescue");
    assert_eq!(copied.edits, document.edits);
    assert_ne!(f.expected().runtime_nonce, expected.runtime_nonce);
    let current = f.state.0.lock().unwrap();
    let p = current.as_ref().unwrap();
    assert_eq!(p.workspace().unwrap().preferences(), &preferences);
    assert_eq!(p.workspace().unwrap().hidden_media_ids(), [media.id]);
    assert_eq!(p.persisted_revision(), copied.revision);
    assert_eq!(
        fs::read(p.root().join(&copied.media[0].source_ref)).unwrap(),
        source_audio
    );
    drop(current);
    drop(blocked);
    assert_eq!(
        fs::read(storage.join("workspace.json")).unwrap(),
        private_bytes
    );
    assert_eq!(
        fs::read(f.root.join("project/collaboration.json")).unwrap(),
        manifest_bytes
    );
    assert_eq!(
        fs::read(f.root.join("project").join(&media.source_ref)).unwrap(),
        source_audio
    );
}
#[test]
fn save_as_captures_current_unsaved_document_and_private_state() {
    save_as_unsaved_case(false);
}
#[test]
fn save_as_rescues_current_document_after_actual_source_persistence_failure() {
    save_as_unsaved_case(true);
}
#[test]
fn save_as_unsaved_stale_and_changed_during_copy_still_refuse_adoption() {
    for changed_runtime in [false, true] {
        let f = Fixture::new();
        f.append();
        tauri::async_runtime::block_on(catalog::adopt(&f.state, f.expected(), "adopt".into()))
            .unwrap();
        fs::create_dir(f.root.join("copy")).unwrap();
        let before = f.expected();
        for (nonce, id, revision) in [
            (
                uuid::Uuid::new_v4().to_string(),
                before.project_id.clone(),
                before.expected_revision,
            ),
            (
                before.runtime_nonce.clone(),
                uuid::Uuid::new_v4().to_string(),
                before.expected_revision,
            ),
            (
                before.runtime_nonce.clone(),
                before.project_id.clone(),
                before.expected_revision + 1,
            ),
        ] {
            assert!(tauri::async_runtime::block_on(defaults::save_as(
                &f.state,
                Some(nonce),
                f.root.join("copy").to_string_lossy().into(),
                id,
                revision
            ))
            .is_err());
            assert_eq!(fs::read_dir(f.root.join("copy")).unwrap().count(), 0);
        }
        let state = f.state.clone();
        let foreign = f.root.join("copy/foreign.txt");
        let destination = foreign.clone();
        let progress = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let event: serde_json::Value = serde_json::from_str(&json).unwrap();
                if event["phase"] == "publishManifest" {
                    // Test-only race: bypass command admission to prove the final guard.
                    if changed_runtime {
                        state.6.current.lock().unwrap().nonce = uuid::Uuid::new_v4().to_string();
                    } else {
                        let mut current = state.0.lock().unwrap();
                        let p = current.as_mut().unwrap();
                        let d = p.snapshot().unwrap().document;
                        p.apply_change(
                            &d.project_id,
                            d.revision,
                            Change::AddCategory {
                                category: Category {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    name: "newer source".into(),
                                    color: "#abcdef".into(),
                                },
                            },
                        )
                        .unwrap();
                    }
                    fs::write(&destination, b"foreign survives rollback").unwrap();
                }
            }
            Ok(())
        });
        assert!(tauri::async_runtime::block_on(defaults::save_as_controlled(
            &f.state,
            Some(before.runtime_nonce),
            f.root.join("copy").to_string_lossy().into(),
            before.project_id.clone(),
            before.expected_revision,
            None,
            Some(progress)
        ))
        .is_err());
        assert_eq!(f.expected().project_id, before.project_id);
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign survives rollback");
        assert_eq!(fs::read_dir(f.root.join("copy")).unwrap().count(), 1);
    }
}
#[test]
fn batch_hidden_ids_validate_and_persist_once_then_copy_together() {
    let f = Fixture::new();
    let first = f.append();
    let second = f.append();
    tauri::async_runtime::block_on(catalog::adopt(&f.state, f.expected(), "adopt".into())).unwrap();
    make_unsaved_category(&f);
    let mut ids = vec![first.id, second.id];
    ids.sort();
    {
        let mut current = f.state.0.lock().unwrap();
        let workspace = current.as_mut().unwrap().workspace_mut().unwrap();
        let before = workspace.envelope().clone();
        assert!(workspace
            .set_hidden_media_ids(vec![ids[0].clone(), ids[0].clone()])
            .is_err());
        assert!(workspace
            .set_hidden_media_ids(vec![uuid::Uuid::new_v4().to_string()])
            .is_err());
        assert_eq!(workspace.envelope(), &before);
        workspace.set_hidden_media_ids(ids.clone()).unwrap();
        assert_eq!(workspace.envelope().sequence, before.sequence + 1);
        assert_eq!(workspace.hidden_media_ids(), ids);
        workspace
            .set_hidden_media_ids(ids.iter().rev().cloned().collect())
            .unwrap();
        assert_eq!(workspace.envelope().sequence, before.sequence + 1);
    }
    fs::create_dir(f.root.join("baseline")).unwrap();
    let document = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .document;
    let (baseline, _) = defaults::copy(
        &document,
        f.repo().root(),
        &f.root.join("baseline"),
        &f.root.join("local"),
        &f.state.6.selected_profile().unwrap(),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap()
    .commit();
    let seed_sequence = baseline.workspace().unwrap().envelope().sequence;
    drop(baseline);
    fs::create_dir(f.root.join("copy")).unwrap();
    let expected = f.expected();
    tauri::async_runtime::block_on(defaults::save_as(
        &f.state,
        Some(expected.runtime_nonce),
        f.root.join("copy").to_string_lossy().into(),
        expected.project_id,
        expected.expected_revision,
    ))
    .unwrap();
    let current = f.state.0.lock().unwrap();
    let workspace = current.as_ref().unwrap().workspace().unwrap();
    assert_eq!(workspace.hidden_media_ids(), ids);
    // Beyond the identical project seed, one preference transfer and one complete list write.
    assert_eq!(workspace.envelope().sequence, seed_sequence + 2);
}

#[test]
fn retired_default_preparation_holds_admission_until_worker_exits() {
    use std::{sync::mpsc, time::Duration};
    let f = Fixture::new();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/audio/mono16.wav")
        .canonicalize()
        .unwrap();
    let (entered, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    *f.state.6.hook.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait.recv().unwrap();
    }));
    let start = |state: &AppState| {
        let e = expected(state);
        let (tx, rx) = mpsc::channel();
        let result = tauri::async_runtime::block_on(crate::commands::media::start(
            state,
            Some(e.runtime_nonce),
            e.project_id,
            vec![source.to_string_lossy().into()],
            None,
            tauri::ipc::Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                    let _ = tx.send(serde_json::from_str::<serde_json::Value>(&json).unwrap());
                }
                Ok(())
            }),
        ));
        (result, rx)
    };
    let (first, old_events) = start(&f.state);
    first.unwrap();
    arrival.recv_timeout(Duration::from_secs(10)).unwrap();
    *f.state.0.lock().unwrap() = None;
    f.state.1.lock().unwrap().reset();
    f.state.6.retire();
    fs::create_dir(f.root.join("next")).unwrap();
    tauri::async_runtime::block_on(defaults::create(
        &f.state,
        f.root.join("next").to_string_lossy().into(),
        "Next".into(),
    ))
    .unwrap();
    let (second, new_events) = start(&f.state);
    release.send(()).unwrap();
    while old_events.recv_timeout(Duration::from_secs(10)).unwrap()["type"] != "finished" {}
    if second.is_ok() {
        while new_events.recv_timeout(Duration::from_secs(10)).unwrap()["type"] != "finished" {}
    }
    let error = second.expect_err("retired OS worker must retain the preparation slot");
    assert_eq!(error.code, ErrorCode::ResourceLimit);
    assert_eq!(error.details.unwrap()["operationKind"], "mediaPreparation");
    // A bounded retry may race the final Finished event with the worker's last destructor.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let events = loop {
        let (result, events) = start(&f.state);
        match result {
            Ok(_) => break events,
            Err(e) => {
                assert!(e.retryable);
                assert!(std::time::Instant::now() < deadline);
                std::thread::yield_now();
            }
        }
    };
    let mut ready = false;
    loop {
        let event = events.recv_timeout(Duration::from_secs(10)).unwrap();
        if event["type"] == "ready" {
            ready = true;
        }
        if event["type"] == "finished" {
            break;
        }
    }
    assert!(ready);
}

#[test]
fn imported_commit_snapshot_defers_later_foreign_append_until_explicit_adoption() {
    let f = Fixture::new();
    f.save_category();
    fs::create_dir(f.root.join("other")).unwrap();
    let repo = f.repo();
    let other = profiles::Profile::new("Other").unwrap();
    let actor = Arc::new(repo.adopt(&other).unwrap());
    let initial = repo
        .publish(
            &actor,
            None,
            &LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap(),
        )
        .unwrap();
    tauri::async_runtime::block_on(operations::refresh(&f.state, f.expected())).unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/audio/mono16.wav")
        .canonicalize()
        .unwrap();
    let prepared = repo
        .prepare_media(&source, &f.root.join("own-pcm"), &AtomicBool::new(false))
        .unwrap();
    let descriptor = prepared.decoded().descriptor.clone();
    catalog::store_prepared(
        &f.state.6,
        &f.expected().runtime_nonce,
        "commit-snapshot",
        prepared,
    )
    .unwrap();
    let later_repo = repo.clone();
    let later_actor = actor.clone();
    let root = f.root.clone();
    *f.state.6.after_io.lock().unwrap() = Some(Box::new(move || {
        let added = append(&later_repo, &later_actor, &root);
        let latest = later_repo.reload_catalog().unwrap();
        let mut doc = latest.manifest().base_document().unwrap();
        doc.media
            .iter_mut()
            .find(|m| m.id == added.id)
            .unwrap()
            .note = "after captured commit".into();
        latest
            .publish(
                &later_actor,
                Some(&initial),
                &LayerPayload::from_document(&doc).unwrap(),
            )
            .unwrap();
    }));
    let imported =
        tauri::async_runtime::block_on(catalog::import(&f.state, f.expected(), descriptor.clone()))
            .unwrap();
    assert_eq!(
        imported.document.media.len(),
        1,
        "a later foreign append requires explicit adoption"
    );
    assert_eq!(imported.document.media[0].id, descriptor.id);
    assert_eq!(imported.document.categories[0].name, "saved draft");
    let status =
        tauri::async_runtime::block_on(operations::refresh(&f.state, f.expected())).unwrap();
    assert!(status.catalog_pending);
    let foreign = status
        .snapshot
        .unwrap()
        .authors
        .into_iter()
        .find(|a| a.identity.author_id == actor.identity().author_id)
        .unwrap();
    assert!(foreign.error.is_none());
    assert_eq!(foreign.layer.unwrap().revision, 1);
    let adopted = tauri::async_runtime::block_on(catalog::adopt(
        &f.state,
        f.expected(),
        "adopt-later".into(),
    ))
    .unwrap();
    let snapshot = adopted.opened.snapshot.unwrap();
    assert_eq!(snapshot.document.media.len(), 2);
    assert_eq!(snapshot.document.categories[0].name, "saved draft");
    assert!(!adopted.status.catalog_pending);
    let foreign = adopted
        .status
        .snapshot
        .unwrap()
        .authors
        .into_iter()
        .find(|a| a.identity.author_id == actor.identity().author_id)
        .unwrap();
    assert!(foreign.error.is_none());
    assert!(foreign
        .layer
        .unwrap()
        .payload
        .media_labels
        .iter()
        .any(|m| m.note == "after captured commit"));
    let mut state = f.state.0.lock().unwrap();
    let p = state.as_mut().unwrap();
    let undone = p
        .undo(&snapshot.document.project_id, snapshot.document.revision)
        .unwrap();
    assert_eq!(undone.document.media.len(), 2);
    assert!(undone.document.categories.is_empty());
    let redone = p
        .redo(&snapshot.document.project_id, undone.document.revision)
        .unwrap();
    assert_eq!(redone.document.categories, snapshot.document.categories);
    drop(state);
    catalog::release(&f.state.6, "commit-snapshot", &descriptor.id).unwrap();
}
