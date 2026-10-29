use super::*;
use annotator_core::collaboration::{
    profiles::Profile, recycle::RecycleOperation, CollaborationRepository,
};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}
struct Fixture {
    root: PathBuf,
    state: AppState,
    ids: Vec<String>,
    audio: Vec<PathBuf>,
}
impl Fixture {
    fn new() -> Self {
        Self::with_media_count(2)
    }
    fn with_media_count(count: usize) -> Self {
        let root = std::env::temp_dir().join(format!("native-purge-{}", id()));
        fs::create_dir_all(root.join("shared")).unwrap();
        let (repo, actor) = CollaborationRepository::create_default(
            &root.join("shared"),
            "Purge",
            &Profile::new("Importer").unwrap(),
        )
        .unwrap();
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio/mono16.wav");
        let mut ids = vec![];
        for _ in 0..count {
            let p = repo
                .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
                .unwrap();
            ids.push(p.media().id.clone());
            repo.append_media(&actor, &p, &AtomicBool::new(false))
                .unwrap();
        }
        drop(actor);
        let repo = repo.reload_catalog().unwrap();
        let audio = ids
            .iter()
            .map(|id| {
                root.join("shared").join(
                    &repo
                        .manifest()
                        .media
                        .iter()
                        .find(|m| &m.id == id)
                        .unwrap()
                        .source_ref,
                )
            })
            .collect();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        run(super::super::collaboration::open(
            &state,
            root.join("shared").to_string_lossy().into(),
        ))
        .unwrap();
        Self {
            root,
            state,
            ids,
            audio,
        }
    }
    fn args(&self, selection: PurgeSelection) -> PreviewArgs {
        let r = self.state.6.current.lock().unwrap();
        PreviewArgs {
            runtime_nonce: r.nonce.clone(),
            project_id: r.repo.as_ref().unwrap().manifest().project_id.clone(),
            operation_id: id(),
            selection,
            offset: 0,
            limit: 1,
        }
    }
    fn trash(&self, ids: Vec<String>) {
        let p = self.state.0.lock().unwrap();
        let actor = p
            .as_ref()
            .unwrap()
            .workspace()
            .unwrap()
            .author_session()
            .unwrap();
        let r = CollaborationRepository::open(&self.root.join("shared")).unwrap();
        r.apply_recycle_controlled(
            &actor,
            r.read_recycle().unwrap().revision,
            RecycleOperation {
                operation_id: id(),
                media_ids: ids,
                trash: true,
            },
            &AtomicBool::new(false),
            || Ok(()),
        )
        .unwrap();
    }
    fn confirm(&self, p: &PurgePreview) -> CommitArgs {
        CommitArgs {
            runtime_nonce: p.runtime_nonce.clone(),
            project_id: p.project_id.clone(),
            operation_id: p.operation_id.clone(),
            preview_id: p.preview_id.clone(),
        }
    }
    fn operation(&self, p: &PurgePreview) -> OperationArgs {
        OperationArgs {
            runtime_nonce: p.runtime_nonce.clone(),
            project_id: p.project_id.clone(),
            operation_id: p.operation_id.clone(),
        }
    }
    fn page_args(&self, p: &PurgePreview) -> PageArgs {
        PageArgs {
            runtime_nonce: p.runtime_nonce.clone(),
            project_id: p.project_id.clone(),
            operation_id: p.operation_id.clone(),
            offset: 0,
            limit: 50,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.0.lock().unwrap().take();
        self.state.6.retire();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn preview_pages_keep_fixed_scope_and_commit_retries_same_capability() {
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let args = f.args(PurgeSelection::All);
    let p = run(preview(&f.state, args.clone())).unwrap();
    assert_eq!(p.requested_count, 1);
    assert!(p.requires_format_upgrade);
    f.trash(vec![f.ids[1].clone()]);
    let p2 = run(preview(&f.state, args)).unwrap();
    assert_eq!(p.preview_id, p2.preview_id);
    assert_eq!(p2.requested_count, 1);
    let result = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(result.removed_ids, vec![f.ids[0].clone()]);
    assert!(!f.audio[0].exists());
    assert!(f.audio[1].exists());
    assert_eq!(
        run(commit(&f.state, f.confirm(&p))).unwrap().removed_ids,
        result.removed_ids
    );
    assert_eq!(run(page(&f.state, f.page_args(&p))).unwrap().total, 0);
    assert_eq!(
        run(retry(&f.state, f.operation(&p))).unwrap().status,
        "complete"
    );
}

#[test]
fn native_cleanup_reports_real_windows_share_denial_then_same_operation_completes() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&f.audio[0])
        .unwrap();
    let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
    let result = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(result.status, "committed-pending-cleanup");
    assert_eq!(result.deleted_audio_bytes, 0);
    let cleanup = run(page(&f.state, f.page_args(&p))).unwrap();
    assert_eq!(cleanup.total, result.cleanup_pending_count);
    let mut small = f.page_args(&p);
    small.limit = 1;
    let first = run(page(&f.state, small.clone())).unwrap();
    assert_eq!(first.total, cleanup.total);
    assert_eq!(first.items.len(), 1);
    small.offset = 1;
    let second = run(page(&f.state, small.clone())).unwrap();
    assert_eq!(second.total, cleanup.total);
    assert!(second.items.len() <= 1);
    if let Some(item) = second.items.first() {
        assert_ne!(item.cleanup_id, first.items[0].cleanup_id);
    }
    small.limit = 51;
    assert!(run(page(&f.state, small.clone())).is_err());
    small.limit = 1;
    small.runtime_nonce = id();
    assert!(run(page(&f.state, small)).is_err());
    assert_eq!(
        cleanup
            .items
            .iter()
            .filter(|i| i.status == "failed")
            .count(),
        result.cleanup_failed_count
    );
    let audio = cleanup
        .items
        .iter()
        .find(|i| {
            i.media_id.as_ref() == Some(&f.ids[0])
                && matches!(
                    i.kind,
                    annotator_core::collaboration::purge::cleanup::CleanupKind::Audio
                )
        })
        .unwrap();
    assert_eq!(audio.status, "failed");
    assert!(audio.error.is_some());
    assert!(!audio.cleanup_id.contains('/'));
    assert!(!audio.cleanup_id.contains('\\'));
    drop(held);
    let result = run(retry(&f.state, f.operation(&p))).unwrap();
    assert_eq!(result.status, "complete");
    assert!(result.deleted_audio_bytes > 0);
    assert_eq!(run(page(&f.state, f.page_args(&p))).unwrap().total, 0);
    assert!(!f.audio[0].exists());
}

#[test]
fn bindings_forgery_readonly_and_pagination_fail_closed_without_upgrade() {
    let f = Fixture::new();
    f.trash(f.ids.clone());
    let args = f.args(PurgeSelection::All);
    let original = fs::read(f.root.join("shared/collaboration.json")).unwrap();
    let mut bad = args.clone();
    bad.runtime_nonce = id();
    assert!(run(preview(&f.state, bad)).is_err());
    let mut bad = args.clone();
    bad.project_id = id();
    assert!(run(preview(&f.state, bad)).is_err());
    let mut bad = args.clone();
    bad.limit = 51;
    assert!(run(preview(&f.state, bad)).is_err());
    let p = run(preview(&f.state, args.clone())).unwrap();
    assert_eq!(p.items.len(), 1);
    assert_eq!(p.requested_count, 2);
    let mut second = args;
    second.offset = 1;
    let second = run(preview(&f.state, second)).unwrap();
    assert_eq!(second.preview_id, p.preview_id);
    assert_ne!(second.items[0].media_id, p.items[0].media_id);
    let mut bad = f.confirm(&p);
    bad.preview_id = id();
    assert!(run(commit(&f.state, bad)).is_err());
    let mut bad = f.confirm(&p);
    bad.operation_id = id();
    assert!(run(commit(&f.state, bad)).is_err());
    // The native actor binding is independent of the caller's nonce/UUIDs.
    let repo = std::sync::Arc::new(CollaborationRepository::open(&f.root.join("shared")).unwrap());
    let actor = std::sync::Arc::new(
        repo.adopt(&Profile::new("Different actor").unwrap())
            .unwrap(),
    );
    fs::create_dir_all(f.root.join("different-actor")).unwrap();
    let other = annotator_core::project::LocalProject::open_shared(
        repo,
        Some(actor),
        &f.root.join("different-actor"),
    )
    .unwrap();
    let original_project = f.state.0.lock().unwrap().replace(other);
    assert!(run(commit(&f.state, f.confirm(&p))).is_err());
    *f.state.0.lock().unwrap() = original_project;
    assert_eq!(
        original,
        fs::read(f.root.join("shared/collaboration.json")).unwrap()
    );
    let read = AppState::default();
    read.6.set_local(f.root.join("readonly")).unwrap();
    run(super::super::collaboration::open_mode(
        &read,
        f.root.join("shared").to_string_lossy().into(),
        true,
    ))
    .unwrap();
    let mut bad = f.args(PurgeSelection::All);
    bad.runtime_nonce = read.6.current.lock().unwrap().nonce.clone();
    assert!(run(preview(&read, bad)).is_err());
    let result = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(result.removed_ids.len(), 2);
    let mut query = f.page_args(&p);
    query.runtime_nonce = read.6.current.lock().unwrap().nonce.clone();
    assert_eq!(run(page(&read, query.clone())).unwrap().total, 0);
    assert!(run(retry(
        &read,
        OperationArgs {
            runtime_nonce: query.runtime_nonce,
            project_id: query.project_id,
            operation_id: query.operation_id
        }
    ))
    .is_err());
}

#[test]
fn cancel_and_replacement_before_commit_preserve_entry_and_after_commit_cannot_rollback() {
    for committed in [false, true] {
        let f = Fixture::new();
        f.trash(vec![f.ids[0].clone()]);
        let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
        let before = fs::read(f.root.join("shared/collaboration.json")).unwrap();
        let worker = f.state.clone();
        let op = p.operation_id.clone();
        let hook: Box<dyn FnOnce() + Send> = Box::new(move || {
            worker.6.cancel(&op).unwrap();
            worker.0.lock().unwrap().take();
            worker.6.retire();
        });
        if committed {
            *f.state.6.after_io.lock().unwrap() = Some(hook);
        } else {
            *f.state.6.hook.lock().unwrap() = Some(hook);
        }
        let result = run(commit(&f.state, f.confirm(&p)));
        if committed {
            assert_eq!(result.unwrap().removed_ids, vec![f.ids[0].clone()]);
        } else {
            assert!(result.is_err());
            assert_eq!(
                before,
                fs::read(f.root.join("shared/collaboration.json")).unwrap()
            );
        }
        assert!(f.state.0.lock().unwrap().is_none());
        let fresh = CollaborationRepository::open(&f.root.join("shared")).unwrap();
        assert_eq!(
            fresh.manifest().media.iter().any(|m| m.id == f.ids[0]),
            !committed
        );
    }
}

#[test]
fn preview_reason_count_covers_fixed_scope_outside_first_page() {
    use annotator_core::collaboration::{LayerPayload, MediaLabels};
    let f = Fixture::new();
    let repo = CollaborationRepository::open(&f.root.join("shared")).unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    // The foreign-annotated ID sorts after another real target, so it cannot
    // appear on the first one-item page, independently of generated UUIDs.
    let foreign = f.ids.iter().max().unwrap().clone();
    let category = annotator_core::model::Category {
        id: id(),
        name: "Foreign tag".into(),
        color: "#aabbcc".into(),
    };
    repo.publish(
        &bob,
        None,
        &LayerPayload {
            categories: vec![category.clone()],
            annotations: vec![],
            media_labels: vec![MediaLabels {
                media_id: foreign.clone(),
                note: String::new(),
                channel_notes: vec![String::new()],
                category_ids: vec![category.id],
                channel_category_ids: vec![vec![]],
            }],
        },
    )
    .unwrap();
    f.trash(f.ids.clone());
    let mut targets = f.ids.clone();
    targets.extend((0..51).map(|_| id()));
    targets.sort();
    let mut args = f.args(PurgeSelection::Selected(targets.clone()));
    let first = run(preview(&f.state, args.clone())).unwrap();
    assert_eq!(first.requested_count, 53);
    assert_eq!(first.eligible_count, 1);
    assert_eq!(first.retained_count, 52);
    assert_eq!(first.items.len(), 1);
    assert_ne!(first.items[0].media_id, foreign);
    assert_eq!(
        serde_json::to_value(&first).unwrap()["otherAuthorRetainedCount"],
        serde_json::json!(1)
    );
    args.offset = targets.iter().position(|id| id == &foreign).unwrap();
    let foreign_page = run(preview(&f.state, args)).unwrap();
    assert_eq!(foreign_page.items[0].media_id, foreign);
    assert_eq!(
        foreign_page.items[0].reason,
        Some(PurgeBlockReason::OtherAuthorAnnotation)
    );
    assert_eq!(first.preview_id, foreign_page.preview_id);
    assert_eq!(
        serde_json::to_value(&foreign_page).unwrap()["otherAuthorRetainedCount"],
        serde_json::json!(1)
    );
}

#[test]
fn all_includes_unadopted_media_and_mixed_foreign_permissions() {
    use annotator_core::collaboration::{LayerPayload, MediaLabels};
    let f = Fixture::new();
    let repo = CollaborationRepository::open(&f.root.join("shared")).unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio/mono16.wav");
    let c = repo
        .prepare_media(&source, &f.root.join("more-pcm"), &AtomicBool::new(false))
        .unwrap();
    repo.append_media(&bob, &c, &AtomicBool::new(false))
        .unwrap();
    let c_id = c.media().id.clone();
    let repo = repo.reload_catalog().unwrap();
    let category = annotator_core::model::Category {
        id: id(),
        name: "Foreign tag".into(),
        color: "#aabbcc".into(),
    };
    repo.publish(
        &bob,
        None,
        &LayerPayload {
            categories: vec![category.clone()],
            annotations: vec![],
            media_labels: vec![
                MediaLabels {
                    media_id: f.ids[0].clone(),
                    note: String::new(),
                    channel_notes: vec![String::new()],
                    category_ids: vec![category.id],
                    channel_category_ids: vec![vec![]],
                },
                MediaLabels {
                    media_id: c_id.clone(),
                    note: "Only a note, permitted".into(),
                    channel_notes: vec![String::new()],
                    category_ids: vec![],
                    channel_category_ids: vec![vec![]],
                },
            ],
        },
    )
    .unwrap();
    f.trash(vec![f.ids[0].clone(), c_id.clone()]);
    let mut args = f.args(PurgeSelection::All);
    args.limit = 50;
    let p = run(preview(&f.state, args)).unwrap();
    assert_eq!(p.requested_count, 2);
    assert_eq!(p.eligible_count, 1);
    assert_eq!(p.retained_count, 1);
    assert_eq!(p.other_author_retained_count, 1);
    assert!(p
        .items
        .iter()
        .any(|i| i.media_id == c_id && i.reason.is_none()));
    let mut selected = f.args(PurgeSelection::Selected(vec![
        f.ids[0].clone(),
        f.ids[1].clone(),
        c_id.clone(),
    ]));
    selected.limit = 50;
    let mixed = run(preview(&f.state, selected)).unwrap();
    assert_eq!(mixed.requested_count, 3);
    assert_eq!(mixed.eligible_count, 1);
    assert_eq!(mixed.retained_count, 2);
    assert_eq!(mixed.other_author_retained_count, 1);
    assert!(mixed
        .items
        .iter()
        .any(|i| i.media_id == f.ids[1] && i.reason == Some(PurgeBlockReason::NotInRecycle)));
    let result = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(result.removed_ids, vec![c_id]);
    assert_eq!(result.retained[0].media_id, f.ids[0]);
}

#[test]
fn retirement_removes_exact_registry_and_pending_decode_and_fences_late_hydration() {
    use annotator_core::media::decode::rehydrate;
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let mut descriptors = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .document
        .media;
    descriptors.sort_by_key(|m| f.ids.iter().position(|id| id == &m.id).unwrap());
    let generation = f.state.1.lock().unwrap().generation();
    for m in &descriptors {
        let d = rehydrate(
            m,
            &f.root.join("shared"),
            &f.root.join("worker-pcm"),
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        f.state
            .1
            .lock()
            .unwrap()
            .publish_rehydrated(generation, d)
            .unwrap();
    }
    let late = rehydrate(
        &descriptors[0],
        &f.root.join("shared"),
        &f.root.join("late-pcm"),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    let (_g, cancel) = f.state.1.lock().unwrap().begin("unrelated".into()).unwrap();
    let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
    run(commit(&f.state, f.confirm(&p))).unwrap();
    let mut tasks = f.state.1.lock().unwrap();
    assert!(
        tasks.registry.verified_stamp(&descriptors[0]).is_none(),
        "retired verification stamp must be released"
    );
    assert!(tasks.registry.get_unverified(&descriptors[0]).is_err());
    assert!(tasks.registry.get_unverified(&descriptors[1]).is_ok());
    assert_eq!(
        tasks.generation(),
        generation,
        "surviving jobs keep their generation"
    );
    assert!(!cancel.load(std::sync::atomic::Ordering::Acquire));
    assert!(
        tasks.publish_rehydrated(generation, late).is_err(),
        "late worker cannot resurrect retired ID"
    );
}

#[test]
fn unsaved_and_failed_personal_drain_and_unresolved_recovery_block_delete() {
    use annotator_core::{
        collaboration::WorkspaceFault,
        model::{Category, Change},
        project::LocalProject,
    };
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let args = f.args(PurgeSelection::All);
    {
        let mut current = f.state.0.lock().unwrap();
        let p = current.as_mut().unwrap();
        let d = p.snapshot().unwrap().document;
        p.apply_change(
            &d.project_id,
            d.revision,
            Change::AddCategory {
                category: Category {
                    id: id(),
                    name: "Accepted draft".into(),
                    color: "#aabbcc".into(),
                },
            },
        )
        .unwrap();
    }
    let original = fs::read(f.root.join("shared/collaboration.json")).unwrap();
    assert!(run(preview(&f.state, args.clone())).is_err());
    let (repo, actor) = {
        let mut current = f.state.0.lock().unwrap();
        let p = current.as_mut().unwrap();
        p.workspace_mut()
            .unwrap()
            .inject_fault(Some(WorkspaceFault::MainReplace));
        let d = p.snapshot().unwrap().document;
        assert!(p.save(&d.project_id, d.revision).is_err());
        (
            f.state.6.current.lock().unwrap().repo.clone().unwrap(),
            p.workspace().unwrap().author_session().unwrap(),
        )
    };
    f.state.0.lock().unwrap().take();
    let reopened =
        LocalProject::open_shared(repo, Some(actor), &f.state.6.local().unwrap()).unwrap();
    assert!(reopened.recovery().is_some());
    *f.state.0.lock().unwrap() = Some(reopened);
    assert!(run(preview(&f.state, args)).is_err());
    assert_eq!(
        original,
        fs::read(f.root.join("shared/collaboration.json")).unwrap()
    );
}

#[test]
fn readonly_reopen_discovers_real_pending_operation_without_writing_then_writable_resumes() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&f.audio[0])
        .unwrap();
    let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
    run(commit(&f.state, f.confirm(&p))).unwrap();
    let read = AppState::default();
    read.6.set_local(f.root.join("readonly")).unwrap();
    run(super::super::collaboration::open_mode(
        &read,
        f.root.join("shared").to_string_lossy().into(),
        true,
    ))
    .unwrap();
    let status = run(super::super::collaboration::status(&read)).unwrap();
    let value = serde_json::to_value(&status).unwrap();
    let operations = &value["purgeMaintenance"];
    assert_eq!(operations["total"], 1);
    assert_eq!(operations["items"][0]["operationId"], p.operation_id);
    assert_eq!(operations["items"][0]["committed"], true);
    assert!(
        operations["items"][0]["cleanupFailedCount"]
            .as_u64()
            .unwrap()
            > 0
    );
    let mut query = f.page_args(&p);
    query.runtime_nonce = status.runtime_nonce;
    let outstanding = run(page(&read, query.clone())).unwrap();
    assert!(outstanding.total > 0);
    assert!(run(retry(
        &read,
        OperationArgs {
            runtime_nonce: query.runtime_nonce,
            project_id: query.project_id,
            operation_id: query.operation_id
        }
    ))
    .is_err());
    drop(held);
    assert!(
        f.audio[0].exists(),
        "readonly query cannot unlink released file"
    );
    f.state.0.lock().unwrap().take();
    f.state.6.retire();
    run(super::super::collaboration::open(
        &f.state,
        f.root.join("shared").to_string_lossy().into(),
    ))
    .unwrap();
    assert!(
        !f.audio[0].exists(),
        "writable reopen continues bounded durable cleanup"
    );
    let args = OperationArgs {
        runtime_nonce: f.state.6.current.lock().unwrap().nonce.clone(),
        project_id: p.project_id.clone(),
        operation_id: p.operation_id.clone(),
    };
    let result = run(retry(&f.state, args)).unwrap();
    assert_eq!(result.removed_ids, vec![f.ids[0].clone()]);
    assert_eq!(result.status, "complete");
}

#[test]
fn late_native_analysis_hydration_cannot_register_a_and_survivor_reuses_view() {
    use annotator_core::analysis::{
        source::AnalysisSource,
        tiles::{config_hash, TileRequest},
    };
    use std::{sync::mpsc, time::Duration};
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
    let doc = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .document;
    let a = doc.media.iter().find(|m| m.id == f.ids[0]).unwrap().clone();
    let settings = doc.analysis.get(&a.id).cloned().unwrap_or_default();
    let view = f.state.2.scheduler.register_view().unwrap();
    let mut request = TileRequest {
        analysis_source: AnalysisSource::Original,
        processing_version: doc.algorithm_versions.dsp,
        edit_signature: String::new(),
        request_id: id(),
        view_id: view.clone(),
        project_id: doc.project_id,
        media_id: a.id.clone(),
        generation: 1,
        config_hash: config_hash(&settings),
        settings,
        channel_index: 0,
        kind: annotator_core::model::SpectrumKind::Stft,
        start_frame: 0,
        frame_count: 1,
        time_lod: 0,
        frequency_start: 0,
        frequency_count: 1,
        frequency_lod: 0,
        visible: true,
    };
    let (entered, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    *f.state.2.before_hydration_publish.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        wait.recv().unwrap();
    }));
    let result = super::super::analysis::enqueue_owned(
        f.state.clone(),
        Some(p.runtime_nonce.clone()),
        request.clone(),
        |_| true,
    )
    .unwrap();
    arrival.recv_timeout(Duration::from_secs(10)).unwrap();
    run(commit(&f.state, f.confirm(&p))).unwrap();
    release.send(()).unwrap();
    assert!(result
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .is_err());
    assert!(f
        .state
        .1
        .lock()
        .unwrap()
        .registry
        .verified_stamp(&a)
        .is_none());
    request.media_id = f.ids[1].clone();
    request.request_id = id();
    assert!(super::super::analysis::enqueue_owned(
        f.state.clone(),
        Some(p.runtime_nonce.clone()),
        request,
        |_| true
    )
    .unwrap()
    .recv_timeout(Duration::from_secs(10))
    .unwrap()
    .is_ok());
    assert_eq!(f.state.2.scheduler.live_views(), 1);
    assert_eq!(f.state.6.current.lock().unwrap().nonce, p.runtime_nonce);
}

