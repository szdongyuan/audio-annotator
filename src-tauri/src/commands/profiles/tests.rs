use super::*;
use crate::commands::collaboration::{defaults, runtime};
use annotator_core::{
    collaboration::profiles::STORE_FILE_NAME,
    model::{Category, Change},
};
use std::{fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    state: AppState,
}
impl Fixture {
    fn new(open: bool) -> Self {
        let root = std::env::temp_dir().join(format!("native-profiles-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        if open {
            tauri::async_runtime::block_on(defaults::create(
                &state,
                root.join("project").to_string_lossy().into(),
                "Profiles".into(),
            ))
            .unwrap();
        }
        Self { root, state }
    }
    fn snapshot(&self) -> Snapshot {
        tauri::async_runtime::block_on(list(&self.state)).unwrap()
    }
    fn expected(&self) -> Expected {
        expectation(self.snapshot())
    }
    fn act(&self, action: Action) -> Result<Response> {
        tauri::async_runtime::block_on(perform(
            &self.state,
            self.expected(),
            "profile-op".into(),
            action,
        ))
    }
    fn create(&self, name: &str) -> Profile {
        self.act(Action::Create(name.into()))
            .unwrap()
            .profile
            .unwrap()
    }
    fn actor(&self) -> String {
        self.state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .workspace()
            .unwrap()
            .actor()
            .unwrap()
            .author_id
            .clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        *self.state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.state.6.retire();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn expectation(snapshot: Snapshot) -> Expected {
    Expected {
        store_revision: snapshot.store_revision,
        runtime_nonce: snapshot.runtime_nonce,
        project: snapshot.project,
    }
}

#[test]
fn profiles_no_project_management_transfer_and_process_selection_are_independent() {
    let f = Fixture::new(false);
    let original = f.snapshot();
    assert!(original.project.is_none());
    let created = f.create("  同名  ");
    assert_eq!(created.display_name, "同名");
    assert_eq!(f.snapshot().selected_author_id, original.selected_author_id);
    let second = AppState::default();
    second.6.set_local(f.root.join("local")).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(list(&second))
            .unwrap()
            .selected_author_id,
        original.selected_author_id
    );
    f.act(Action::Select(created.author_id.clone())).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(list(&second))
            .unwrap()
            .selected_author_id,
        original.selected_author_id
    );
    let restart = AppState::default();
    restart.6.set_local(f.root.join("local")).unwrap();
    assert_eq!(
        tauri::async_runtime::block_on(list(&restart))
            .unwrap()
            .selected_author_id,
        created.author_id
    );
    let renamed = f
        .act(Action::Rename {
            author_id: created.author_id.clone(),
            display_name: "Renamed".into(),
        })
        .unwrap()
        .profile
        .unwrap();
    assert_eq!(renamed.created_at, created.created_at);
    let path = f.root.join("identity.json");
    f.act(Action::Export {
        author_id: created.author_id.clone(),
        path: Some(path.to_string_lossy().into()),
    })
    .unwrap();
    assert!(f
        .act(Action::Export {
            author_id: created.author_id.clone(),
            path: Some(path.to_string_lossy().into())
        })
        .is_err());
    let other = Fixture::new(false);
    let before = other.snapshot();
    let imported = other
        .act(Action::Import(Some(path.to_string_lossy().into())))
        .unwrap();
    assert_eq!(imported.profile.unwrap(), renamed);
    assert_eq!(
        imported.profiles.selected_author_id,
        before.selected_author_id
    );
    other
        .act(Action::Rename {
            author_id: created.author_id.clone(),
            display_name: "Keep local".into(),
        })
        .unwrap();
    let duplicate = other
        .act(Action::Import(Some(path.to_string_lossy().into())))
        .unwrap();
    assert!(duplicate.already_exists);
    assert_eq!(duplicate.profile.unwrap().display_name, "Keep local");
    let before = other.snapshot().store_revision;
    other.act(Action::Import(None)).unwrap();
    other
        .act(Action::Export {
            author_id: created.author_id,
            path: None,
        })
        .unwrap();
    assert_eq!(other.snapshot().store_revision, before);
    fs::write(&path, b"bad").unwrap();
    assert!(other
        .act(Action::Import(Some(path.to_string_lossy().into())))
        .is_err());
    assert_eq!(other.snapshot().store_revision, before);
}
#[test]
fn profiles_stale_runtime_store_and_project_expectations_fail_without_mutation() {
    let f = Fixture::new(false);
    let old = f.expected();
    f.create("new");
    assert!(tauri::async_runtime::block_on(perform(
        &f.state,
        old,
        "stale".into(),
        Action::Create("lost".into())
    ))
    .is_err());
    let mut old = f.expected();
    old.runtime_nonce = "old".into();
    assert!(tauri::async_runtime::block_on(perform(
        &f.state,
        old,
        "stale".into(),
        Action::Create("lost".into())
    ))
    .is_err());
    let mut old = f.expected();
    old.project = Some(ProjectExpectation {
        project_id: uuid::Uuid::new_v4().to_string(),
        expected_revision: 0,
    });
    assert!(tauri::async_runtime::block_on(perform(
        &f.state,
        old,
        "stale".into(),
        Action::Create("lost".into())
    ))
    .is_err());
    assert_eq!(f.snapshot().profiles.len(), 2);
    let file = f.root.join("local").join(STORE_FILE_NAME);
    fs::write(&file, b"corrupt").unwrap();
    assert!(tauri::async_runtime::block_on(list(&f.state)).is_err());
    assert_eq!(fs::read(file).unwrap(), b"corrupt");
}
#[test]
fn profiles_recheck_store_revision_after_preparation_even_for_same_selection_and_export() {
    for export in [false, true] {
        let f = Fixture::new(false);
        let before = f.snapshot();
        let store = f.state.6.profile_store().unwrap();
        *f.state.6.hook.lock().unwrap() = Some(Box::new(move || {
            store.create(before.store_revision, "external").unwrap();
        }));
        let action = if export {
            Action::Export {
                author_id: before.selected_author_id.clone(),
                path: Some(f.root.join("late.json").to_string_lossy().into()),
            }
        } else {
            Action::Select(before.selected_author_id.clone())
        };
        let result = tauri::async_runtime::block_on(perform(
            &f.state,
            expectation(before),
            "stale".into(),
            action,
        ));
        assert!(
            result.is_err(),
            "a changed store must fail even when the operation writes no preference"
        );
        assert!(!f.root.join("late.json").exists());
    }
}
#[test]
fn profiles_same_uuid_is_noop_and_other_uuid_preserves_private_history() {
    let f = Fixture::new(true);
    let original = f.snapshot();
    let other = f.create("Other");
    {
        let mut current = f.state.0.lock().unwrap();
        let p = current.as_mut().unwrap();
        let d = p.snapshot().unwrap().document;
        p.apply_change(
            &d.project_id,
            d.revision,
            Change::AddCategory {
                category: Category {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: "own draft".into(),
                    color: "#aabbcc".into(),
                },
            },
        )
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
    let noop = f
        .act(Action::Select(original.selected_author_id.clone()))
        .unwrap();
    assert!(noop.transition.is_none());
    assert_eq!(noop.profiles.runtime_nonce, original.runtime_nonce);
    assert!(f.act(Action::Select(other.author_id.clone())).is_err());
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
        before.document
    );
    {
        let mut c = f.state.0.lock().unwrap();
        let p = c.as_mut().unwrap();
        p.save(&before.document.project_id, before.document.revision)
            .unwrap();
    }
    assert!(
        f.act(Action::Select(other.author_id.clone())).is_err(),
        "saved but unpublished work is a barrier"
    );
    let e = crate::commands::collaboration::runtime::Expected {
        runtime_nonce: original.runtime_nonce.clone(),
        project_id: before.document.project_id.clone(),
        expected_revision: before.document.revision,
    };
    tauri::async_runtime::block_on(crate::commands::collaboration::refresh(&f.state, e)).unwrap();
    f.act(Action::Select(other.author_id)).unwrap();
    assert!(f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .document
        .categories
        .is_empty());
    f.act(Action::Select(original.selected_author_id)).unwrap();
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
            .categories,
        before.document.categories
    );
}
#[test]
fn profiles_selection_respects_writer_workspace_cancel_and_runtime_failures() {
    for failure in [
        "writer",
        "workspace",
        "cancel",
        "runtime",
        "retained",
        "preparing",
    ] {
        let f = Fixture::new(true);
        let other = f.create("Target");
        let before = f.snapshot();
        let repo = f.state.6.current.lock().unwrap().repo.clone().unwrap();
        let actor = if failure == "writer" {
            Some(Arc::new(repo.adopt(&other).unwrap()))
        } else {
            None
        };
        if failure == "workspace" {
            let target = Arc::new(repo.adopt(&other).unwrap());
            let workspace =
                LocalProject::open_shared(repo.clone(), Some(target), &f.state.6.local().unwrap())
                    .unwrap();
            let root = workspace.storage_root().to_owned();
            drop(workspace);
            for name in ["workspace.json", "workspace.recovery.json"] {
                fs::write(root.join(name), b"broken target workspace").unwrap();
            }
        }
        let preparation = if failure == "preparing" {
            Some(
                f.state
                    .6
                    .begin_preparation(
                        "prepare".into(),
                        Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                    .unwrap(),
            )
        } else {
            None
        };
        if failure == "retained" {
            f.state.1.lock().unwrap().begin("import".into()).unwrap();
        }
        if failure == "cancel" || failure == "runtime" {
            let state = f.state.clone();
            let failure = failure.to_owned();
            *f.state.6.after_io.lock().unwrap() = Some(Box::new(move || {
                if failure == "cancel" {
                    state.6.cancel("profile-op").unwrap();
                } else {
                    state.6.current.lock().unwrap().nonce = uuid::Uuid::new_v4().to_string();
                }
            }));
        }
        assert!(f.act(Action::Select(other.author_id)).is_err(), "{failure}");
        assert_eq!(f.actor(), before.selected_author_id);
        assert_eq!(f.snapshot().selected_author_id, before.selected_author_id);
        assert_eq!(
            f.state
                .6
                .profile_store()
                .unwrap()
                .snapshot()
                .unwrap()
                .last_selected_author_id,
            before.selected_author_id
        );
        drop((actor, preparation));
    }
}
#[cfg(windows)]
#[test]
fn profiles_persistence_failure_retains_editor_and_rename_failure_returns_partial_warning() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new(true);
    let other = f.create("Target");
    let before = f.snapshot();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(f.root.join("local").join(STORE_FILE_NAME))
        .unwrap();
    assert!(f.act(Action::Select(other.author_id)).is_err());
    assert_eq!(f.actor(), before.selected_author_id);
    assert_eq!(f.snapshot().runtime_nonce, before.runtime_nonce);
    drop(held);
    let record = f
        .root
        .join("project/authors")
        .join(format!("{}.json", before.selected_author_id));
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&record)
        .unwrap();
    let renamed = f
        .act(Action::Rename {
            author_id: before.selected_author_id.clone(),
            display_name: "New nickname".into(),
        })
        .unwrap();
    assert_eq!(
        renamed.warning.unwrap().message,
        "昵称已保存在本机，项目显示名称未更新"
    );
    assert_eq!(
        renamed
            .profiles
            .profiles
            .iter()
            .find(|p| p.author_id == before.selected_author_id)
            .unwrap()
            .display_name,
        "New nickname"
    );
    assert_eq!(
        renamed.status.unwrap().actor.unwrap().display_name,
        "New nickname"
    );
    assert_eq!(f.actor(), before.selected_author_id);
    assert_eq!(f.snapshot().runtime_nonce, before.runtime_nonce);
    drop(held);
    f.act(Action::Rename {
        author_id: before.selected_author_id,
        display_name: "Retry".into(),
    })
    .unwrap();
    assert!(fs::read_to_string(record).unwrap().contains("Retry"));
}
#[test]
fn profiles_view_only_and_ordinary_selection_does_not_replace_document_or_actor() {
    for shared in [true, false] {
        let f = Fixture::new(shared);
        let other = f.create("Other");
        if shared {
            *f.state.0.lock().unwrap() = None;
            f.state.6.retire();
            tauri::async_runtime::block_on(crate::commands::collaboration::open_mode(
                &f.state,
                f.root.join("project").to_string_lossy().into(),
                true,
            ))
            .unwrap();
        } else {
            *f.state.0.lock().unwrap() =
                Some(LocalProject::create(&f.root.join("project"), "Ordinary".into()).unwrap());
        }
        let before = f
            .state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document;
        let nonce = f.snapshot().runtime_nonce;
        let result = f.act(Action::Select(other.author_id)).unwrap();
        assert!(result.transition.is_none());
        assert_eq!(f.snapshot().runtime_nonce, nonce);
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
            before
        );
        if shared {
            assert!(
                runtime::status(f.state.0.lock().unwrap().as_ref(), &f.state.6)
                    .unwrap()
                    .actor
                    .is_none()
            );
        }
    }
}

