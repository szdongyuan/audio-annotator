use super::{
    operations::*,
    runtime::{Expected, Status},
};
use crate::state::AppState;
use annotator_core::{
    collaboration::*,
    error::ErrorCode,
    model::{Category, Change, ProjectDocument},
    project::LocalProject,
};
use std::{
    fs,
    path::PathBuf,
    sync::{mpsc, Arc},
    time::Duration,
};

struct Fixture {
    root: PathBuf,
    repo: Arc<CollaborationRepository>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("nas-native-{}", uuid::Uuid::new_v4()));
        for name in [
            "shared/media",
            "shared/authors",
            "shared/annotations",
            "local-a",
            "local-b",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let d = ProjectDocument::create("shared".into()).unwrap();
        let manifest = CollaborationManifest {
            kind: MANIFEST_KIND.into(),
            format_version: CURRENT_COLLABORATION_FORMAT,
            project_id: d.project_id,
            name: d.name,
            created_at: d.created_at,
            media: vec![],
        };
        crate::commands::collaboration::test_profiles::write_manifest(
            &root.join("shared"),
            &manifest,
        );
        let repo = Arc::new(CollaborationRepository::open(&root.join("shared")).unwrap());
        Self { root, repo }
    }
    fn state(&self, name: &str) -> AppState {
        let state = AppState::default();
        state.6.set_local(self.root.join(name)).unwrap();
        tauri::async_runtime::block_on(open(
            &state,
            self.root
                .join("shared/collaboration.json")
                .to_string_lossy()
                .into_owned(),
        ))
        .unwrap();
        state
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn expected(state: &AppState) -> Expected {
    let p = state.0.lock().unwrap();
    let d = p.as_ref().unwrap().snapshot().unwrap().document;
    Expected {
        runtime_nonce: state.6.current.lock().unwrap().nonce.clone(),
        project_id: d.project_id,
        expected_revision: d.revision,
    }
}
fn edit(state: &AppState, name: &str, save: bool) {
    let mut p = state.0.lock().unwrap();
    let p = p.as_mut().unwrap();
    let d = p.snapshot().unwrap().document;
    let snap = p
        .apply_change(
            &d.project_id,
            d.revision,
            Change::AddCategory {
                category: Category {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: name.into(),
                    color: "#aabbcc".into(),
                },
            },
        )
        .unwrap();
    if save {
        p.save(&snap.document.project_id, snap.document.revision)
            .unwrap();
    }
}
fn register(state: &AppState, name: &str) {
    tauri::async_runtime::block_on(crate::commands::collaboration::test_profiles::select_named(
        state,
        expected(state),
        uuid::Uuid::new_v4().to_string(),
        Some(name),
    ))
    .unwrap();
}
fn refresh_now(state: &AppState) -> Status {
    tauri::async_runtime::block_on(refresh(state, expected(state))).unwrap()
}

#[test]
fn unknown_shared_json_and_subdirectory_open_never_write_project_locks() {
    let f = Fixture::new();
    crate::commands::collaboration::test_profiles::seed(&f.repo, "alice", "Alice").unwrap();
    let account = fs::read_dir(f.root.join("shared/authors"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    for path in [
        account,
        f.root.join("shared/authors"),
        f.root.join("shared/media"),
    ] {
        let state = AppState::default();
        state.6.set_local(f.root.join("local-a")).unwrap();
        assert!(
            tauri::async_runtime::block_on(open(&state, path.to_string_lossy().into_owned()))
                .is_err()
        );
        assert!(!f.root.join("shared/authors/.project.lock").exists());
        assert!(!f.root.join("shared/media/.project.lock").exists());
    }
}

#[test]
fn independent_native_identities_are_private_and_status_has_no_credentials() {
    let f = Fixture::new();
    let a = f.state("local-a");
    let b = f.state("local-b");
    register(&a, "alice");
    register(&b, "bob");
    edit(&a, "A", true);
    edit(&b, "B", true);
    refresh_now(&a);
    refresh_now(&b);
    let status = refresh_now(&a);
    assert_eq!(
        status
            .snapshot
            .unwrap()
            .authors
            .iter()
            .filter(|a| a.layer.is_some())
            .count(),
        2
    );
    let json = serde_json::to_string(
        &tauri::async_runtime::block_on(super::operations::status(&a)).unwrap(),
    )
    .unwrap();
    for secret in ["password", "argon2", "workspace.json", "local-a"] {
        assert!(!json.contains(secret));
    }
    assert_eq!(
        a.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document
            .categories
            .len(),
        1
    );
    assert_ne!(
        a.0.lock().unwrap().as_ref().unwrap().storage_root(),
        b.0.lock().unwrap().as_ref().unwrap().storage_root()
    );
    let old = expected(&b);
    let wrong = tauri::async_runtime::block_on(
        crate::commands::collaboration::test_profiles::select_named(
            &b,
            old.clone(),
            "wrong".into(),
            Some("alice"),
        ),
    );
    assert!(wrong.is_err());
    assert_eq!(expected(&b).runtime_nonce, old.runtime_nonce);
    assert!(tauri::async_runtime::block_on(
        crate::commands::collaboration::test_profiles::select_named(
            &b,
            old,
            "locked".into(),
            Some("alice")
        )
    )
    .is_err());
}

#[test]
fn delayed_publication_never_replaces_unsaved_c_with_saved_b() {
    let f = Fixture::new();
    let a = f.state("local-a");
    register(&a, "alice");
    edit(&a, "A", true);
    let (entered, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    *a.6.hook.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait.recv().unwrap();
    }));
    let worker = a.clone();
    let e = expected(&a);
    let join = std::thread::spawn(move || tauri::async_runtime::block_on(refresh(&worker, e)));
    arrival.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(a.0.try_lock().is_ok());
    edit(&a, "B", true);
    edit(&a, "C", false);
    let before = a.0.lock().unwrap().as_ref().unwrap().snapshot().unwrap();
    assert!(refresh_now(&a).busy);
    release.send(()).unwrap();
    join.join().unwrap().unwrap();
    assert_eq!(
        a.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document,
        before.document
    );
    let p = a.0.lock().unwrap();
    let p = p.as_ref().unwrap();
    assert_eq!(
        p.workspace().unwrap().envelope().document.categories.len(),
        2
    );
    assert_eq!(
        p.workspace()
            .unwrap()
            .envelope()
            .base
            .as_ref()
            .unwrap()
            .revision,
        1
    );
    assert!(p.workspace().unwrap().envelope().pending.is_some());
}

#[test]
fn old_runtime_worker_and_cancelled_identity_cannot_adopt_after_retirement() {
    let f = Fixture::new();
    let a = f.state("local-a");
    let (entered, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    *a.6.hook.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait.recv().unwrap();
    }));
    let worker = a.clone();
    let e = expected(&a);
    let join = std::thread::spawn(move || {
        tauri::async_runtime::block_on(crate::commands::collaboration::test_profiles::select_named(
            &worker,
            e,
            "cancel-me".into(),
            Some("alice"),
        ))
    });
    arrival.recv_timeout(Duration::from_secs(10)).unwrap();
    a.6.cancel("cancel-me").unwrap();
    assert!(a.0.try_lock().is_ok());
    release.send(()).unwrap();
    assert!(join.join().unwrap().is_err());
    assert!(a
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .workspace()
        .unwrap()
        .actor()
        .is_some());
    assert_eq!(f.repo.snapshot().unwrap().authors.len(), 1);
    let prior = expected(&a);
    a.6.retire();
    a.6.install(Some(f.repo.clone())).unwrap();
    assert!(tauri::async_runtime::block_on(refresh(&a, prior)).is_err());
}