#[test]
fn no_eligible_and_preview_cancellation_keep_format_five_and_reject_extra_ipc_targets() {
    let f = Fixture::new();
    let before = fs::read(f.root.join("shared/collaboration.json")).unwrap();
    let p = run(preview(
        &f.state,
        f.args(PurgeSelection::Selected(vec![f.ids[0].clone()])),
    ))
    .unwrap();
    assert_eq!(p.eligible_count, 0);
    assert_eq!(p.items[0].reason, Some(PurgeBlockReason::NotInRecycle));
    assert!(!p.requires_format_upgrade);
    let result = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(result.status, "no-eligible-items");
    assert_eq!(
        before,
        fs::read(f.root.join("shared/collaboration.json")).unwrap()
    );
    let mut value = serde_json::json!({"runtimeNonce":p.runtime_nonce,"projectId":p.project_id,"operationId":id(),"selection":{"kind":"all"},"offset":0,"limit":50});
    value["actorId"] = serde_json::json!(id());
    assert!(serde_json::from_value::<PreviewArgs>(value).is_err());
    let value = serde_json::json!({"runtimeNonce":p.runtime_nonce,"projectId":p.project_id,"operationId":p.operation_id,"previewId":p.preview_id,"mediaIds":f.ids});
    assert!(serde_json::from_value::<CommitArgs>(value).is_err());
    let value = serde_json::json!({"runtimeNonce":p.runtime_nonce,"projectId":p.project_id,"operationId":p.operation_id,"path":"C:/arbitrary"});
    assert!(serde_json::from_value::<OperationArgs>(value).is_err());
}