#[test]
fn profiles_retained_folder_preview_blocks_selection_until_release() {
    let f = Fixture::new(true);
    let other = f.create("Other");
    let before = f.snapshot();
    let (token, _) = f.state.5.lock().unwrap().begin().unwrap();
    assert!(f.act(Action::Select(other.author_id.clone())).is_err());
    assert_eq!(f.snapshot().selected_author_id, before.selected_author_id);
    assert!(f.state.5.lock().unwrap().is_current(&token));
    f.state.5.lock().unwrap().release(&token).unwrap();
    f.act(Action::Select(other.author_id)).unwrap();
}

#[test]
fn profiles_process_selection_advances_revision_when_launch_preference_already_matches() {
    let f = Fixture::new(false);
    let target = f.create("Target");
    let store = f.state.6.profile_store().unwrap();
    store
        .select(store.snapshot().unwrap().revision, &target.author_id)
        .unwrap();
    let before = f.snapshot();
    assert_ne!(before.selected_author_id, target.author_id);
    let old = expectation(before.clone());
    let result = f.act(Action::Select(target.author_id)).unwrap();
    assert!(result.profiles.store_revision > before.store_revision);
    assert!(tauri::async_runtime::block_on(perform(
        &f.state,
        old,
        "old".into(),
        Action::Create("stale".into())
    ))
    .is_err());
}

