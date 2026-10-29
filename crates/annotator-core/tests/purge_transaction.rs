use annotator_core::{
    collaboration::{
        profiles::Profile,
        purge::transaction::{PurgeBoundary, PurgeSelection},
        recycle::RecycleOperation,
        AuthorSession, CollaborationRepository, LayerPayload,
    },
    error::{AppError, ErrorCode},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
struct Fixture {
    root: PathBuf,
    repo: CollaborationRepository,
    alice: AuthorSession,
    bob: AuthorSession,
    ids: Vec<String>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("purge-transaction-{}", id()));
        fs::create_dir(&root).unwrap();
        let (repo, alice) = CollaborationRepository::create_default(
            &root,
            "Transaction",
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
        let repo = repo.reload_catalog().unwrap();
        Self {
            root,
            repo,
            alice,
            bob,
            ids,
        }
    }
    fn recycle(&self, ids: Vec<String>, trash: bool) {
        let repo = CollaborationRepository::open(&self.root).unwrap();
        repo.apply_recycle_controlled(
            &self.alice,
            repo.read_recycle().unwrap().revision,
            RecycleOperation {
                operation_id: id(),
                media_ids: ids,
                trash,
            },
            &AtomicBool::new(false),
            || Ok(()),
        )
        .unwrap();
    }
    fn payload(&self, author: &AuthorSession, blocked: Option<&str>, note: &str) {
        let repo = CollaborationRepository::open(&self.root).unwrap();
        let mut doc = repo.manifest().base_document().unwrap();
        doc.media
            .iter_mut()
            .find(|m| m.id == self.ids[2])
            .unwrap()
            .note = note.into();
        doc.media
            .iter_mut()
            .find(|m| m.id == self.ids[0])
            .unwrap()
            .note = "foreign notes do not block purge".into();
        doc.categories.push(annotator_core::model::Category {
            id: "00000000-0000-4000-8000-000000000001".into(),
            name: "Preserved category".into(),
            color: "#112233".into(),
        });
        if let Some(media) = blocked {
            doc.annotations.push(annotator_core::model::Annotation {
                id: id(),
                region: annotator_core::model::Region {
                    media_id: media.into(),
                    channel_index: 0,
                    start_seconds: 0.0,
                    end_seconds: 0.01,
                    low_hz: 0.0,
                    high_hz: 100.0,
                },
                category_ids: vec![],
                note: String::new(),
                created_at: doc.created_at.clone(),
                updated_at: doc.updated_at.clone(),
            });
        }
        let prior = repo
            .read_author(&author.identity().author_id)
            .unwrap()
            .map(|l| l.checkpoint());
        repo.publish(
            author,
            prior.as_ref(),
            &LayerPayload::from_document(&doc).unwrap(),
        )
        .unwrap();
    }
    fn entry(&self) -> Vec<u8> {
        fs::read(self.root.join("collaboration.json")).unwrap()
    }
    fn audio_unchanged(&self) {
        for m in &self.repo.manifest().media {
            assert_eq!(
                fs::read(self.root.join(&m.source_ref)).unwrap(),
                fs::read(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../tests/fixtures/audio/mono16.wav")
                )
                .unwrap()
            );
        }
    }
}
#[test]
fn mixed_permissions_project_all_shared_history_and_preserve_duplicate_audio() {
    let f = Fixture::new();
    f.recycle(f.ids[..2].to_vec(), true);
    f.payload(&f.alice, None, "historical unrelated note");
    f.payload(&f.alice, None, "latest unrelated note");
    f.payload(&f.bob, Some(&f.ids[1]), "foreign note only");
    let old_head = f
        .repo
        .read_author(&f.alice.identity().author_id)
        .unwrap()
        .unwrap();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let result = f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(result.removed_ids, vec![f.ids[0].clone()]);
    assert_eq!(result.retained_ids, vec![f.ids[1].clone()]);
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(current.manifest().format_version, 6);
    assert_eq!(current.manifest().media.len(), 2);
    assert_eq!(current.read_recycle().unwrap().trashed.len(), 1);
    assert!(current.purge_authority(&f.alice).is_ok());
    let entry: serde_json::Value = serde_json::from_slice(&f.entry()).unwrap();
    let generation = f
        .root
        .join("state")
        .join(entry["metadataGeneration"].as_str().unwrap());
    let descriptor: serde_json::Value =
        serde_json::from_slice(&fs::read(generation.join("generation.json")).unwrap()).unwrap();
    assert_eq!(descriptor["checkpointMap"].as_array().unwrap().len(), 3);
    assert_eq!(
        descriptor["receipts"][0]["retained"],
        serde_json::json!([{"mediaId":f.ids[1],"reason":"other-author-annotation"}]),
        "retry must preserve the original per-item result reason"
    );
    for (revision, note) in [
        (1, "historical unrelated note"),
        (2, "latest unrelated note"),
    ] {
        let layer = annotator_core::collaboration::AuthorLayer::parse(
            &fs::read(
                generation
                    .join("annotations")
                    .join(&f.alice.identity().author_id)
                    .join(format!("{revision:020}.json")),
            )
            .unwrap(),
            current.manifest(),
            &f.alice.identity().author_id,
        )
        .unwrap();
        assert!(layer
            .payload
            .media_labels
            .iter()
            .all(|m| m.media_id != f.ids[0]));
        assert_eq!(
            layer
                .payload
                .media_labels
                .iter()
                .find(|m| m.media_id == f.ids[2])
                .unwrap()
                .note,
            note
        );
        assert_eq!(
            descriptor["checkpointMap"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["authorId"] == f.alice.identity().author_id
                    && m["target"]["revision"] == revision)
                .unwrap()["target"]["hash"],
            layer.hash
        );
        assert_eq!(layer.payload.categories[0].name, "Preserved category");
        if revision == 2 {
            assert_eq!(
                descriptor["checkpointMap"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| m["authorId"] == f.alice.identity().author_id
                        && m["source"]["revision"] == 2)
                    .unwrap()["source"]["hash"],
                old_head.hash
            );
        }
    }
    f.audio_unchanged();
}
#[test]
fn revalidation_shrinks_for_restoration_and_new_foreign_regions_and_never_adds_new_trash() {
    let f = Fixture::new();
    f.recycle(f.ids[..2].to_vec(), true);
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    f.recycle(vec![f.ids[0].clone()], false);
    f.payload(&f.bob, Some(&f.ids[1]), "new");
    f.recycle(vec![f.ids[2].clone()], true);
    let before = f.entry();
    let result = f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .unwrap();
    assert!(result.removed_ids.is_empty());
    assert_eq!(result.retained_ids.len(), 2);
    assert_eq!(f.entry(), before);
    f.audio_unchanged();
}
#[test]
fn new_trash_is_excluded_and_repeat_v6_purge_keeps_permanent_receipts() {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    f.recycle(vec![f.ids[1].clone()], true);
    let first = f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(first.removed_ids, vec![f.ids[0].clone()]);
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let next = repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let second = repo
        .commit_purge(&f.alice, "runtime", &next, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(second.removed_ids, vec![f.ids[1].clone()]);
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let retry = repo
        .preview_purge(&f.alice, "new-runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(
        repo.commit_purge(&f.alice, "new-runtime", &retry, &AtomicBool::new(true))
            .unwrap()
            .removed_ids,
        first.removed_ids
    );
    assert!(repo
        .preview_purge(
            &f.alice,
            "runtime",
            &operation,
            PurgeSelection::Selected(vec![f.ids[2].clone()])
        )
        .is_err());
    f.audio_unchanged();
}
#[test]
fn precommit_faults_preserve_entry_history_and_audio_and_postcommit_fault_is_authoritative() {
    for point in [
        PurgeBoundary::BeforePrepare,
        PurgeBoundary::BeforeSync,
        PurgeBoundary::BeforeEntryReplace,
        PurgeBoundary::AfterEntryReplace,
    ] {
        let f = Fixture::new();
        f.recycle(vec![f.ids[0].clone()], true);
        f.payload(&f.alice, None, "history");
        let operation = id();
        let preview = f
            .repo
            .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
            .unwrap();
        let before = f.entry();
        let result = f.repo.commit_purge_controlled(
            &f.alice,
            "runtime",
            &preview,
            &AtomicBool::new(false),
            |boundary| {
                if point == boundary {
                    Err(AppError::new(
                        ErrorCode::SaveFailed,
                        "Injected transaction I/O",
                    ))
                } else {
                    Ok(())
                }
            },
        );
        if point == PurgeBoundary::AfterEntryReplace {
            let outcome = result.unwrap();
            assert!(outcome.committed);
            assert!(outcome.maintenance_error.is_some());
            assert_eq!(outcome.removed_ids, vec![f.ids[0].clone()]);
            assert_ne!(f.entry(), before);
            let committed_entry = f.entry();
            assert_eq!(
                f.repo
                    .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(true))
                    .unwrap()
                    .removed_ids,
                outcome.removed_ids
            );
            assert_eq!(
                f.entry(),
                committed_entry,
                "lost-response retry must not replace the entry again"
            );
        } else {
            assert!(result.is_err());
            assert_eq!(f.entry(), before);
            assert!(f
                .repo
                .read_author(&f.alice.identity().author_id)
                .unwrap()
                .is_some());
        }
        f.audio_unchanged();
    }
}
#[test]
fn cancellation_before_and_after_commit_and_runtime_binding() {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let before = f.entry();
    assert!(f
        .repo
        .commit_purge(&f.alice, "wrong-runtime", &preview, &AtomicBool::new(false))
        .is_err());
    assert!(f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(true))
        .is_err());
    assert_eq!(f.entry(), before);
    let cancel = AtomicBool::new(false);
    let result = f
        .repo
        .commit_purge_controlled(&f.alice, "runtime", &preview, &cancel, |b| {
            if b == PurgeBoundary::AfterEntryReplace {
                cancel.store(true, Ordering::Release);
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(result.removed_ids, vec![f.ids[0].clone()]);
}
#[test]
fn incomplete_author_authority_stops_whole_commit() {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    f.payload(&f.bob, None, "note");
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let before = f.entry();
    fs::write(
        f.root
            .join("annotations")
            .join(&f.bob.identity().author_id)
            .join("00000000000000000001.json"),
        b"corrupt",
    )
    .unwrap();
    assert!(f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .is_err());
    assert_eq!(f.entry(), before);
    f.audio_unchanged();
}

#[test]
fn all_enumerates_unadopted_media_and_selected_scope_is_normalized() {
    let f = Fixture::new();
    let stale = CollaborationRepository::open(&f.root).unwrap();
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let prepared = stale
        .prepare_media(
            &source,
            &f.root.join("unadopted-pcm"),
            &AtomicBool::new(false),
        )
        .unwrap();
    let added = prepared.media().id.clone();
    stale
        .append_media(&f.alice, &prepared, &AtomicBool::new(false))
        .unwrap();
    f.recycle(vec![added.clone(), f.ids[0].clone()], true);
    let operation = id();
    let preview = stale
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(preview.requested_ids().len(), 2);
    assert_eq!(preview.eligible_count(), 2);
    assert_eq!(preview.state_digest().len(), 64);
    let result = stale
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .unwrap();
    assert!(result.removed_ids.contains(&added));
    let current = CollaborationRepository::open(&f.root).unwrap();
    let operation = id();
    f.recycle(vec![f.ids[1].clone(), f.ids[2].clone()], true);
    let selected = current
        .preview_purge(
            &f.alice,
            "runtime",
            &operation,
            PurgeSelection::Selected(vec![f.ids[2].clone(), f.ids[1].clone()]),
        )
        .unwrap();
    current
        .commit_purge(&f.alice, "runtime", &selected, &AtomicBool::new(false))
        .unwrap();
    let current = CollaborationRepository::open(&f.root).unwrap();
    let retry = current
        .preview_purge(
            &f.alice,
            "runtime",
            &operation,
            PurgeSelection::Selected(vec![f.ids[1].clone(), f.ids[2].clone()]),
        )
        .unwrap();
    assert_eq!(
        current
            .commit_purge(&f.alice, "runtime", &retry, &AtomicBool::new(false))
            .unwrap()
            .removed_ids
            .len(),
        2
    );
    f.audio_unchanged();
    assert_eq!(
        fs::read(f.root.join(&prepared.media().source_ref)).unwrap(),
        fs::read(source).unwrap()
    );
}

#[test]
fn legacy_foreign_publication_winning_the_numeric_path_retains_target_without_upgrade() {
    use annotator_core::collaboration::{purge::legacy::LegacyBoundary, LayerPayload};
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let mut doc = f.repo.manifest().base_document().unwrap();
    doc.annotations.push(annotator_core::model::Annotation {
        id: id(),
        region: annotator_core::model::Region {
            media_id: f.ids[0].clone(),
            channel_index: 0,
            start_seconds: 0.0,
            end_seconds: 0.01,
            low_hz: 0.0,
            high_hz: 100.0,
        },
        category_ids: vec![],
        note: "late foreign region".into(),
        created_at: doc.created_at.clone(),
        updated_at: doc.updated_at.clone(),
    });
    let payload = LayerPayload::from_document(&doc).unwrap();
    let before = f.entry();
    let mut published = false;
    let outcome=f.repo.commit_purge_guarded_controlled(&f.alice,"runtime",&preview,&AtomicBool::new(false), |_|Ok(()), |event| {
        if matches!(event,LegacyBoundary::BeforeFence {ref author_id,..} if author_id==&f.bob.identity().author_id) && !published {
            f.repo.publish_legacy_interleaved(&f.bob,None,&payload, |_|Ok(())).unwrap(); published=true;
        } Ok(())
    },||Ok(())).unwrap();
    assert!(published);
    assert!(!outcome.committed);
    assert!(outcome.removed_ids.is_empty());
    assert_eq!(f.entry(), before);
    assert_eq!(
        f.repo
            .read_author(&f.bob.identity().author_id)
            .unwrap()
            .unwrap()
            .payload
            .annotations[0]
            .note,
        "late foreign region"
    );
    f.audio_unchanged();
}

#[test]
fn lifecycle_guard_is_held_only_during_the_entry_switch_and_can_veto_it() {
    use std::cell::Cell;
    struct Guard<'a>(&'a Cell<bool>);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.set(false)
        }
    }
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let held = Cell::new(false);
    let before = f.entry();
    let result = f.repo.commit_purge_guarded_controlled(
        &f.alice,
        "runtime",
        &preview,
        &AtomicBool::new(false),
        |_| Ok(()),
        |_| Ok(()),
        || {
            Err::<(), _>(AppError::new(
                ErrorCode::IdentityMismatch,
                "project switched",
            ))
        },
    );
    assert!(result.is_err());
    assert_eq!(f.entry(), before);
    // A new operation is used here because the first upgrade has durable rollback
    // backup ownership; committed same-operation retries are separately covered.
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    f.repo
        .commit_purge_guarded_controlled(
            &f.alice,
            "runtime",
            &preview,
            &AtomicBool::new(false),
            |event| {
                assert!(!held.get());
                if event == PurgeBoundary::AfterEntryReplace {
                    assert_ne!(f.entry(), before);
                }
                Ok(())
            },
            |_| Ok(()),
            || {
                assert_eq!(f.entry(), before);
                held.set(true);
                Ok(Guard(&held))
            },
        )
        .unwrap();
    assert!(!held.get());
}