#[test]
fn incoming_retirement_releases_resources_on_refresh_adoption_and_import_without_resetting_b() {
    use annotator_core::media::decode::rehydrate;
    for mode in ["refresh", "adopt", "import"] {
        let f = Fixture::new();
        let doc = f
            .state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document;
        let nonce = f.state.6.current.lock().unwrap().nonce.clone();
        let generation = f.state.1.lock().unwrap().generation();
        for descriptor in &doc.media {
            let decoded = rehydrate(
                descriptor,
                &f.root.join("shared"),
                &f.root.join("runtime-pcm"),
                &AtomicBool::new(false),
                |_, _| {},
            )
            .unwrap();
            f.state
                .1
                .lock()
                .unwrap()
                .publish_rehydrated(generation, decoded)
                .unwrap();
        }
        let repo = CollaborationRepository::open(&f.root.join("shared")).unwrap();
        let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
        let pending = if mode == "import" {
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/audio/mono16.wav");
            let prepared = repo
                .prepare_media(&source, &f.root.join("new-pcm"), &AtomicBool::new(false))
                .unwrap();
            Some(
                super::super::collaboration::catalog::store_prepared(
                    &f.state.6,
                    &nonce,
                    "new-import",
                    prepared,
                )
                .unwrap(),
            )
        } else {
            None
        };
        repo.apply_recycle_controlled(
            &bob,
            0,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![f.ids[0].clone()],
                trash: true,
            },
            &AtomicBool::new(false),
            || Ok(()),
        )
        .unwrap();
        let p = repo
            .preview_purge(&bob, "other-runtime", &id(), PurgeSelection::All)
            .unwrap();
        repo.commit_purge(&bob, "other-runtime", &p, &AtomicBool::new(false))
            .unwrap();
        let expected = runtime::Expected {
            runtime_nonce: nonce.clone(),
            project_id: doc.project_id,
            expected_revision: doc.revision,
        };
        match mode {
            "refresh" => {
                let status = run(super::super::collaboration::refresh(&f.state, expected)).unwrap();
                assert!(status.error.is_none(), "{:?}", status.error);
            }
            "adopt" => {
                run(super::super::collaboration::catalog::adopt(
                    &f.state,
                    expected,
                    id(),
                ))
                .unwrap();
            }
            "import" => {
                run(super::super::collaboration::catalog::import(
                    &f.state,
                    expected,
                    pending.unwrap(),
                ))
                .unwrap();
            }
            _ => unreachable!(),
        }
        let tasks = f.state.1.lock().unwrap();
        let a = doc.media.iter().find(|m| m.id == f.ids[0]).unwrap();
        let b = doc.media.iter().find(|m| m.id == f.ids[1]).unwrap();
        assert!(tasks.registry.verified_stamp(a).is_none(), "{mode}");
        assert!(tasks.registry.verified_stamp(b).is_some(), "{mode}");
        assert_eq!(tasks.generation(), generation);
        assert_eq!(f.state.6.current.lock().unwrap().nonce, nonce);
    }
}