#[test]
fn own_external_change_requires_explicit_load_without_replacing_live_history() {
    let f = Fixture::new();
    crate::commands::collaboration::test_profiles::seed(&f.repo, "alice", "Alice").unwrap();
    let actor = Arc::new(
        f.repo
            .adopt(&crate::commands::collaboration::test_profiles::profile(
                "alice",
            ))
            .unwrap(),
    );
    let a = AppState::default();
    a.6.set_local(f.root.join("local-a")).unwrap();
    *a.0.lock().unwrap() = Some(
        LocalProject::open_shared(f.repo.clone(), Some(actor.clone()), &a.6.local().unwrap())
            .unwrap(),
    );
    a.6.install(Some(f.repo.clone())).unwrap();
    let before =
        a.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document;
    let mut remote = LayerPayload::from_document(&before).unwrap();
    remote.categories.push(Category {
        id: uuid::Uuid::new_v4().to_string(),
        name: "external".into(),
        color: "#aabbcc".into(),
    });
    f.repo.publish(&actor, None, &remote).unwrap();
    let status = refresh_now(&a);
    assert_eq!(
        a.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document,
        before
    );
    assert_eq!(status.error.unwrap().code, ErrorCode::RevisionConflict);
    let loaded =
        tauri::async_runtime::block_on(load_shared(&a, expected(&a), "load".into())).unwrap();
    assert_eq!(
        loaded.opened.snapshot.unwrap().document.categories[0].name,
        "external"
    );
}

