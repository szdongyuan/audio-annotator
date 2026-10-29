use annotator_core::{
    collaboration::{
        profiles::Profile, purge::transaction::PurgeSelection, recycle::RecycleOperation, *,
    },
    model::{Annotation, Region},
};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, mpsc, Arc},
};

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
struct Fixture {
    root: PathBuf,
    repo: Arc<CollaborationRepository>,
    alice: Arc<AuthorSession>,
    bob: Arc<AuthorSession>,
    ids: Vec<String>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("purge-concurrency-{}", id()));
        fs::create_dir(&root).unwrap();
        let (repo, alice) = CollaborationRepository::create_default(
            &root,
            "Concurrency",
            &Profile::new("Alice").unwrap(),
        )
        .unwrap();
        let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let mut ids = vec![];
        for _ in 0..3 {
            let prepared = repo
                .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
                .unwrap();
            ids.push(prepared.media().id.clone());
            repo.append_media(&alice, &prepared, &AtomicBool::new(false))
                .unwrap();
        }
        Self {
            root,
            repo: Arc::new(repo.reload_catalog().unwrap()),
            alice: Arc::new(alice),
            bob: Arc::new(bob),
            ids,
        }
    }
    fn trash(&self, target: &str) {
        let repo = CollaborationRepository::open(&self.root).unwrap();
        repo.apply_recycle_controlled(
            &self.alice,
            repo.read_recycle().unwrap().revision,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![target.into()],
                trash: true,
            },
            &AtomicBool::new(false),
            || Ok(()),
        )
        .unwrap();
    }
    fn purge(&self, target: &str) -> Vec<String> {
        let repo = CollaborationRepository::open(&self.root).unwrap();
        let preview = repo
            .preview_purge(
                &self.alice,
                "test",
                &id(),
                PurgeSelection::Selected(vec![target.into()]),
            )
            .unwrap();
        repo.commit_purge(&self.alice, "test", &preview, &AtomicBool::new(false))
            .unwrap()
            .removed_ids
    }
    fn payload(&self, annotated: bool, note: &str) -> LayerPayload {
        let mut doc = self.repo.manifest().base_document().unwrap();
        doc.media
            .iter_mut()
            .find(|m| m.id == self.ids[1])
            .unwrap()
            .note = note.into();
        if annotated {
            doc.annotations.push(Annotation {
                id: id(),
                region: Region {
                    media_id: self.ids[0].clone(),
                    channel_index: 0,
                    start_seconds: 0.0,
                    end_seconds: 0.01,
                    low_hz: 0.0,
                    high_hz: 100.0,
                },
                category_ids: vec![],
                note: "A late annotation".into(),
                created_at: doc.created_at.clone(),
                updated_at: doc.updated_at.clone(),
            });
        }
        LayerPayload::from_document(&doc).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn purge_first_late_old_generation_publication_projects_a_and_keeps_b() {
    let f = Fixture::new();
    let base = f
        .repo
        .publish(&f.bob, None, &f.payload(false, "B initial"))
        .unwrap();
    let old = Arc::new(CollaborationRepository::open(&f.root).unwrap());
    let (release, wait) = mpsc::channel();
    let actor = f.bob.clone();
    let payload = f.payload(true, "B offline edit");
    let worker = std::thread::spawn(move || {
        wait.recv().unwrap();
        old.publish(&actor, Some(&base), &payload)
    });
    f.trash(&f.ids[0]);
    assert_eq!(f.purge(&f.ids[0]), vec![f.ids[0].clone()]);
    release.send(()).unwrap();
    let checkpoint = worker
        .join()
        .unwrap()
        .expect("late B publication must rebase through retirement authority");
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let head = repo
        .read_author(&f.bob.identity().author_id)
        .unwrap()
        .unwrap();
    assert_eq!(head.checkpoint(), checkpoint);
    assert!(head.payload.annotations.is_empty());
    assert!(head
        .payload
        .media_labels
        .iter()
        .all(|m| m.media_id != f.ids[0]));
    assert_eq!(
        head.payload
            .media_labels
            .iter()
            .find(|m| m.media_id == f.ids[1])
            .unwrap()
            .note,
        "B offline edit"
    );
}

#[test]
fn foreign_a_publication_first_blocks_purge() {
    let f = Fixture::new();
    f.trash(&f.ids[0]);
    let preview = f
        .repo
        .preview_purge(
            &f.alice,
            "test",
            &id(),
            PurgeSelection::Selected(vec![f.ids[0].clone()]),
        )
        .unwrap();
    let repo = Arc::new(CollaborationRepository::open(&f.root).unwrap());
    let actor = f.bob.clone();
    let payload = f.payload(true, "B committed first");
    let (done, wait) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        repo.publish(&actor, None, &payload).unwrap();
        done.send(()).unwrap();
    });
    wait.recv().unwrap();
    assert!(f
        .repo
        .commit_purge(&f.alice, "test", &preview, &AtomicBool::new(false))
        .unwrap()
        .removed_ids
        .is_empty());
    worker.join().unwrap();
    assert!(CollaborationRepository::open(&f.root)
        .unwrap()
        .manifest()
        .media
        .iter()
        .any(|m| m.id == f.ids[0]));
}