#[test]
fn late_commit_result_never_changes_replacement_project_or_its_epoch() {
    use annotator_core::project::LocalProject;
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
    let replacement_root = f.root.join("replacement");
    fs::create_dir(&replacement_root).unwrap();
    let replacement = LocalProject::create(&replacement_root, "Replacement".into()).unwrap();
    let snapshot = replacement.snapshot().unwrap();
    let replacement_generation = f.state.1.lock().unwrap().generation() + 1;
    let state = f.state.clone();
    *f.state.6.after_io.lock().unwrap() = Some(Box::new(move || {
        *state.0.lock().unwrap() = Some(replacement);
        state.6.retire();
        state.1.lock().unwrap().reset();
    }));
    let result = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(result.removed_ids, vec![f.ids[0].clone()]);
    assert_eq!(
        f.state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap(),
        snapshot
    );
    assert_eq!(
        f.state.1.lock().unwrap().generation(),
        replacement_generation
    );
    assert!(f
        .state
        .6
        .current
        .lock()
        .unwrap()
        .retired_media_ids
        .is_empty());
}

#[test]
fn rejected_retired_relink_releases_import_admission_for_survivors() {
    // A committed retirement fences workers even if private adoption has to be
    // retried. The personal view can still contain A during that failure window.
    let f = Fixture::new();
    f.state.1.lock().unwrap().retire_media(&[f.ids[0].clone()]);
    let nonce = f.state.6.current.lock().unwrap().nonce.clone();
    let project_id = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .document
        .project_id;
    let result = run(super::super::media::start(
        &f.state,
        Some(nonce),
        project_id,
        vec![f.audio[0].to_string_lossy().into()],
        Some(f.ids[0].clone()),
        tauri::ipc::Channel::new(|_| Ok(())),
    ));
    assert!(result.is_err());
    assert!(
        f.state
            .1
            .lock()
            .unwrap()
            .begin("survivor-import".into())
            .is_ok(),
        "rejected target cannot strand the global import slot"
    );
}