#[test]
fn same_preview_and_operation_retry_keeps_old_pending_legacy_backups_and_supersedes_them() {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    f.payload(&f.bob, None, "retained note");
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let first = f.repo.commit_purge_controlled(
        &f.alice,
        "runtime",
        &preview,
        &AtomicBool::new(false),
        |event| {
            if event == PurgeBoundary::BeforeEntryReplace {
                Err(AppError::new(
                    ErrorCode::SaveFailed,
                    "first attempt interrupted",
                ))
            } else {
                Ok(())
            }
        },
    );
    assert!(first.is_err());
    let pending: Vec<_> = fs::read_dir(f.root.join("maintenance"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("legacy.json").exists())
        .collect();
    assert_eq!(pending.len(), 1);
    let old = fs::read(pending[0].join("legacy.json")).unwrap();
    let old_log: serde_json::Value = serde_json::from_slice(&old).unwrap();
    assert_eq!(old_log["status"], "rollback-pending");
    let outcome = f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .expect("same operation must retry while foreign writer leases remain held");
    assert_eq!(outcome.removed_ids, vec![f.ids[0].clone()]);
    assert_eq!(
        fs::read(pending[0].join("legacy.json")).unwrap(),
        old,
        "old attempt ownership and backups must remain intact"
    );
    let current = CollaborationRepository::open(&f.root).unwrap();
    let old_operation = old_log["operationId"].as_str().unwrap();
    assert!(
        current.recover_legacy_upgrade(old_operation).is_ok(),
        "superseded attempt recovery cannot restore retired content"
    );
    assert_eq!(
        CollaborationRepository::open(&f.root)
            .unwrap()
            .manifest()
            .media
            .len(),
        2
    );
    f.audio_unchanged();
}

#[test]
fn retry_preview_uses_durable_fixed_targets_after_precommit_failure() {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let failed = f.repo.commit_purge_controlled(
        &f.alice,
        "runtime",
        &preview,
        &AtomicBool::new(false),
        |event| {
            if event == PurgeBoundary::BeforeEntryReplace {
                Err(AppError::new(ErrorCode::SaveFailed, "interrupted"))
            } else {
                Ok(())
            }
        },
    );
    assert!(failed.is_err());
    f.recycle(vec![f.ids[1].clone()], true);
    let retry = f
        .repo
        .preview_purge(&f.alice, "new-runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(
        retry.requested_ids(),
        &[f.ids[0].clone()],
        "restart retry must not enumerate newly trashed media"
    );
    assert!(
        f.repo
            .preview_purge(
                &f.alice,
                "runtime",
                &operation,
                PurgeSelection::Selected(vec![f.ids[0].clone()])
            )
            .is_err(),
        "pending operation request is already bound"
    );
    assert_eq!(
        f.repo
            .commit_purge(&f.alice, "new-runtime", &retry, &AtomicBool::new(false))
            .unwrap()
            .removed_ids,
        vec![f.ids[0].clone()]
    );
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert!(current.manifest().media.iter().any(|m| m.id == f.ids[1]));
}

#[test]
fn three_generations_preserve_exact_provenance_without_old_generation_files() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new();
    f.payload(&f.alice, None, "historical payload");
    f.payload(&f.alice, None, "latest payload");
    let mut prior_entries: Vec<Vec<u8>> = vec![];
    let mut prior_descriptors: Vec<Vec<u8>> = vec![];
    let mut old_dirs = vec![];
    for media in &f.ids {
        let repo = CollaborationRepository::open(&f.root).unwrap();
        f.recycle(vec![media.clone()], true);
        let preview = repo
            .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
            .unwrap();
        repo.commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
            .unwrap();
        let entry = f.entry();
        let entry_value: serde_json::Value = serde_json::from_slice(&entry).unwrap();
        let dir = f
            .root
            .join("state")
            .join(entry_value["metadataGeneration"].as_str().unwrap());
        let descriptor = fs::read(dir.join("generation.json")).unwrap();
        for (old, old_descriptor) in prior_entries.iter().zip(&prior_descriptors) {
            let key = format!("{:x}", Sha256::digest(old));
            assert_eq!(
                fs::read(dir.join("provenance").join(key).join("generation.json")).unwrap(),
                *old_descriptor
            );
        }
        prior_entries.push(entry);
        prior_descriptors.push(descriptor);
        old_dirs.push(dir);
    }
    // Test cleanup's permitted removal of superseded generation directories.
    // Resolver and provenance must use current generation's exact proof copies.
    for dir in &old_dirs[..2] {
        fs::remove_dir_all(dir).unwrap();
    }
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert!(current.manifest().media.is_empty());
    assert_eq!(
        current
            .read_author(&f.alice.identity().author_id)
            .unwrap()
            .unwrap()
            .payload
            .categories[0]
            .name,
        "Preserved category"
    );
    f.audio_unchanged();
}