#[test]
fn retirement_only_adoption_keeps_new_unannotated_c_explicit() {
    use annotator_core::project::LocalProject;
    let f = Fixture::new();
    let local = std::env::temp_dir().join(format!("purge-concurrency-local-{}", id()));
    fs::create_dir(&local).unwrap();
    let mut project =
        LocalProject::open_shared(f.repo.clone(), Some(f.bob.clone()), &local).unwrap();
    f.trash(&f.ids[0]);
    f.purge(&f.ids[0]);
    let current = CollaborationRepository::open(&f.root).unwrap();
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let media = current
        .prepare_media(&source, &f.root.join("next-pcm"), &AtomicBool::new(false))
        .unwrap();
    current
        .append_media(&f.alice, &media, &AtomicBool::new(false))
        .unwrap();
    let prepared = project
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare_retirement(CollaborationRepository::open(&f.root).unwrap())
        .unwrap();
    let selected = prepared.repository();
    let before = project.snapshot().unwrap().document;
    project
        .adopt_prepared_catalog(&before.project_id, before.revision, prepared)
        .unwrap();
    assert!(!project
        .snapshot()
        .unwrap()
        .document
        .media
        .iter()
        .any(|m| m.id == media.media().id));
    assert!(
        selected
            .snapshot_with_catalog()
            .unwrap()
            .catalog_update_available,
        "unannotated new C still requires explicit catalog adoption"
    );
    drop(project);
    fs::remove_dir_all(local).unwrap();
}

#[test]
fn old_descriptor_import_cannot_reintroduce_retired_identity() {
    for batch in [false, true] {
        let f = Fixture::new();
        let old = f
            .repo
            .manifest()
            .media
            .iter()
            .find(|m| m.id == f.ids[0])
            .unwrap()
            .descriptor();
        f.trash(&f.ids[0]);
        f.purge(&f.ids[0]);
        let current = CollaborationRepository::open(&f.root).unwrap();
        for operation in current
            .purge_maintenance_operations()
            .unwrap()
            .into_iter()
            .filter(|o| o.committed)
        {
            current
                .acknowledge_purge_staging_drained(&f.bob, &operation.operation_id)
                .unwrap();
            current
                .retry_purge_cleanup(&f.alice, &operation.operation_id)
                .unwrap();
        }
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let prepared = current
            .prepare_media_copy(
                &source,
                &f.root.join("copy-pcm"),
                &AtomicBool::new(false),
                &old,
                |_, _| {},
            )
            .unwrap();
        let result = if batch {
            current
                .append_media_batch_interleaved(
                    &f.alice,
                    &[&prepared],
                    &AtomicBool::new(false),
                    None,
                    || Ok(()),
                )
                .map(|_| ())
        } else {
            current
                .append_media(&f.alice, &prepared, &AtomicBool::new(false))
                .map(|_| ())
        };
        assert!(
            result.is_err(),
            "retired UUID must never re-enter via verified copying (batch={batch})"
        );
        assert!(CollaborationRepository::open(&f.root)
            .unwrap()
            .manifest()
            .media
            .iter()
            .all(|m| m.id != f.ids[0]));
    }
}

#[test]
fn offline_publisher_rebases_across_two_cleaned_generations_with_stable_lease() {
    let f = Fixture::new();
    let payload = f.payload(false, "B initial");
    let base = f.repo.publish(&f.bob, None, &payload).unwrap();
    let late = f.payload(true, "B after two generations");
    for target in [&f.ids[0], &f.ids[2]] {
        f.trash(target);
        f.purge(target);
        let current = CollaborationRepository::open(&f.root).unwrap();
        for operation in current.purge_maintenance_operations().unwrap() {
            if operation.committed {
                current
                    .acknowledge_purge_staging_drained(&f.bob, &operation.operation_id)
                    .unwrap();
                current
                    .retry_purge_cleanup(&f.alice, &operation.operation_id)
                    .unwrap();
            }
        }
    }
    f.repo.publish(&f.bob, Some(&base), &late).unwrap();
    let current = CollaborationRepository::open(&f.root).unwrap();
    let head = current
        .read_author(&f.bob.identity().author_id)
        .unwrap()
        .unwrap();
    assert!(head.payload.annotations.is_empty());
    assert_eq!(head.payload.media_labels.len(), 1);
    assert_eq!(head.payload.media_labels[0].note, "B after two generations");
    let duplicate = Profile {
        author_id: f.bob.identity().author_id.clone(),
        display_name: f.bob.identity().display_name.clone(),
        created_at: f.bob.identity().created_at.clone(),
    };
    assert!(
        current.adopt(&duplicate).is_err(),
        "generation changes must retain the original author lease"
    );
}