#[test]
fn cancelling_idle_preview_releases_bounded_native_capability_storage() {
    let f = Fixture::new();
    let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
    f.state.6.cancel(&p.operation_id).unwrap();
    assert!(
        f.state.6.purge.lock().unwrap().entries.is_empty(),
        "closed previews cannot exhaust service capacity"
    );
    assert!(
        run(commit(&f.state, f.confirm(&p))).is_err(),
        "cancelled capability cannot be reused"
    );
}

#[test]
fn seventeen_completed_and_closed_operations_release_capacity_but_keep_durable_receipts() {
    let f = Fixture::with_media_count(17);
    f.trash(f.ids.clone());
    let nonce = f.state.6.current.lock().unwrap().nonce.clone();
    for media_id in &f.ids {
        let p = run(preview(
            &f.state,
            f.args(PurgeSelection::Selected(vec![media_id.clone()])),
        ))
        .unwrap();
        assert_eq!(p.requested_count, 1);
        let result = run(commit(&f.state, f.confirm(&p))).unwrap();
        assert_eq!(result.status, "complete");
        assert_eq!(result.removed_ids, vec![media_id.clone()]);
        // A lost response may be confirmed again before the UI closes its capability.
        let repeated = run(commit(&f.state, f.confirm(&p))).unwrap();
        assert_eq!(repeated.removed_ids, result.removed_ids);
        assert_eq!(repeated.deleted_audio_bytes, result.deleted_audio_bytes);
        assert_eq!(f.state.6.purge.lock().unwrap().entries.len(), 1);
        // Same service method used by the collaboration_cancel IPC route.
        f.state.6.cancel(&p.operation_id).unwrap();
        assert!(f.state.6.purge.lock().unwrap().entries.is_empty());
        assert_eq!(run(page(&f.state, f.page_args(&p))).unwrap().total, 0);
        let durable = run(retry(&f.state, f.operation(&p))).unwrap();
        assert_eq!(durable.status, "complete");
        assert_eq!(durable.removed_ids, result.removed_ids);
        assert_eq!(durable.deleted_audio_bytes, result.deleted_audio_bytes);
        assert_eq!(f.state.6.current.lock().unwrap().nonce, nonce);
    }
    assert!(f.audio.iter().all(|p| !p.exists()));
}