#[test]
fn offline_and_corrupt_layers_keep_last_good_and_reconnect_publishes_pending() {
    let f = Fixture::new();
    let a = f.state("local-a");
    let b = f.state("local-b");
    register(&a, "alice");
    register(&b, "bob");
    edit(&a, "A", true);
    edit(&b, "B", true);
    refresh_now(&a);
    refresh_now(&b);
    let prior = refresh_now(&a).snapshot.unwrap();
    let manifest = f.root.join("shared/collaboration.json");
    let hidden = f.root.join("shared/owned-offline.json");
    fs::rename(&manifest, &hidden).unwrap();
    edit(&a, "offline", true);
    let offline = refresh_now(&a);
    fs::rename(&hidden, &manifest).unwrap();
    assert!(offline.error.is_some());
    assert!(offline.pending);
    assert_eq!(offline.snapshot.unwrap(), prior);
    assert!(!refresh_now(&a).pending);
    let bob =
        b.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .workspace()
            .unwrap()
            .actor()
            .unwrap()
            .author_id
            .clone();
    let layer = f.root.join(format!(
        "shared/annotations/{bob}/00000000000000000001.json"
    ));
    let bytes = fs::read(&layer).unwrap();
    fs::write(&layer, b"broken").unwrap();
    let corrupt = refresh_now(&a);
    fs::write(layer, bytes).unwrap();
    let remembered = corrupt
        .snapshot
        .unwrap()
        .authors
        .into_iter()
        .find(|x| x.identity.author_id == bob)
        .unwrap();
    assert!(remembered.error.is_some());
    assert_eq!(remembered.layer.unwrap().payload.categories[0].name, "B");
    assert!(refresh_now(&a)
        .snapshot
        .unwrap()
        .authors
        .iter()
        .all(|a| a.error.is_none()));
}

#[test]
fn profile_selection_preserves_private_cache_preferences_and_nonces() {
    let f = Fixture::new();
    let a = f.state("local-a");
    edit(&a, "guest", true);
    a.0.lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .workspace_mut()
        .unwrap()
        .save_preferences(PlaybackPreferences {
            volume: 0.2,
            ..Default::default()
        })
        .unwrap();
    refresh_now(&a);
    let guest = expected(&a);
    register(&a, "alice");
    assert_ne!(expected(&a).runtime_nonce, guest.runtime_nonce);
    {
        let p = a.0.lock().unwrap();
        let p = p.as_ref().unwrap();
        assert!(super::runtime::check_mutation(p, &a.6, None).is_err());
        assert!(super::runtime::check_mutation(p, &a.6, Some(&guest.runtime_nonce)).is_err());
        assert_eq!(p.workspace().unwrap().preferences().volume, 0.75);
    }
    tauri::async_runtime::block_on(crate::commands::collaboration::test_profiles::select_named(
        &a,
        expected(&a),
        "switch-back".into(),
        None,
    ))
    .unwrap();
    let p = a.0.lock().unwrap();
    let p = p.as_ref().unwrap();
    assert_eq!(p.workspace().unwrap().preferences().volume, 0.2);
    assert_eq!(p.snapshot().unwrap().document.categories[0].name, "guest");
}

#[test]
fn ordinary_missing_primary_still_opens_valid_recovery() {
    let f = Fixture::new();
    let root = f.root.join("ordinary");
    fs::create_dir(&root).unwrap();
    let p = LocalProject::create(&root, "recovery".into()).unwrap();
    drop(p);
    fs::remove_file(root.join("project.json")).unwrap();
    let a = AppState::default();
    a.6.set_local(f.root.join("ordinary-local")).unwrap();
    tauri::async_runtime::block_on(open(
        &a,
        root.join("project.json").to_string_lossy().into_owned(),
    ))
    .unwrap();
    assert!(a.0.lock().unwrap().as_ref().unwrap().recovery().is_some());
}
#[test]
fn view_only_catalog_rejects_async_scan_import_and_forged_local_change() {
    let f = Fixture::new();
    let a = f.state("local-a");
    *a.0.lock().unwrap() = None;
    a.6.retire();
    tauri::async_runtime::block_on(open_mode(
        &a,
        f.root.join("shared").to_string_lossy().into(),
        true,
    ))
    .unwrap();
    let e = expected(&a);
    let import = tauri::async_runtime::block_on(crate::commands::media::start(
        &a,
        Some(e.runtime_nonce.clone()),
        e.project_id.clone(),
        vec!["unused.wav".into()],
        None,
        tauri::ipc::Channel::new(|_| panic!("Rejected import cannot emit progress")),
    ));
    assert!(import.is_err());
    let scan = tauri::async_runtime::block_on(crate::commands::folders::start(
        &a,
        Some(e.runtime_nonce),
        e.project_id.clone(),
        f.root.to_string_lossy().into_owned(),
        true,
        tauri::ipc::Channel::new(|_| panic!("Rejected scan cannot emit progress")),
    ));
    assert!(scan.is_err());
    let mut p = a.0.lock().unwrap();
    let p = p.as_mut().unwrap();
    assert!(p
        .apply_change(
            &e.project_id,
            e.expected_revision,
            Change::RemoveMedia {
                media_id: uuid::Uuid::new_v4().to_string()
            }
        )
        .is_err());
}
#[test]
fn native_requests_reject_renderer_credential_and_owner_injection() {
    assert!(serde_json::from_value::<Expected>(serde_json::json!({"runtimeNonce":"a", "projectId":"b", "expectedRevision":0,"authorId":"spoof"})).is_err());
    assert!(serde_json::from_value::<crate::commands::profiles::Expected>(serde_json::json!({"storeRevision":1,"runtimeNonce":"x","project":null,"password":"forbidden"})).is_err());
}