#[test]
fn purge_receipts_survive_more_than_sixty_four_recycle_operations_and_retired_membership_is_rejected(
) {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    f.repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .unwrap();
    for i in 0..66 {
        f.recycle(vec![f.ids[1].clone()], i % 2 == 0);
    }
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let retry = repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(
        repo.commit_purge(&f.alice, "runtime", &retry, &AtomicBool::new(false))
            .unwrap()
            .removed_ids,
        vec![f.ids[0].clone()]
    );
    let entry: serde_json::Value = serde_json::from_slice(&f.entry()).unwrap();
    let dir = f
        .root
        .join("state")
        .join(entry["metadataGeneration"].as_str().unwrap());
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("organization.json")).unwrap()).unwrap();
    let membership = original["media"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["mediaId"] == f.ids[0])
        .unwrap()
        .clone();
    let mut organization: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("organization.json")).unwrap()).unwrap();
    organization["media"]
        .as_array_mut()
        .unwrap()
        .push(membership);
    fs::copy(
        f.root.join("catalog").join(format!("{}.json", f.ids[0])),
        dir.join("catalog").join(format!("{}.json", f.ids[0])),
    )
    .unwrap();
    fs::write(
        dir.join("organization.json"),
        serde_json::to_vec(&organization).unwrap(),
    )
    .unwrap();
    assert!(
        CollaborationRepository::open(&f.root).is_err(),
        "retired ID cannot be reaccepted through old membership/catalog bytes"
    );
    f.audio_unchanged();
}