#[test]
fn closed_pending_cleanup_remains_discoverable_and_retryable_without_preview_capability() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&f.audio[0])
        .unwrap();
    let p = run(preview(&f.state, f.args(PurgeSelection::All))).unwrap();
    let result = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(result.status, "committed-pending-cleanup");
    assert_eq!(result.deleted_audio_bytes, 0);
    let repeated = run(commit(&f.state, f.confirm(&p))).unwrap();
    assert_eq!(repeated.removed_ids, result.removed_ids);
    assert_eq!(repeated.status, result.status);
    f.state.6.cancel(&p.operation_id).unwrap();
    assert!(f.state.6.purge.lock().unwrap().entries.is_empty());
    assert!(run(page(&f.state, f.page_args(&p))).unwrap().total > 0);
    let status = run(super::super::collaboration::status(&f.state)).unwrap();
    let status = serde_json::to_value(status).unwrap();
    assert_eq!(
        status["purgeMaintenance"]["items"][0]["operationId"],
        p.operation_id
    );
    assert_eq!(status["purgeMaintenance"]["items"][0]["committed"], true);
    assert!(f.audio[0].exists());
    drop(held);
    let done = run(retry(&f.state, f.operation(&p))).unwrap();
    assert_eq!(done.operation_id, p.operation_id);
    assert_eq!(done.removed_ids, result.removed_ids);
    assert_eq!(done.status, "complete");
    assert!(done.deleted_audio_bytes > 0);
    assert_eq!(run(page(&f.state, f.page_args(&p))).unwrap().total, 0);
    assert!(!f.audio[0].exists());
    assert!(f.audio[1].exists());
    assert!(f.state.6.purge.lock().unwrap().entries.is_empty());
}

