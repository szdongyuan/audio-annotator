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
            "shared/accounts",
            "shared/annotations",
            "local-a",
            "local-b",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let d = ProjectDocument::create("shared".into()).unwrap();
        let manifest = CollaborationManifest {
            kind: MANIFEST_KIND.into(),
            format_version: 1,
            project_id: d.project_id,
            name: d.name,
            created_at: d.created_at,
            media: vec![],
        };
        fs::write(
            root.join("shared/collaboration.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
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
    tauri::async_runtime::block_on(identity(
        state,
        expected(state),
        uuid::Uuid::new_v4().to_string(),
        IdentityAction::Register {
            login: name.into(),
            display_name: name.into(),
            password: "password123".into(),
        },
    ))
    .unwrap();
}
fn refresh_now(state: &AppState) -> Status {
    tauri::async_runtime::block_on(refresh(state, expected(state))).unwrap()
}

#[test]
fn unknown_shared_json_and_subdirectory_open_never_write_project_locks() {
    let f = Fixture::new();
    f.repo.register("alice", "Alice", "password123").unwrap();
    let account = fs::read_dir(f.root.join("shared/accounts"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    for path in [
        account,
        f.root.join("shared/accounts"),
        f.root.join("shared/media"),
    ] {
        let state = AppState::default();
        state.6.set_local(f.root.join("local-a")).unwrap();
        assert!(
            tauri::async_runtime::block_on(open(&state, path.to_string_lossy().into_owned()))
                .is_err()
        );
        assert!(!f.root.join("shared/accounts/.project.lock").exists());
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
    let wrong = tauri::async_runtime::block_on(identity(
        &b,
        old.clone(),
        "wrong".into(),
        IdentityAction::Login {
            login: "alice".into(),
            password: "wrongpass".into(),
        },
    ));
    assert!(wrong.is_err());
    assert_eq!(expected(&b).runtime_nonce, old.runtime_nonce);
    assert!(tauri::async_runtime::block_on(identity(
        &b,
        old,
        "locked".into(),
        IdentityAction::Login {
            login: "alice".into(),
            password: "password123".into()
        }
    ))
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
        tauri::async_runtime::block_on(identity(
            &worker,
            e,
            "cancel-me".into(),
            IdentityAction::Register {
                login: "alice".into(),
                display_name: "Alice".into(),
                password: "password123".into(),
            },
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
        .is_none());
    assert!(f.repo.snapshot().unwrap().authors.is_empty());
    let prior = expected(&a);
    a.6.retire();
    a.6.install(Some(f.repo.clone())).unwrap();
    assert!(tauri::async_runtime::block_on(refresh(&a, prior)).is_err());
}

#[test]
fn own_external_change_requires_explicit_load_without_replacing_live_history() {
    let f = Fixture::new();
    f.repo.register("alice", "Alice", "password123").unwrap();
    let actor = Arc::new(f.repo.login("alice", "password123").unwrap());
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
        tauri::async_runtime::block_on(load_or_guest(&a, expected(&a), "load".into(), false))
            .unwrap();
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
fn guest_copy_uses_native_cache_and_preferences_and_nonces_follow_identity() {
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
    // Explicit native guest load is one undoable own change; no renderer payload parameter exists.
    let merged =
        tauri::async_runtime::block_on(load_or_guest(&a, expected(&a), "guest-copy".into(), true))
            .unwrap();
    let merged = merged.opened.snapshot.unwrap();
    assert_eq!(merged.document.categories[0].name, "guest");
    {
        let mut p = a.0.lock().unwrap();
        let p = p.as_mut().unwrap();
        let undone = p
            .undo(&merged.document.project_id, merged.document.revision)
            .unwrap();
        assert!(undone.document.categories.is_empty());
        p.save(&undone.document.project_id, undone.document.revision)
            .unwrap();
    }
    tauri::async_runtime::block_on(identity(
        &a,
        expected(&a),
        "logout".into(),
        IdentityAction::Logout,
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
    tauri::async_runtime::block_on(open(
        &a,
        root.join("project.json").to_string_lossy().into_owned(),
    ))
    .unwrap();
    assert!(a.0.lock().unwrap().as_ref().unwrap().recovery().is_some());
}
#[test]
fn shared_catalog_rejects_async_scan_import_and_forged_local_change() {
    let f = Fixture::new();
    let a = f.state("local-a");
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
    assert!(serde_json::from_value::<IdentityAction>(
        serde_json::json!({"type":"login","login":"a","password":"password123","authorId":"spoof"})
    )
    .is_err());
    assert!(serde_json::from_value::<super::creation::Credentials>(serde_json::json!({"login":"a","displayName":"a","password":"password123","passwordHash":"spoof"})).is_err());
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
    let guest = LocalProject::open_shared(f.repo.clone(), None, &a.6.local().unwrap()).unwrap();
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
    tauri::async_runtime::block_on(identity(
        &a,
        alice.clone(),
        "logout".into(),
        IdentityAction::Logout,
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
fn local_capture_failure_stays_visible_and_guest_has_no_network_pending() {
    let f = Fixture::new();
    let a = f.state("local-a");
    edit(&a, "guest", true);
    assert!(
        !refresh_now(&a).pending,
        "guest annotations are local-only, never network pending"
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