#[cfg(windows)]
#[test]
fn real_windows_entry_replacement_denial_preserves_source_and_same_operation_retries() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    f.payload(&f.alice, None, "source history");
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let before = f.entry();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(f.root.join("collaboration.json"))
        .unwrap();
    let failed = f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false));
    assert!(matches!(failed,Err(ref e) if e.code==ErrorCode::SaveFailed));
    assert_eq!(f.entry(), before);
    assert!(f
        .repo
        .read_author(&f.alice.identity().author_id)
        .unwrap()
        .is_some());
    f.audio_unchanged();
    drop(held);
    let outcome = f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false))
        .unwrap();
    assert!(outcome.committed);
    assert_eq!(outcome.removed_ids, vec![f.ids[0].clone()]);
    f.audio_unchanged();
}

#[test]
fn recycle_revision_exhaustion_fails_before_entry_replacement() {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let path = f.root.join("recycle.json");
    let mut recycle: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    recycle["revision"] = serde_json::json!(9_007_199_254_740_990u64);
    fs::write(path, serde_json::to_vec(&recycle).unwrap()).unwrap();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    let before = f.entry();
    let result = f
        .repo
        .commit_purge(&f.alice, "runtime", &preview, &AtomicBool::new(false));
    assert!(
        result.is_err(),
        "bounded recycle codec must be validated before committing the new generation"
    );
    assert_eq!(f.entry(), before);
    f.audio_unchanged();
}