#[test]
fn published_old_worker_cannot_update_new_runtime_or_release_its_slot_early() {
    let f = Fixture::new();
    let a = f.state("local-a");
    register(&a, "alice");
    edit(&a, "published A", true);
    let (entered, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    *a.6.after_io.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait.recv().unwrap();
    }));
    let worker = a.clone();
    let e = expected(&a);
    let join = std::thread::spawn(move || tauri::async_runtime::block_on(refresh(&worker, e)));
    arrival.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        f.repo.snapshot().unwrap().authors[0]
            .layer
            .as_ref()
            .unwrap()
            .revision,
        1
    );
    *a.0.lock().unwrap() = None;
    a.6.retire();
    let guest = LocalProject::open_shared(
        f.repo.clone(),
        Some(Arc::new(
            f.repo
                .adopt(&crate::commands::collaboration::test_profiles::profile(
                    "replacement",
                ))
                .unwrap(),
        )),
        &a.6.local().unwrap(),
    )
    .unwrap();
    *a.0.lock().unwrap() = Some(guest);
    a.6.install(Some(f.repo.clone())).unwrap();
    assert!(a.6.begin("extra-worker".into()).is_err());
    edit(&a, "new runtime guest", false);
    let before =
        a.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document;
    release.send(()).unwrap();
    assert!(join.join().unwrap().is_err());
    assert_eq!(
        a.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document,
        before
    );
    assert!(a.6.begin("slot-released".into()).is_ok());
    assert!(a
        .6
        .current
        .lock()
        .unwrap()
        .layers
        .as_ref()
        .unwrap()
        .snapshot()
        .authors
        .is_empty());
}

#[test]
fn delayed_previous_actor_playback_capture_and_control_cannot_touch_new_identity() {
    let f = Fixture::new();
    let a = f.state("local-a");
    register(&a, "alice");
    let alice = expected(&a);
    tauri::async_runtime::block_on(crate::commands::collaboration::test_profiles::select_named(
        &a,
        alice.clone(),
        "logout".into(),
        None,
    ))
    .unwrap();
    register(&a, "bob");
    let before = serde_json::to_value(a.3.status().unwrap()).unwrap();
    assert!(crate::commands::playback::capture_playback(&a, Some(&alice.runtime_nonce)).is_err());
    assert!(
        crate::commands::playback::control_owned(&a, Some(&alice.runtime_nonce), "reset").is_err()
    );
    assert_eq!(serde_json::to_value(a.3.status().unwrap()).unwrap(), before);
    assert_eq!(
        a.0.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .workspace()
            .unwrap()
            .preferences()
            .volume,
        0.75
    );
}
#[test]
fn local_capture_failure_stays_visible_after_previous_profile_published() {
    let f = Fixture::new();
    let a = f.state("local-a");
    edit(&a, "guest", true);
    assert!(
        !refresh_now(&a).pending,
        "successful publication clears pending"
    );
    register(&a, "alice");
    edit(&a, "own", true);
    a.0.lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainWrite));
    let status = refresh_now(&a);
    assert!(status.pending);
    assert_eq!(status.error.unwrap().code, ErrorCode::SaveFailed);
}

#[test]
fn explicit_default_view_only_does_not_silently_open_a_legacy_guest_writer() {
    let fixture = Fixture::new();
    let state = AppState::default();
    state.6.set_local(fixture.root.join("local-a")).unwrap();
    let path = fixture.root.join("shared/collaboration.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["formatVersion"] = serde_json::json!(2);
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(tauri::async_runtime::block_on(open_mode(
        &state,
        fixture.root.join("shared").to_string_lossy().into(),
        true
    ))
    .is_err());
    assert!(state.0.lock().unwrap().is_none());
}