#[test]
fn rebased_publication_ack_requires_workspace_retirement_first() {
    use annotator_core::{model::Change, project::LocalProject};
    let f = Fixture::new();
    let local = std::env::temp_dir().join(format!("purge-ack-local-{}", id()));
    fs::create_dir(&local).unwrap();
    let mut p = LocalProject::open_shared(f.repo.clone(), Some(f.bob.clone()), &local).unwrap();
    let d = p.snapshot().unwrap().document;
    p.apply_change(
        &d.project_id,
        d.revision,
        Change::UpdateMediaNote {
            media_id: f.ids[1].clone(),
            note: "B pending".into(),
            merge_key: None,
        },
    )
    .unwrap();
    let d = p.snapshot().unwrap().document;
    p.save(&d.project_id, d.revision).unwrap();
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    f.trash(&f.ids[0]);
    f.purge(&f.ids[0]);
    let ack = capture.publish().unwrap();
    assert!(
        p.workspace_mut().unwrap().acknowledge(ack).is_err(),
        "rebased receipt must not confirm an old A-containing private envelope"
    );
    assert!(p.workspace().unwrap().envelope().pending.is_some());
    drop(p);
    fs::remove_dir_all(local).unwrap();
}

#[test]
fn normal_b_publication_proceeds_between_physical_cleanup_items() {
    use annotator_core::collaboration::purge::cleanup::CleanupBoundary;
    let f = Fixture::new();
    f.trash(&f.ids[0]);
    f.purge(&f.ids[0]);
    let current = Arc::new(CollaborationRepository::open(&f.root).unwrap());
    let repo = current.clone();
    let actor = f.alice.clone();
    let operation = current
        .purge_maintenance_operations()
        .unwrap()
        .into_iter()
        .find(|o| o.committed)
        .unwrap()
        .operation_id;
    let (entered, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut first = true;
        repo.retry_purge_cleanup_controlled(
            &actor,
            &operation,
            usize::MAX,
            &AtomicBool::new(false),
            |point, _| {
                if first && point == CleanupBoundary::AfterProgress {
                    first = false;
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                }
                Ok(())
            },
        )
    });
    arrival
        .recv_timeout(std::time::Duration::from_secs(20))
        .unwrap();
    let mut doc = current.manifest().base_document().unwrap();
    doc.media
        .iter_mut()
        .find(|m| m.id == f.ids[1])
        .unwrap()
        .note = "B while cleanup paused".into();
    let result = current.publish(&f.bob, None, &LayerPayload::from_document(&doc).unwrap());
    release.send(()).unwrap();
    worker.join().unwrap().unwrap();
    result.expect("B commit cannot wait for the entire cleanup operation");
}