#[test]
fn early_prepare_failure_binds_all_scope_and_rejects_changed_request_or_actor() {
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let conflicting = f
        .repo
        .preview_purge(
            &f.alice,
            "runtime",
            &operation,
            PurgeSelection::Selected(vec![f.ids[1].clone()]),
        )
        .unwrap();
    assert!(
        !f.root.join("maintenance").exists(),
        "preview must remain read-only"
    );
    let before = f.entry();
    let failed = f.repo.commit_purge_controlled(
        &f.alice,
        "runtime",
        &preview,
        &AtomicBool::new(false),
        |event| {
            if event == PurgeBoundary::BeforePrepare {
                Err(AppError::new(
                    ErrorCode::SaveFailed,
                    "early preparation failure",
                ))
            } else {
                Ok(())
            }
        },
    );
    assert!(failed.is_err());
    assert_eq!(f.entry(), before);
    f.audio_unchanged();
    f.recycle(vec![f.ids[1].clone()], true);
    let retry = f
        .repo
        .preview_purge(&f.alice, "new-runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(
        retry.requested_ids(),
        &[f.ids[0].clone()],
        "early failure must not let a retry enumerate new trash"
    );
    assert!(f
        .repo
        .preview_purge(
            &f.alice,
            "runtime",
            &operation,
            PurgeSelection::Selected(vec![f.ids[0].clone()])
        )
        .is_err());
    assert!(f
        .repo
        .preview_purge(&f.bob, "runtime", &operation, PurgeSelection::All)
        .is_err());
    assert!(
        f.repo
            .commit_purge(&f.alice, "runtime", &conflicting, &AtomicBool::new(false))
            .is_err(),
        "a conflicting preview created before acceptance must also be rejected"
    );
    let result = f
        .repo
        .commit_purge(&f.alice, "new-runtime", &retry, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(result.removed_ids, vec![f.ids[0].clone()]);
    assert!(CollaborationRepository::open(&f.root)
        .unwrap()
        .manifest()
        .media
        .iter()
        .any(|m| m.id == f.ids[1]));
    f.audio_unchanged();
}

#[test]
fn early_legacy_failure_cannot_unbind_the_accepted_operation() {
    use annotator_core::collaboration::purge::legacy::LegacyBoundary;
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let before = f.entry();
    let failed = f.repo.commit_purge_guarded_controlled(
        &f.alice,
        "runtime",
        &preview,
        &AtomicBool::new(false),
        |_| Ok(()),
        |event| {
            if event == LegacyBoundary::BeforeJournal {
                Err(AppError::new(
                    ErrorCode::SaveFailed,
                    "early legacy preparation failure",
                ))
            } else {
                Ok(())
            }
        },
        || Ok(()),
    );
    assert!(failed.is_err());
    assert_eq!(f.entry(), before);
    f.recycle(vec![f.ids[1].clone()], true);
    let retry = f
        .repo
        .preview_purge(&f.alice, "new-runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(
        retry.requested_ids(),
        &[f.ids[0].clone()],
        "request binding must precede even the first legacy journal write"
    );
    assert!(f
        .repo
        .preview_purge(
            &f.alice,
            "runtime",
            &operation,
            PurgeSelection::Selected(vec![f.ids[0].clone()])
        )
        .is_err());
    assert_eq!(
        f.repo
            .commit_purge(&f.alice, "new-runtime", &retry, &AtomicBool::new(false))
            .unwrap()
            .removed_ids,
        vec![f.ids[0].clone()]
    );
    f.audio_unchanged();
}

#[test]
fn accepted_request_retains_initial_permission_ceiling_after_early_failure() {
    let f = Fixture::new();
    f.recycle(f.ids[..2].to_vec(), true);
    f.payload(&f.bob, Some(&f.ids[1]), "foreign region at confirmation");
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(preview.eligible_count(), 1);
    let failed = f.repo.commit_purge_controlled(
        &f.alice,
        "runtime",
        &preview,
        &AtomicBool::new(false),
        |event| {
            if event == PurgeBoundary::BeforePrepare {
                Err(AppError::new(ErrorCode::SaveFailed, "early failure"))
            } else {
                Ok(())
            }
        },
    );
    assert!(failed.is_err());
    f.payload(&f.bob, None, "region withdrawn");
    f.recycle(vec![f.ids[2].clone()], true);
    let retry = f
        .repo
        .preview_purge(&f.alice, "new-runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert_eq!(
        retry.eligible_count(),
        1,
        "initially blocked media cannot enter the accepted eligibility ceiling"
    );
    let result = f
        .repo
        .commit_purge(&f.alice, "new-runtime", &retry, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(result.removed_ids, vec![f.ids[0].clone()]);
    assert_eq!(result.retained_ids, vec![f.ids[1].clone()]);
    assert_eq!(
        result.retained[0].reason,
        annotator_core::collaboration::purge::journal::PurgeBlockReason::OtherAuthorAnnotation
    );
    f.audio_unchanged();
}

#[test]
fn accepted_request_codec_is_strict_bounded_and_grants_no_retirement_authority() {
    use annotator_core::collaboration::purge::journal::{PurgeJournal, PurgeRequestBinding};
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let failed = f.repo.commit_purge_controlled(
        &f.alice,
        "runtime",
        &preview,
        &AtomicBool::new(false),
        |event| {
            if event == PurgeBoundary::BeforePrepare {
                Err(AppError::new(
                    ErrorCode::SaveFailed,
                    "accepted without candidate",
                ))
            } else {
                Ok(())
            }
        },
    );
    assert!(failed.is_err());
    let dir = f.root.join("maintenance").join(&operation);
    let bytes = fs::read(dir.join("request.json")).unwrap();
    let binding = PurgeRequestBinding::parse(&bytes).unwrap();
    assert_eq!(binding.requested_ids, vec![f.ids[0].clone()]);
    assert_eq!(binding.eligible_ids, binding.requested_ids);
    assert_eq!(binding.state_digest, preview.state_digest());
    assert!(!dir.join("purge.json").exists());
    assert!(
        PurgeJournal::parse(&bytes).is_err(),
        "accepted request cannot be mistaken for a committed-result journal"
    );
    assert_eq!(
        CollaborationRepository::open(&f.root)
            .unwrap()
            .manifest()
            .format_version,
        5
    );
    assert_eq!(f.repo.read_recycle().unwrap().trashed.len(), 1);
    let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    for key in [
        "kind",
        "formatVersion",
        "projectId",
        "operationId",
        "actorId",
        "selection",
        "requestHash",
        "sourceEntryHash",
        "stateDigest",
        "requestedIds",
        "eligibleIds",
        "retained",
    ] {
        let mut bad = record.clone();
        bad.as_object_mut().unwrap().remove(key);
        assert!(
            PurgeRequestBinding::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "missing {key}"
        );
    }
    for (key, value) in [
        ("formatVersion", serde_json::json!(2)),
        ("extra", serde_json::json!(true)),
        ("actorId", serde_json::json!("../actor")),
        ("stateDigest", serde_json::json!("bad")),
        ("eligibleIds", serde_json::json!([f.ids[1]])),
        ("eligibleIds", serde_json::json!([])),
        ("requestedIds", serde_json::json!([f.ids[0], f.ids[0]])),
        (
            "selection",
            serde_json::json!({"kind":"selected","mediaIds":[f.ids[0]]}),
        ),
        ("selection", serde_json::json!({"kind":"all","extra":true})),
        (
            "retained",
            serde_json::json!([{"mediaId":f.ids[0],"reason":"other-author-annotation"}]),
        ),
    ] {
        let mut bad = record.clone();
        bad[key] = value;
        assert!(
            PurgeRequestBinding::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "invalid {key}"
        );
    }
    let duplicate = String::from_utf8(bytes)
        .unwrap()
        .replace("\"actorId\":", "\"actorId\":\"duplicate\",\"actorId\":");
    assert!(PurgeRequestBinding::parse(duplicate.as_bytes()).is_err());
    let mut excessive = record;
    excessive["requestedIds"] = serde_json::json!((0..10_001).map(|_| id()).collect::<Vec<_>>());
    assert_eq!(
        PurgeRequestBinding::parse(&serde_json::to_vec(&excessive).unwrap())
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    f.audio_unchanged();
}

#[test]
fn accepting_empty_or_blocked_scope_never_upgrades_or_prepares_generation() {
    let f = Fixture::new();
    let before = f.entry();
    let empty = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    assert!(!f.root.join("maintenance").exists());
    assert!(
        !f.repo
            .commit_purge(&f.alice, "runtime", &empty, &AtomicBool::new(false))
            .unwrap()
            .committed
    );
    f.recycle(vec![f.ids[0].clone()], true);
    f.payload(&f.bob, Some(&f.ids[0]), "blocks deletion");
    let blocked = f
        .repo
        .preview_purge(&f.alice, "runtime", &id(), PurgeSelection::All)
        .unwrap();
    assert_eq!(blocked.eligible_count(), 0);
    let result = f
        .repo
        .commit_purge(&f.alice, "runtime", &blocked, &AtomicBool::new(false))
        .unwrap();
    assert!(!result.committed);
    assert!(result.removed_ids.is_empty());
    assert_eq!(f.entry(), before);
    assert!(!f.root.join("state").exists());
    for operation in [empty.operation_id(), blocked.operation_id()] {
        let dir = f.root.join("maintenance").join(operation);
        assert!(dir.join("request.json").exists());
        assert!(!dir.join("purge.json").exists());
    }
    f.audio_unchanged();
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingPruneTiming {
    BeforeRetry,
    DuringRetryBackup,
    NewerPublication,
}

fn exercise_pending_history_retry(timing: PendingPruneTiming) {
    use annotator_core::collaboration::{
        purge::{
            generation::{GenerationDescriptor, GenerationEntry},
            journal::LegacyJournal,
            legacy::LegacyBoundary,
        },
        AuthorLayer, LegacyPublishBoundary,
    };
    use std::sync::mpsc::channel;
    let f = Fixture::new();
    f.recycle(vec![f.ids[0].clone()], true);
    let historical = |revision| {
        let mut doc = f.repo.manifest().base_document().unwrap();
        doc.media
            .iter_mut()
            .find(|m| m.id == f.ids[2])
            .unwrap()
            .note = format!("retained unrelated note {revision}");
        doc.categories.push(annotator_core::model::Category {
            id: id(),
            name: format!("retained category {revision}"),
            color: "#112233".into(),
        });
        LayerPayload::from_document(&doc).unwrap()
    };
    let mut base = None;
    for revision in 1..=16 {
        base = Some(
            f.repo
                .publish(&f.bob, base.as_ref(), &historical(revision))
                .unwrap(),
        );
    }
    let bob_id = &f.bob.identity().author_id;
    let source_bytes = |revision| {
        fs::read(
            f.root
                .join("annotations")
                .join(bob_id)
                .join(format!("{revision:020}.json")),
        )
        .unwrap()
    };
    let protected_bytes = source_bytes(2);
    let next_bytes = source_bytes(3);
    let protected = AuthorLayer::parse(&protected_bytes, f.repo.manifest(), bob_id).unwrap();
    let next = AuthorLayer::parse(&next_bytes, f.repo.manifest(), bob_id).unwrap();
    let operation = id();
    let preview = f
        .repo
        .preview_purge(&f.alice, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let payload17 = historical(17);
    let payload18 = historical(18);
    std::thread::scope(|scope| {
        let (checked_tx, checked_rx) = channel();
        let (enumerate_tx, enumerate_rx) = channel();
        let (enumerated_tx, enumerated_rx) = channel();
        let (prune_tx, prune_rx) = channel();
        let (old_repo, old_bob, old_base, old_payload) =
            (&f.repo, &f.bob, base.as_ref(), &payload17);
        let mut worker = Some(scope.spawn(move || {
            old_repo.publish_legacy_interleaved(old_bob, old_base, old_payload, |event| {
                if event == LegacyPublishBoundary::AfterFinalHeadCheck {
                    checked_tx.send(()).unwrap();
                    enumerate_rx.recv().unwrap();
                }
                if event == LegacyPublishBoundary::AfterPruneEnumeration {
                    enumerated_tx.send(()).unwrap();
                    prune_rx.recv().unwrap();
                }
                Ok(())
            })
        }));
        checked_rx.recv().unwrap();
        let head17 = f.repo.read_author(bob_id).unwrap().unwrap().checkpoint();
        let failed=f.repo.commit_purge_guarded_controlled(&f.alice,"runtime",&preview,&AtomicBool::new(false),|event|if event==PurgeBoundary::BeforeEntryReplace {Err(AppError::new(ErrorCode::SaveFailed,"first preparation interrupted"))}else{Ok(())},|event| {
            if matches!(event,LegacyBoundary::AfterFence {ref author_id,..} if author_id==bob_id) {enumerate_tx.send(()).unwrap(); enumerated_rx.recv().unwrap();}
            Ok(())
        },||Ok(()));
        assert!(failed.is_err());
        assert_eq!(
            CollaborationRepository::open(&f.root)
                .unwrap()
                .manifest()
                .format_version,
            5
        );
        let prior_dir = fs::read_dir(f.root.join("maintenance"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|dir| dir.join("legacy.json").exists())
            .unwrap();
        let prior =
            LegacyJournal::parse(&fs::read(prior_dir.join("legacy.json")).unwrap()).unwrap();
        let prior_bob = prior
            .authors
            .iter()
            .find(|a| &a.author_id == bob_id)
            .unwrap();
        assert!(prior_bob.retained.contains(&2));
        assert!(!prior_bob.retired);
        let original_backup = prior_dir
            .join("rollback")
            .join(bob_id)
            .join("00000000000000000002.json");
        assert_eq!(fs::read(&original_backup).unwrap(), protected_bytes);
        if timing != PendingPruneTiming::DuringRetryBackup {
            prune_tx.send(()).unwrap();
            worker.take().unwrap().join().unwrap().unwrap();
            assert!(!f
                .root
                .join("annotations")
                .join(bob_id)
                .join("00000000000000000002.json")
                .exists());
        }
        let mut pruned_during_backup = false;
        let mut newer_won = false;
        let outcome=f.repo.commit_purge_guarded_controlled(&f.alice,"runtime",&preview,&AtomicBool::new(false), |_|Ok(()), |event| {
            if timing==PendingPruneTiming::DuringRetryBackup && !pruned_during_backup && matches!(event,LegacyBoundary::AfterBackup {ref author_id,revision:2} if author_id==bob_id) {
                prune_tx.send(()).unwrap(); worker.take().unwrap().join().unwrap().unwrap(); pruned_during_backup=true;
            }
            if timing==PendingPruneTiming::NewerPublication && !newer_won && matches!(event,LegacyBoundary::BeforeFence {ref author_id,revision:18} if author_id==bob_id) {
                f.repo.publish_legacy_interleaved(&f.bob,Some(&head17),&payload18, |_|Ok(())).unwrap(); newer_won=true;
            }
            Ok(())
        },||Ok(())).unwrap();
        assert!(outcome.committed);
        assert_eq!(outcome.removed_ids, vec![f.ids[0].clone()]);
        if timing == PendingPruneTiming::DuringRetryBackup {
            assert!(pruned_during_backup);
        }
        if timing == PendingPruneTiming::NewerPublication {
            assert!(newer_won);
        }
        let current = CollaborationRepository::open(&f.root).unwrap();
        let entry = GenerationEntry::parse(&f.entry()).unwrap();
        let dir = f.root.join("state").join(entry.metadata_generation);
        let descriptor =
            GenerationDescriptor::parse(&fs::read(dir.join("generation.json")).unwrap()).unwrap();
        let mappings: Vec<_> = descriptor
            .checkpoint_map
            .iter()
            .filter(|m| &m.author_id == bob_id)
            .collect();
        let first = if timing == PendingPruneTiming::NewerPublication {
            3
        } else {
            2
        };
        assert_eq!(
            mappings
                .iter()
                .map(|m| m.source.revision)
                .collect::<Vec<_>>(),
            (first..first + 16).collect::<Vec<_>>(),
            "retry must retain the complete protected window while respecting newer normal pruning"
        );
        let expected = if first == 2 { &protected } else { &next };
        assert_eq!(
            mappings[0].source,
            expected.checkpoint(),
            "source mapping must bind the original protected layer hash"
        );
        let projected = AuthorLayer::parse(
            &fs::read(
                dir.join("annotations")
                    .join(bob_id)
                    .join("00000000000000000001.json"),
            )
            .unwrap(),
            current.manifest(),
            bob_id,
        )
        .unwrap();
        assert_eq!(mappings[0].target, projected.checkpoint());
        let mut expected_payload = expected.payload.clone();
        expected_payload
            .media_labels
            .retain(|m| m.media_id != f.ids[0]);
        expected_payload
            .annotations
            .retain(|a| a.region.media_id != f.ids[0]);
        assert_eq!(
            projected.payload, expected_payload,
            "the complete unrelated historical payload must survive the authorized projection"
        );
        assert_eq!(
            projected.payload.categories, expected.payload.categories,
            "unrelated historical category content must survive exactly"
        );
        assert_eq!(
            projected.payload.categories[0].name,
            format!("retained category {first}")
        );
        assert_eq!(
            fs::read(original_backup).unwrap(),
            protected_bytes,
            "earlier pending original-byte ownership must remain intact"
        );
    });
    f.audio_unchanged();
}

#[test]
fn pending_history_survives_old_prune_completed_before_retry() {
    exercise_pending_history_retry(PendingPruneTiming::BeforeRetry);
}
#[test]
fn pending_history_survives_old_prune_during_retry_backup() {
    exercise_pending_history_retry(PendingPruneTiming::DuringRetryBackup);
}
#[test]
fn pending_history_does_not_resurrect_a_newer_normal_publications_pruned_layer() {
    exercise_pending_history_retry(PendingPruneTiming::NewerPublication);
}