#[test]
fn profiles_initialize_before_ordinary_and_view_only_open() {
    let ordinary = Fixture::new(false);
    drop(LocalProject::create(&ordinary.root.join("project"), "Ordinary".into()).unwrap());
    tauri::async_runtime::block_on(crate::commands::collaboration::open(
        &ordinary.state,
        ordinary.root.join("project").to_string_lossy().into(),
    ))
    .unwrap();
    assert!(ordinary.root.join("local/profiles.json").exists());
    let shared = Fixture::new(true);
    let viewer = AppState::default();
    viewer
        .6
        .set_local(shared.root.join("viewer-local"))
        .unwrap();
    tauri::async_runtime::block_on(crate::commands::collaboration::open_mode(
        &viewer,
        shared.root.join("project").to_string_lossy().into(),
        true,
    ))
    .unwrap();
    assert!(shared.root.join("viewer-local/profiles.json").exists());
}

#[test]
fn profiles_list_snapshot_is_coherent_with_concurrent_selection() {
    use std::{sync::mpsc, time::Duration};
    for mode in ["empty", "ordinary", "viewOnly", "writable"] {
        let f = Fixture::new(matches!(mode, "viewOnly" | "writable"));
        if mode == "ordinary" {
            *f.state.0.lock().unwrap() =
                Some(LocalProject::create(&f.root.join("project"), "Ordinary".into()).unwrap());
        } else if mode == "viewOnly" {
            *f.state.0.lock().unwrap() = None;
            f.state.6.retire();
            tauri::async_runtime::block_on(crate::commands::collaboration::open_mode(
                &f.state,
                f.root.join("project").to_string_lossy().into(),
                true,
            ))
            .unwrap();
        }
        let target = f.create("Target");
        let before = f.snapshot();
        let (entered, arrival) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        *f.state.6.list_after_identity.lock().unwrap() = Some(Box::new(move || {
            entered.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(10)).unwrap();
        }));
        let state = f.state.clone();
        let worker = std::thread::spawn(move || tauri::async_runtime::block_on(list(&state)));
        arrival.recv_timeout(Duration::from_secs(10)).unwrap();
        // Complete A -> B after list has observed A, but before it captures the authority tuple.
        let selected = tauri::async_runtime::block_on(perform(
            &f.state,
            expectation(before.clone()),
            "concurrent-select".into(),
            Action::Select(target.author_id.clone()),
        ));
        release.send(()).unwrap();
        let listed = worker.join().unwrap().unwrap();
        let selected = selected.unwrap().profiles;
        assert_eq!(listed.selected_author_id, target.author_id, "{mode}");
        assert_eq!(listed.store_revision, selected.store_revision, "{mode}");
        assert_eq!(listed.runtime_nonce, selected.runtime_nonce, "{mode}");
        assert_eq!(listed.project, selected.project, "{mode}");
        if mode == "writable" {
            assert_ne!(listed.runtime_nonce, before.runtime_nonce);
            assert_eq!(f.actor(), listed.selected_author_id);
        } else {
            assert_eq!(listed.runtime_nonce, before.runtime_nonce);
        }
    }
}