#[test]
fn retired_preview_cannot_install_old_capability_into_replacement_service() {
    let f = Fixture::new();
    let state = f.state.clone();
    *f.state.6.after_io.lock().unwrap() = Some(Box::new(move || {
        state.0.lock().unwrap().take();
        state.6.retire();
    }));
    assert!(run(preview(&f.state, f.args(PurgeSelection::All))).is_err());
    assert!(f.state.6.purge.lock().unwrap().entries.is_empty());
}

#[test]
fn cancel_between_final_check_and_store_cannot_retain_or_reuse_capability() {
    let f = Fixture::new();
    f.trash(vec![f.ids[0].clone()]);
    let args = f.args(PurgeSelection::All);
    let before = fs::read(f.root.join("shared/collaboration.json")).unwrap();
    let audio = fs::read(&f.audio[0]).unwrap();
    let state = f.state.clone();
    let operation = args.operation_id.clone();
    *f.state.6.hook.lock().unwrap() = Some(Box::new(move || {
        // This hook runs at the former check-to-store gap, outside the store
        // mutex. Cancellation must finish here without a synchronous deadlock.
        state.6.cancel(&operation).unwrap();
    }));
    let result = run(preview(&f.state, args.clone()));
    let reuse = CommitArgs {
        runtime_nonce: args.runtime_nonce,
        project_id: args.project_id,
        operation_id: args.operation_id.clone(),
        preview_id: result
            .as_ref()
            .map_or_else(|_| id(), |p| p.preview_id.clone()),
    };
    assert!(
        !f.state
            .6
            .purge
            .lock()
            .unwrap()
            .entries
            .contains_key(&args.operation_id),
        "completed cancellation cannot leave a subsequently inserted capability"
    );
    assert!(matches!(result, Err(error) if error.code == ErrorCode::Cancelled));
    assert!(
        run(commit(&f.state, reuse)).is_err(),
        "a new permit cannot reuse the cancelled capability"
    );
    assert_eq!(
        before,
        fs::read(f.root.join("shared/collaboration.json")).unwrap()
    );
    assert_eq!(audio, fs::read(&f.audio[0]).unwrap());
}
