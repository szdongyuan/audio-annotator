use super::*;
use crate::{commands::collaboration::defaults, state::AppState};
use annotator_core::collaboration::organization::OrganizationOperation;
#[test]
fn organization_commands_are_independent_and_guarded() {
    tauri::async_runtime::block_on(async {
        let root =
            std::env::temp_dir().join(format!("organization-native-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        std::fs::create_dir(root.join("project")).unwrap();
        defaults::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Folders".into(),
        )
        .await
        .unwrap();
        let before = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap();
        let binding = Binding {
            runtime_nonce: state.6.current.lock().unwrap().nonce.clone(),
            project_id: before.document.project_id.clone(),
        };
        let snapshot = get(&state, binding.clone()).await.unwrap();
        println!(
            "organization_get IPC {}",
            serde_json::to_string(&snapshot).unwrap()
        );
        let operation = OrganizationOperation::CreateFolder {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id: None,
            name: "目录".into(),
        };
        let next = apply(&state, binding.clone(), 0, operation.clone())
            .await
            .unwrap();
        assert_eq!(next.organization.revision, 1);
        assert_eq!(snapshot.organization.revision, 0);
        assert!(apply(&state, binding.clone(), 0, operation.clone())
            .await
            .is_err());
        let after = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap();
        assert_eq!(
            serde_json::to_value(before).unwrap(),
            serde_json::to_value(after).unwrap()
        );
        let mut wrong = binding.clone();
        wrong.runtime_nonce = uuid::Uuid::new_v4().to_string();
        assert!(get(&state, wrong).await.is_err());
        let mut wrong_owner = binding.clone();
        wrong_owner.project_id = uuid::Uuid::new_v4().to_string();
        assert!(get(&state, wrong_owner.clone()).await.is_err());
        assert!(apply(&state, wrong_owner, 1, operation.clone())
            .await
            .is_err());
        let permit = state.6.begin("held".into()).unwrap();
        assert!(apply(&state, binding.clone(), 1, operation).await.is_err());
        drop(permit);
        assert_eq!(get(&state, binding).await.unwrap().organization.revision, 1);
    });
}

mod guard_tests {
    use super::*;
    use crate::commands::collaboration::{defaults, open_mode};
    use annotator_core::{
        collaboration::{atomic, WorkspaceFault},
        model::{Category, Change},
        project::LocalProject,
    };
    use std::fs;
    fn fixture() -> (AppState, std::path::PathBuf, Binding) {
        let root = std::env::temp_dir().join(format!("org-guards-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(defaults::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "guards".into(),
        ))
        .unwrap();
        let binding = Binding {
            runtime_nonce: state.6.current.lock().unwrap().nonce.clone(),
            project_id: state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .snapshot()
                .unwrap()
                .document
                .project_id,
        };
        (state, root, binding)
    }
    fn create() -> OrganizationOperation {
        OrganizationOperation::CreateFolder {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id: None,
            name: "folder".into(),
        }
    }
    #[test]
    fn recycled_subtree_removal_rechecks_restore_and_retains_native_guards() {
        use annotator_core::collaboration::recycle::RecycleOperation;
        use std::{
            sync::{atomic::AtomicBool, mpsc},
            time::Duration,
        };
        for mode in ["commit", "restored", "cancel", "replace"] {
            let (state, root, binding) = fixture();
            let folder = uuid::Uuid::new_v4().to_string();
            tauri::async_runtime::block_on(apply(
                &state,
                binding.clone(),
                0,
                OrganizationOperation::CreateFolder {
                    id: folder.clone(),
                    parent_id: None,
                    name: "remove".into(),
                },
            ))
            .unwrap();
            let repo = state.6.current.lock().unwrap().repo.clone().unwrap();
            let actor = state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .workspace()
                .unwrap()
                .author_session()
                .unwrap();
            let cancel = AtomicBool::new(false);
            let plan = repo
                .seal_media_placement(
                    1,
                    Some(folder.clone()),
                    vec!["deep".into()],
                    "original.wav".into(),
                )
                .unwrap();
            let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/audio/mono16.wav");
            let prepared = repo
                .prepare_media(&source, &root.join("pcm"), &cancel)
                .unwrap()
                .with_placement(plan)
                .unwrap();
            repo.append_media(&actor, &prepared, &cancel).unwrap();
            let media_id = prepared.media().id.clone();
            repo.apply_recycle_controlled(
                &actor,
                0,
                RecycleOperation {
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    media_ids: vec![media_id.clone()],
                    trash: true,
                },
                &cancel,
                || Ok(()),
            )
            .unwrap();
            let private_before = serde_json::to_value(
                state
                    .0
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .snapshot()
                    .unwrap(),
            )
            .unwrap();
            let before = fs::read(root.join("project/organization.json")).unwrap();
            let audio_path = root
                .join("project")
                .join(&repo.reload_catalog().unwrap().manifest().media[0].source_ref);
            let audio = fs::read(&audio_path).unwrap();
            if mode == "restored" {
                repo.apply_recycle_controlled(
                    &actor,
                    1,
                    RecycleOperation {
                        operation_id: uuid::Uuid::new_v4().to_string(),
                        media_ids: vec![media_id],
                        trash: false,
                    },
                    &cancel,
                    || Ok(()),
                )
                .unwrap();
                assert!(tauri::async_runtime::block_on(apply(
                    &state,
                    binding,
                    2,
                    OrganizationOperation::RemoveFolder { id: folder }
                ))
                .is_err());
            } else {
                let (entered, wait_entered) = mpsc::channel();
                let (resume, wait_resume) = mpsc::channel();
                *state.6.hook.lock().unwrap() = Some(Box::new(move || {
                    entered.send(()).unwrap();
                    wait_resume.recv().unwrap();
                }));
                let worker_state = state.clone();
                let worker = std::thread::spawn(move || {
                    tauri::async_runtime::block_on(apply(
                        &worker_state,
                        binding,
                        2,
                        OrganizationOperation::RemoveFolder { id: folder },
                    ))
                });
                wait_entered.recv_timeout(Duration::from_secs(10)).unwrap();
                let lock = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(root.join("project/catalog/.commit.lock"))
                    .unwrap();
                let locked = lock.try_lock().is_err();
                let responsive = state.0.try_lock().is_ok();
                drop(lock);
                if mode == "cancel" {
                    state.6.retire();
                }
                if mode == "replace" {
                    *state.0.lock().unwrap() = None;
                }
                resume.send(()).unwrap();
                let result = worker.join().unwrap();
                assert!(
                    locked,
                    "recycle and folder changes must share the catalog lock"
                );
                assert!(responsive);
                if mode == "commit" {
                    let head = result.unwrap().organization;
                    assert_eq!(head.revision, 3);
                    assert!(head.folders.is_empty());
                    assert_eq!(head.media[0].folder_id, None);
                    assert_eq!(head.media[0].original_filename, "original.wav");
                } else {
                    assert!(result.is_err());
                }
            }
            if mode != "commit" {
                assert_eq!(
                    fs::read(root.join("project/organization.json")).unwrap(),
                    before
                );
            }
            assert_eq!(fs::read(audio_path).unwrap(), audio);
            if mode != "replace" {
                assert_eq!(
                    serde_json::to_value(
                        state
                            .0
                            .lock()
                            .unwrap()
                            .as_ref()
                            .unwrap()
                            .snapshot()
                            .unwrap()
                    )
                    .unwrap(),
                    private_before
                );
            }
        }
    }
    #[test]
    fn readonly_get_and_pending_recovery_get_work_while_writes_are_refused() {
        let (state, root, binding) = fixture();
        let reader = AppState::default();
        reader.6.set_local(root.join("reader")).unwrap();
        tauri::async_runtime::block_on(open_mode(
            &reader,
            root.join("project").to_string_lossy().into(),
            true,
        ))
        .unwrap();
        let read_binding = Binding {
            runtime_nonce: reader.6.current.lock().unwrap().nonce.clone(),
            project_id: binding.project_id.clone(),
        };
        assert!(tauri::async_runtime::block_on(get(&reader, read_binding.clone())).is_ok());
        assert!(tauri::async_runtime::block_on(apply(&reader, read_binding, 0, create())).is_err());
        let (repo, actor) = {
            let mut current = state.0.lock().unwrap();
            let p = current.as_mut().unwrap();
            let d = p.snapshot().unwrap().document;
            p.apply_change(
                &d.project_id,
                d.revision,
                Change::AddCategory {
                    category: Category {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "unsaved".into(),
                        color: "#aabbcc".into(),
                    },
                },
            )
            .unwrap();
            let d = p.snapshot().unwrap().document;
            p.workspace_mut()
                .unwrap()
                .inject_fault(Some(WorkspaceFault::MainReplace));
            assert!(p.save(&d.project_id, d.revision).is_err());
            (
                state.6.current.lock().unwrap().repo.clone().unwrap(),
                p.workspace().unwrap().author_session().unwrap(),
            )
        };
        *state.0.lock().unwrap() = None;
        let p = LocalProject::open_shared(repo, Some(actor), &state.6.local().unwrap()).unwrap();
        assert!(p.recovery().is_some());
        *state.0.lock().unwrap() = Some(p);
        assert!(tauri::async_runtime::block_on(get(&state, binding.clone())).is_ok());
        let before = fs::read(root.join("project/organization.json")).unwrap();
        assert!(tauri::async_runtime::block_on(apply(&state, binding, 0, create())).is_err());
        assert_eq!(
            fs::read(root.join("project/organization.json")).unwrap(),
            before
        );
    }
    #[test]
    fn committed_late_cancel_and_head_write_failure_preserve_personal_history() {
        let (state, root, binding) = fixture();
        {
            let mut current = state.0.lock().unwrap();
            let p = current.as_mut().unwrap();
            let d = p.snapshot().unwrap().document;
            p.apply_change(
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
        }
        let repo = state.6.current.lock().unwrap().repo.clone().unwrap();
        let before = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap();
        let generation = state.1.lock().unwrap().generation();
        let service = state.6.clone();
        *state.6.after_io.lock().unwrap() = Some(Box::new(move || service.retire()));
        assert_eq!(
            tauri::async_runtime::block_on(apply(&state, binding.clone(), 0, create()))
                .unwrap()
                .organization
                .revision,
            1
        );
        assert_eq!(state.1.lock().unwrap().generation(), generation);
        assert_eq!(
            serde_json::to_value(
                state
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
        state.6.install(Some(repo)).unwrap();
        let before = fs::read(root.join("project/organization.json")).unwrap();
        let file = fs::File::open(root.join("project/organization.json")).unwrap();
        atomic::verify_lock_path(&root.join("project/organization.json"), &file).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let locked = fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(root.join("project/organization.json"))
                .unwrap();
            let new_binding = Binding {
                runtime_nonce: state.6.current.lock().unwrap().nonce.clone(),
                project_id: binding.project_id,
            };
            assert!(
                tauri::async_runtime::block_on(apply(&state, new_binding, 1, create())).is_err()
            );
            drop(locked);
        }
        assert_eq!(
            fs::read(root.join("project/organization.json")).unwrap(),
            before
        );
    }
    #[test]
    fn precommit_gate_keeps_private_editor_accessible_and_rejects_cancelled_or_replaced_owner() {
        use std::{sync::mpsc, time::Duration};
        for mode in ["commit", "cancel", "replace"] {
            let (state, root, binding) = fixture();
            let before = fs::read(root.join("project/organization.json")).unwrap();
            let (entered, wait_entered) = mpsc::channel();
            let (resume, wait_resume) = mpsc::channel();
            *state.6.hook.lock().unwrap() = Some(Box::new(move || {
                entered.send(()).unwrap();
                wait_resume.recv().unwrap();
            }));
            let worker_state = state.clone();
            let worker = std::thread::spawn(move || {
                tauri::async_runtime::block_on(apply(&worker_state, binding, 0, create()))
            });
            wait_entered.recv_timeout(Duration::from_secs(10)).unwrap();
            let editor_accessible = state.0.try_lock().is_ok();
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join("project/catalog/.commit.lock"))
                .unwrap();
            let transaction_holds_catalog_lock = lock.try_lock().is_err();
            drop(lock);
            let old_head_unchanged =
                fs::read(root.join("project/organization.json")).unwrap() == before;
            if mode == "cancel" {
                state.6.retire();
            }
            if mode == "replace" {
                *state.0.lock().unwrap() = None;
            }
            resume.send(()).unwrap();
            let result = worker.join().unwrap();
            assert!(
                editor_accessible,
                "private editor was blocked by catalog I/O"
            );
            assert!(
                transaction_holds_catalog_lock,
                "gate must exercise the real under-lock precommit boundary"
            );
            assert!(old_head_unchanged);
            if mode == "commit" {
                assert_eq!(result.unwrap().organization.revision, 1);
            } else {
                assert!(result.is_err());
                assert_eq!(
                    fs::read(root.join("project/organization.json")).unwrap(),
                    before
                );
            }
        }
    }
    #[test]
    fn interprocess_lock_wait_does_not_block_the_private_editor() {
        use std::{
            sync::mpsc,
            time::{Duration, Instant},
        };
        let (state, root, binding) = fixture();
        let catalog_lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("project/catalog/.commit.lock"))
            .unwrap();
        catalog_lock.try_lock().unwrap();
        // Handshake at the existing authority lock: the worker must enter its capture
        // before the editor probe, eliminating a scheduler-dependent false pass.
        let current = state.0.lock().unwrap();
        let runtime = state.6.current.lock().unwrap();
        let worker_state = state.clone();
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(apply(&worker_state, binding, 0, create()))
        });
        drop(current);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut worker_entered = false;
        while Instant::now() < deadline {
            if state.0.try_lock().is_err() {
                worker_entered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        drop(runtime);
        let (send, receive) = mpsc::channel();
        let editor_state = state.clone();
        let editor = std::thread::spawn(move || {
            let current = editor_state.0.lock().unwrap();
            send.send(current.as_ref().unwrap().snapshot().is_ok())
                .unwrap();
        });
        let responsive = receive
            .recv_timeout(Duration::from_secs(1))
            .unwrap_or(false);
        // The competing process still owns the catalog lock until after the probe.
        drop(catalog_lock);
        let result = worker.join().unwrap();
        editor.join().unwrap();
        assert!(worker_entered);
        assert!(responsive, "catalog lock wait blocked the private editor");
        assert!(result.is_ok());
    }
}