#[test]
fn purge_commit_serializes_restore_import_and_author_registration() {
    use annotator_core::collaboration::purge::transaction::PurgeBoundary;
    let f = Fixture::new();
    // Exercise the format-6 commit boundary independently of legacy fencing.
    f.trash(&f.ids[2]);
    f.purge(&f.ids[2]);
    f.trash(&f.ids[0]);
    let current = Arc::new(CollaborationRepository::open(&f.root).unwrap());
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let prepared = current
        .prepare_media(
            &source,
            &f.root.join("competing-pcm"),
            &AtomicBool::new(false),
        )
        .unwrap();
    let preview = current
        .preview_purge(
            &f.alice,
            "concurrent",
            &id(),
            PurgeSelection::Selected(vec![f.ids[0].clone()]),
        )
        .unwrap();
    let profile = Profile::new("Late registration").unwrap();
    let (entered, arrival) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    std::thread::scope(|scope| {
        let repo = &current;
        let actor = &f.alice;
        let preview = &preview;
        let purge = scope.spawn(move || {
            repo.commit_purge_guarded_controlled(
                actor,
                "concurrent",
                preview,
                &AtomicBool::new(false),
                |point| {
                    if point == PurgeBoundary::BeforeEntryReplace {
                        entered.send(()).unwrap();
                        wait.recv().unwrap();
                    }
                    Ok(())
                },
                |_| Ok(()),
                || Ok(()),
            )
        });
        arrival
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap();
        let (starting, started) = mpsc::channel();
        let current = &current;
        let profile = &profile;
        let f = &f;
        let prepared = &prepared;
        let restore_revision = current.read_recycle().unwrap().revision;
        let registration_start = starting.clone();
        let register = scope.spawn(move || {
            registration_start.send(()).unwrap();
            current.adopt(profile)
        });
        let import_start = starting.clone();
        let import = scope.spawn(move || {
            import_start.send(()).unwrap();
            current.append_media(&f.bob, prepared, &AtomicBool::new(false))
        });
        let restore = scope.spawn(move || {
            starting.send(()).unwrap();
            current.apply_recycle_controlled(
                &f.bob,
                restore_revision,
                RecycleOperation {
                    operation_id: id(),
                    media_ids: vec![f.ids[0].clone()],
                    trash: false,
                },
                &AtomicBool::new(false),
                || Ok(()),
            )
        });
        for _ in 0..3 {
            started.recv().unwrap();
        }
        release.send(()).unwrap();
        assert_eq!(
            purge.join().unwrap().unwrap().removed_ids,
            vec![f.ids[0].clone()]
        );
        let registration = register.join().unwrap();
        let imported = import.join().unwrap();
        assert!(restore.join().unwrap().is_err());
        let fresh = CollaborationRepository::open(&f.root).unwrap();
        if registration.is_err() {
            fresh.adopt(&profile).unwrap();
        }
        if imported.is_err() {
            fresh
                .append_media(&f.bob, &prepared, &AtomicBool::new(false))
                .unwrap();
        }
        let fresh = CollaborationRepository::open(&f.root).unwrap();
        assert!(fresh
            .manifest()
            .media
            .iter()
            .any(|m| m.id == prepared.media().id));
        assert!(fresh.manifest().media.iter().all(|m| m.id != f.ids[0]));
        assert!(fresh
            .snapshot()
            .unwrap()
            .authors
            .iter()
            .any(|a| a.identity.author_id == profile.author_id));
    });
}

#[test]
fn new_format_five_publisher_can_retry_busy_upgrade_without_closing_local_editor() {
    use annotator_core::{model::Change, project::LocalProject};
    let f = Fixture::new();
    let local = std::env::temp_dir().join(format!("purge-upgrade-editor-{}", id()));
    fs::create_dir(&local).unwrap();
    let mut p = LocalProject::open_shared(f.repo.clone(), Some(f.bob.clone()), &local).unwrap();
    let entry = fs::read(f.root.join("collaboration.json")).unwrap();
    let upgrade = f
        .repo
        .prepare_legacy_upgrade(&f.alice, &id(), &AtomicBool::new(false))
        .unwrap();
    let repo = f.repo.clone();
    let actor = f.bob.clone();
    let payload = f.payload(false, "B after busy");
    let worker = std::thread::spawn(move || repo.publish(&actor, None, &payload));
    let d = p.snapshot().unwrap().document;
    p.apply_change(
        &d.project_id,
        d.revision,
        Change::UpdateMediaNote {
            media_id: f.ids[1].clone(),
            note: "B local during upgrade".into(),
            merge_key: None,
        },
    )
    .unwrap();
    let d = p.snapshot().unwrap().document;
    p.save(&d.project_id, d.revision).unwrap();
    let busy = worker.join().unwrap().unwrap_err();
    assert!(
        busy.retryable,
        "upgrade contention must be explicitly retryable: {busy:?}"
    );
    upgrade.rollback().unwrap();
    assert!(p.workspace().unwrap().envelope().pending.is_some());
    assert_eq!(
        p.snapshot()
            .unwrap()
            .document
            .media
            .iter()
            .find(|m| m.id == f.ids[1])
            .unwrap()
            .note,
        "B local during upgrade"
    );
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    p.workspace_mut()
        .unwrap()
        .acknowledge(capture.publish().unwrap())
        .unwrap();
    assert_eq!(fs::read(f.root.join("collaboration.json")).unwrap(), entry);
    assert_eq!(
        CollaborationRepository::open(&f.root)
            .unwrap()
            .manifest()
            .format_version,
        CURRENT_COLLABORATION_FORMAT
    );
    drop(p);
    fs::remove_dir_all(local).unwrap();
}
