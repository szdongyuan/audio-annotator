use annotator_core::collaboration::purge::{
    journal::{LegacyJournal, LegacyStatus},
    legacy::LegacyRecovery,
};
use annotator_core::collaboration::{
    profiles::Profile, recycle::RecycleOperation, AuthorSession, CollaborationRepository,
    LayerPayload,
};
use annotator_core::{
    collaboration::{purge::legacy::LegacyBoundary, LegacyPublishBoundary},
    error::{AppError, ErrorCode},
};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn recycled_media(
    repo: &CollaborationRepository,
    actor: &AuthorSession,
) -> (CollaborationRepository, String) {
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let cancel = AtomicBool::new(false);
    let prepared = repo
        .prepare_media(&source, &repo.root().join("pcm"), &cancel)
        .unwrap();
    let media_id = prepared.media().id.clone();
    repo.append_media(actor, &prepared, &cancel).unwrap();
    let current = repo.reload_catalog().unwrap();
    current
        .apply_recycle_controlled(
            actor,
            0,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![media_id.clone()],
                trash: true,
            },
            &cancel,
            || Ok(()),
        )
        .unwrap();
    (current, media_id)
}

#[test]
fn fences_empty_and_published_authors_without_moving_their_writer_leases() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-legacy-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Fences", &Profile::new("Alice").unwrap())
            .unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    repo.publish(&bob, None, &payload).unwrap();
    let lease = temp.0.join(format!(
        "annotations/{}/.writer.lock",
        bob.identity().author_id
    ));
    let held = fs::File::open(&lease).unwrap();
    let _upgrade = repo
        .prepare_legacy_upgrade(&alice, &id(), &AtomicBool::new(false))
        .expect("must fence every registered author");
    annotator_core::collaboration::atomic::verify_lock_path(&lease, &held).unwrap();
    for (author, revision) in [(&alice, 1), (&bob, 2)] {
        let bytes = fs::read(temp.0.join(format!(
            "annotations/{}/{revision:020}.json",
            author.identity().author_id
        )))
        .unwrap();
        let marker: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(marker["kind"], "audio-annotator-legacy-upgrade-fence");
        assert!(marker.get("payload").is_none());
        assert!(
            repo.read_author(&author.identity().author_id).is_err(),
            "old layer codec must reject the fence"
        );
    }
    assert_eq!(repo.manifest().format_version, 5);
}

#[test]
fn failure_after_marker_restores_format5_and_keeps_recoverable_backups() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-rollback-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Rollback",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let base = repo.publish(&alice, None, &payload).unwrap();
    let operation = id();
    let result = repo.prepare_legacy_upgrade_controlled(
        &alice,
        &operation,
        &AtomicBool::new(false),
        |event| {
            if matches!(event, LegacyBoundary::AfterFence { .. }) {
                return Err(AppError::new(ErrorCode::Cancelled, "Injected cancellation"));
            }
            Ok(())
        },
    );
    assert!(matches!(result, Err(ref e) if e.code == ErrorCode::Cancelled));
    assert_eq!(
        repo.read_author(&alice.identity().author_id)
            .expect("failed preparation must remove its marker")
            .unwrap()
            .checkpoint(),
        base
    );
    let log: serde_json::Value = serde_json::from_slice(
        &fs::read(temp.0.join(format!("maintenance/{operation}/legacy.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(
        log["status"], "rollback-pending",
        "active writer lease prevents backup retirement"
    );
    assert!(temp
        .0
        .join(format!(
            "maintenance/{operation}/rollback/{}/00000000000000000001.json",
            alice.identity().author_id
        ))
        .exists());
}

#[test]
fn genuine_old_layer_wins_candidate_and_is_included_in_the_frozen_snapshot() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-real-wins-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Race", &Profile::new("Alice").unwrap())
            .unwrap();
    let (repo, media_id) = recycled_media(&repo, &alice);
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let mut document = repo.manifest().base_document().unwrap();
    let category = annotator_core::model::Category {
        id: id(),
        name: "Late foreign label".into(),
        color: "#123456".into(),
    };
    document.media[0].category_ids.push(category.id.clone());
    document.categories.push(category);
    let payload = LayerPayload::from_document(&document).unwrap();
    let original_entry = fs::read(temp.0.join("collaboration.json")).unwrap();
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = channel();
        let (go_tx, go_rx) = channel();
        let (done_tx, done_rx) = channel();
        let (old_repo, old_bob, old_payload) = (&repo, &bob, &payload);
        scope.spawn(move || {
            let checkpoint = old_repo
                .publish_legacy_interleaved(old_bob, None, old_payload, |event| {
                    if event == LegacyPublishBoundary::BeforeNoReplace {
                        ready_tx.send(()).unwrap();
                        go_rx.recv().unwrap();
                    }
                    Ok(())
                })
                .unwrap();
            done_tx.send(checkpoint).unwrap();
        });
        ready_rx.recv().unwrap();
        let mut won = None;
        let upgrade = repo.prepare_legacy_upgrade_controlled(&alice, &id(), &AtomicBool::new(false), |event| {
            if matches!(event, LegacyBoundary::BeforeFence { ref author_id, revision: 1 } if author_id == &bob.identity().author_id) {
                go_tx.send(()).unwrap();
                won = Some(done_rx.recv().unwrap());
            }
            Ok(())
        }).unwrap();
        let frozen = upgrade
            .authority()
            .snapshot()
            .authors
            .iter()
            .find(|a| a.identity.author_id == bob.identity().author_id)
            .unwrap()
            .layer
            .as_ref()
            .unwrap();
        assert_eq!(Some(frozen.checkpoint()), won);
        assert!(temp
            .0
            .join(format!(
                "annotations/{}/00000000000000000002.json",
                bob.identity().author_id
            ))
            .exists());
        assert_eq!(
            upgrade.authority().classify(&media_id),
            annotator_core::collaboration::purge::Eligibility::OtherAuthorAnnotation
        );
        upgrade.rollback().unwrap(); // every requested item became unauthorized
        assert_eq!(
            fs::read(temp.0.join("collaboration.json")).unwrap(),
            original_entry
        );
        assert_eq!(
            repo.read_author(&bob.identity().author_id)
                .unwrap()
                .unwrap()
                .payload,
            payload
        );
    });
}

#[test]
fn marker_wins_and_old_no_replace_cannot_overwrite_it() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-fence-wins-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Race", &Profile::new("Alice").unwrap())
            .unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = channel();
        let (go_tx, go_rx) = channel();
        let (done_tx, done_rx) = channel();
        let (old_repo, old_bob, old_payload) = (&repo, &bob, &payload);
        scope.spawn(move || {
            let result = old_repo.publish_legacy_interleaved(old_bob, None, old_payload, |event| {
                if event == LegacyPublishBoundary::BeforeNoReplace {
                    ready_tx.send(()).unwrap();
                    go_rx.recv().unwrap();
                }
                Ok(())
            });
            done_tx.send(result).unwrap();
        });
        ready_rx.recv().unwrap();
        let _upgrade = repo.prepare_legacy_upgrade_controlled(&alice, &id(), &AtomicBool::new(false), |event| {
            if matches!(event, LegacyBoundary::AfterFence { ref author_id, .. } if author_id == &bob.identity().author_id) {
                go_tx.send(()).unwrap();
                assert!(matches!(done_rx.recv().unwrap(), Err(ref e) if e.code == ErrorCode::RevisionConflict));
            }
            Ok(())
        }).unwrap();
    });
}

#[test]
fn delayed_old_prune_after_cancel_is_repaired_until_the_original_lease_retires() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-late-prune-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Prune", &Profile::new("Alice").unwrap())
            .unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let mut base = None;
    for _ in 0..16 {
        base = Some(repo.publish(&bob, base.as_ref(), &payload).unwrap());
    }
    let oldest_retained = temp.0.join(format!(
        "annotations/{}/00000000000000000002.json",
        bob.identity().author_id
    ));
    let exact = fs::read(&oldest_retained).unwrap();
    let operation = id();
    std::thread::scope(|scope| {
        let (checked_tx, checked_rx) = channel();
        let (enumerate_tx, enumerate_rx) = channel();
        let (enumerated_tx, enumerated_rx) = channel();
        let (prune_tx, prune_rx) = channel();
        let (old_repo, old_bob, old_payload, old_base) = (&repo, &bob, &payload, base.as_ref());
        let worker = scope.spawn(move || {
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
        });
        checked_rx.recv().unwrap(); // genuine 17 published; final old head check passed
        let upgrade = repo.prepare_legacy_upgrade_controlled(&alice, &operation, &AtomicBool::new(false), |event| {
            if matches!(event, LegacyBoundary::AfterFence { ref author_id, .. } if author_id == &bob.identity().author_id) {
                enumerate_tx.send(()).unwrap(); enumerated_rx.recv().unwrap();
            }
            Ok(())
        }).unwrap(); // marker 18 was counted by the paused old prune
        let backup = temp.0.join(format!(
            "maintenance/{operation}/rollback/{}/00000000000000000002.json",
            bob.identity().author_id
        ));
        assert_eq!(
            fs::read(&backup).unwrap(),
            exact,
            "backup must predate marker insertion"
        );
        assert_eq!(upgrade.rollback().unwrap(), LegacyRecovery::RollbackPending);
        prune_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert!(
            !oldest_retained.exists(),
            "the frozen old prune must actually delete the extra genuine layer"
        );
        assert_eq!(
            repo.recover_legacy_upgrade(&operation).unwrap(),
            LegacyRecovery::RollbackPending
        );
        assert_eq!(fs::read(&oldest_retained).unwrap(), exact);
        assert!(
            backup.exists(),
            "an active stable lease is not worker-retirement proof"
        );
    });
    drop(bob);
    drop(alice);
    assert_eq!(
        repo.recover_legacy_upgrade(&operation).unwrap(),
        LegacyRecovery::RolledBack
    );
    let log = LegacyJournal::parse(
        &fs::read(temp.0.join(format!("maintenance/{operation}/legacy.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(log.status, LegacyStatus::RolledBack);
    for author in log.authors {
        for backup in author.backups {
            assert!(!temp
                .0
                .join(format!(
                    "maintenance/{operation}/rollback/{}/{:020}.json",
                    author.author_id, backup.revision
                ))
                .exists());
        }
    }
    assert_eq!(
        repo.recover_legacy_upgrade(&operation).unwrap(),
        LegacyRecovery::RolledBack
    );
}

#[test]
fn recovery_cannot_roll_back_an_active_upgrader_and_rejects_changed_ownership() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-owner-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Recovery",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let operation = id();
    let upgrade = repo
        .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
        .unwrap();
    assert!(
        matches!(repo.recover_legacy_upgrade(&operation), Err(ref e) if e.code == ErrorCode::ProjectLocked)
    );
    let marker = temp.0.join(format!(
        "annotations/{}/00000000000000000001.json",
        alice.identity().author_id
    ));
    let original = fs::read(&marker).unwrap();
    drop(upgrade); // crash releases migration locks
    let log_path = temp.0.join(format!("maintenance/{operation}/legacy.json"));
    let mut changed: serde_json::Value =
        serde_json::from_slice(&fs::read(&log_path).unwrap()).unwrap();
    changed["ownerId"] = serde_json::json!(id());
    fs::write(&log_path, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(repo.recover_legacy_upgrade(&operation).is_err());
    assert_eq!(
        fs::read(&marker).unwrap(),
        original,
        "foreign marker must remain untouched"
    );
}

#[test]
fn recovery_never_resurrects_history_pruned_by_a_new_normal_publication() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-new-prune-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Prune", &Profile::new("Alice").unwrap())
            .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let mut base = None;
    for _ in 0..16 {
        base = Some(repo.publish(&alice, base.as_ref(), &payload).unwrap());
    }
    let operation = id();
    let upgrade = repo
        .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
        .unwrap();
    upgrade.rollback().unwrap();
    repo.publish(&alice, base.as_ref(), &payload).unwrap();
    let old = temp.0.join(format!(
        "annotations/{}/00000000000000000001.json",
        alice.identity().author_id
    ));
    assert!(!old.exists());
    repo.recover_legacy_upgrade(&operation).unwrap();
    assert!(
        !old.exists(),
        "source-head binding must not undo later normal retention"
    );
}

#[test]
fn failure_before_journal_or_marker_does_not_publish_a_fence() {
    for point in [
        LegacyBoundary::BeforeJournal,
        LegacyBoundary::BeforeFence {
            author_id: String::new(),
            revision: 1,
        },
    ] {
        let temp = Temp(std::env::temp_dir().join(format!("purge-before-marker-{}", id())));
        fs::create_dir(&temp.0).unwrap();
        let (repo, alice) = CollaborationRepository::create_default(
            &temp.0,
            "Failure",
            &Profile::new("Alice").unwrap(),
        )
        .unwrap();
        let result = repo.prepare_legacy_upgrade_controlled(
            &alice,
            &id(),
            &AtomicBool::new(false),
            |event| {
                if std::mem::discriminant(&event) == std::mem::discriminant(&point) {
                    return Err(AppError::new(
                        ErrorCode::SaveFailed,
                        "Injected prepublication failure",
                    ));
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(repo
            .read_author(&alice.identity().author_id)
            .unwrap()
            .is_none());
        assert_eq!(repo.manifest().format_version, 5);
    }
}

#[test]
fn immediate_old_prune_cannot_erase_the_history_needed_for_the_new_generation() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-prune-backup-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "History",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let mut base = None;
    for _ in 0..16 {
        base = Some(repo.publish(&bob, base.as_ref(), &payload).unwrap());
    }
    std::thread::scope(|scope| {
        let (checked_tx, checked_rx) = channel();
        let (prune_tx, prune_rx) = channel();
        let (done_tx, done_rx) = channel();
        let (old_repo, old_bob, old_payload, old_base) = (&repo, &bob, &payload, base.as_ref());
        scope.spawn(move || {
            let result =
                old_repo.publish_legacy_interleaved(old_bob, old_base, old_payload, |event| {
                    if event == LegacyPublishBoundary::AfterFinalHeadCheck {
                        checked_tx.send(()).unwrap();
                        prune_rx.recv().unwrap();
                    }
                    Ok(())
                });
            done_tx.send(result).unwrap();
        });
        checked_rx.recv().unwrap();
        let upgrade = repo.prepare_legacy_upgrade_controlled(&alice, &id(), &AtomicBool::new(false), |event| {
            if matches!(event, LegacyBoundary::AfterFence { ref author_id, .. } if author_id == &bob.identity().author_id) {
                prune_tx.send(()).unwrap(); done_rx.recv().unwrap().unwrap();
            }
            Ok(())
        }).unwrap();
        assert!(!temp
            .0
            .join(format!(
                "annotations/{}/00000000000000000002.json",
                bob.identity().author_id
            ))
            .exists());
        let history = upgrade
            .retained_history(&bob.identity().author_id)
            .expect("new generation must use durable genuine history backups");
        assert_eq!(history.len(), 16);
        assert_eq!(history.first().unwrap().revision, 2);
        assert_eq!(history.last().unwrap().revision, 17);
        assert!(history
            .windows(2)
            .all(|p| p[1].parent.as_ref() == Some(&p[0].checkpoint())));
        assert_eq!(upgrade.rollback().unwrap(), LegacyRecovery::RollbackPending);
        assert!(temp
            .0
            .join(format!(
                "annotations/{}/00000000000000000002.json",
                bob.identity().author_id
            ))
            .exists());
    });
}

#[test]
fn interruption_during_backup_does_not_leave_unowned_user_content() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-partial-backup-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Backup", &Profile::new("Alice").unwrap())
            .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    repo.publish(&alice, None, &payload).unwrap();
    let operation = id();
    let result = repo.prepare_legacy_upgrade_controlled(
        &alice,
        &operation,
        &AtomicBool::new(false),
        |event| {
            if matches!(event, LegacyBoundary::AfterBackup { .. }) {
                return Err(AppError::new(ErrorCode::SaveFailed, "Interrupted backup"));
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    let log = LegacyJournal::parse(
        &fs::read(temp.0.join(format!("maintenance/{operation}/legacy.json"))).unwrap(),
    )
    .unwrap();
    let backup = temp.0.join(format!(
        "maintenance/{operation}/rollback/{}/00000000000000000001.json",
        alice.identity().author_id
    ));
    assert!(
        !backup.exists()
            || (log.status == LegacyStatus::RollbackPending
                && log
                    .authors
                    .iter()
                    .any(|a| a.author_id == alice.identity().author_id
                        && a.backups.iter().any(|b| b.revision == 1))),
        "every user-data backup must remain owned by durable recovery state"
    );
    assert!(repo
        .read_author(&alice.identity().author_id)
        .unwrap()
        .is_some());
}

#[test]
fn normal_prune_during_backup_retries_a_complete_history_snapshot() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-backup-race-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "History",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let mut base = None;
    for _ in 0..16 {
        base = Some(repo.publish(&alice, base.as_ref(), &payload).unwrap());
    }
    let mut published = false;
    let upgrade = repo
        .prepare_legacy_upgrade_controlled(&alice, &id(), &AtomicBool::new(false), |event| {
            if matches!(event, LegacyBoundary::AfterBackup { revision: 1, .. }) && !published {
                repo.publish_legacy_interleaved(&alice, base.as_ref(), &payload, |_| Ok(()))?;
                published = true;
            }
            Ok(())
        })
        .unwrap();
    let history = upgrade
        .retained_history(&alice.identity().author_id)
        .unwrap();
    assert_eq!(history.len(), 16);
    assert_eq!(history[0].revision, 2);
    assert_eq!(history[15].revision, 17);
    upgrade.rollback().unwrap();
}

// A strict, already committed format-6 fixture. No production transaction or
// media unlink is implemented by Task 3. Both actual codecs and open() validate it.
fn install_committed_generation(
    repo: &CollaborationRepository,
    operation: &str,
    actor: &AuthorSession,
    removed: &str,
) {
    use annotator_core::collaboration::{
        organization::Organization,
        purge::{
            generation::{GenerationDescriptor, GenerationEntry},
            journal::{PurgeReceipt, RetiredMedia},
        },
    };
    use sha2::{Digest, Sha256};
    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    let source = fs::read(repo.root().join("collaboration.json")).unwrap();
    let generation = id();
    let dir = repo.root().join("state").join(&generation);
    fs::create_dir_all(dir.join("catalog")).unwrap();
    fs::create_dir(dir.join("annotations")).unwrap();
    let descriptor = GenerationDescriptor {
        kind: "audio-annotator-metadata-generation".into(),
        format_version: 1,
        project_id: repo.manifest().project_id.clone(),
        generation_id: generation.clone(),
        source_entry_hash: hash(&source),
        source_generation: None,
        checkpoint_map: vec![],
        receipts: vec![PurgeReceipt {
            operation_id: operation.into(),
            cleanup_manifest_hash: hash(b"legacy fixture cleanup"),
            legacy_preparation_id: Some(operation.into()),
            actor_id: actor.identity().author_id.clone(),
            request_hash: hash(removed.as_bytes()),
            source_entry_hash: hash(&source),
            generation_id: generation.clone(),
            requested_ids: vec![removed.into()],
            removed_ids: vec![removed.into()],
            retained: vec![],
        }],
        retired: vec![RetiredMedia {
            media_id: removed.into(),
            operation_id: operation.into(),
        }],
    };
    let descriptor = serde_json::to_vec(&descriptor).unwrap();
    GenerationDescriptor::parse(&descriptor).unwrap();
    fs::write(dir.join("source-entry.json"), source).unwrap();
    fs::write(dir.join("generation.json"), &descriptor).unwrap();
    fs::write(
        dir.join("organization.json"),
        serde_json::to_vec(&Organization::empty(repo.manifest().project_id.clone())).unwrap(),
    )
    .unwrap();
    fs::write(dir.join("recycle.json"), serde_json::to_vec(&serde_json::json!({"kind":"audio-annotator-recycle", "formatVersion":1, "projectId":repo.manifest().project_id, "revision":0, "trashed":[], "recentOperations":[]})).unwrap()).unwrap();
    let entry = GenerationEntry {
        kind: repo.manifest().kind.clone(),
        format_version: 6,
        project_id: repo.manifest().project_id.clone(),
        name: repo.manifest().name.clone(),
        created_at: repo.manifest().created_at.clone(),
        catalog_version: 2,
        metadata_generation: generation,
        generation_hash: hash(&descriptor),
    };
    let bytes = serde_json::to_vec(&entry).unwrap();
    GenerationEntry::parse(&bytes).unwrap();
    fs::write(repo.root().join("collaboration.json"), bytes).unwrap();
    assert_eq!(
        CollaborationRepository::open(repo.root())
            .unwrap()
            .manifest()
            .format_version,
        6
    );
}

#[test]
fn committed_recovery_keeps_payload_free_numeric_fences_and_blocks_the_paused_old_writer() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-committed-fence-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Committed",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let (repo, media_id) = recycled_media(&repo, &alice);
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    repo.publish(&alice, None, &payload).unwrap();
    let operation = id();
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = channel();
        let (go_tx, go_rx) = channel();
        let (old_repo, old_bob, old_payload) = (&repo, &bob, &payload);
        let worker = scope.spawn(move || {
            old_repo.publish_legacy_interleaved(old_bob, None, old_payload, |event| {
                if event == LegacyPublishBoundary::BeforeNoReplace {
                    ready_tx.send(()).unwrap();
                    go_rx.recv().unwrap();
                }
                Ok(())
            })
        });
        ready_rx.recv().unwrap();
        let upgrade = repo
            .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
            .unwrap();
        let markers: Vec<_> = [(&alice, 2), (&bob, 1)]
            .iter()
            .map(|(author, revision)| {
                let path = temp.0.join(format!(
                    "annotations/{}/{revision:020}.json",
                    author.identity().author_id
                ));
                let bytes = fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect();
        install_committed_generation(&repo, &operation, &alice, &media_id);
        assert_eq!(
            upgrade.record_committed().unwrap(),
            LegacyRecovery::Committed
        );
        // Simulate the later committed cleanup of exact old user-data paths.
        // Recovery must not recursively need already retired source history.
        fs::remove_file(temp.0.join(format!(
            "annotations/{}/00000000000000000001.json",
            alice.identity().author_id
        )))
        .unwrap();
        fs::remove_file(temp.0.join(format!(
            "maintenance/{operation}/rollback/{}/00000000000000000001.json",
            alice.identity().author_id
        )))
        .unwrap();
        assert_eq!(
            repo.recover_legacy_upgrade(&operation).unwrap(),
            LegacyRecovery::Committed
        );
        for (path, bytes) in markers {
            assert_eq!(fs::read(path).unwrap(), bytes);
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert!(value.get("payload").is_none());
            assert!(value.get("annotations").is_none());
        }
        go_tx.send(()).unwrap();
        assert!(
            matches!(worker.join().unwrap(), Err(ref e) if e.code == ErrorCode::RevisionConflict),
            "old no_replace must still collide after entry commit"
        );
    });
}

#[test]
fn own_drained_publications_can_retire_backups_without_closing_the_session() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-own-drain-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Drain", &Profile::new("Alice").unwrap())
            .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let base = repo.publish(&alice, None, &payload).unwrap();
    let operation = id();
    let lease = temp.0.join(format!(
        "annotations/{}/.writer.lock",
        alice.identity().author_id
    ));
    let held = fs::File::open(&lease).unwrap();
    let upgrade = repo
        .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        upgrade.rollback_with_drained_session(&alice).unwrap(),
        LegacyRecovery::RolledBack,
        "local publication draining plus the held lease must permit safe retirement"
    );
    annotator_core::collaboration::atomic::verify_lock_path(&lease, &held).unwrap();
    assert!(
        repo.publish(&alice, Some(&base), &payload).is_ok(),
        "the original session and stable lease remain usable"
    );
}

#[test]
fn cancellation_at_the_final_frozen_boundary_rolls_back_before_returning() {
    use std::sync::atomic::Ordering;
    let temp = Temp(std::env::temp_dir().join(format!("purge-final-cancel-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Cancel", &Profile::new("Alice").unwrap())
            .unwrap();
    let cancel = AtomicBool::new(false);
    let result = repo.prepare_legacy_upgrade_controlled(&alice, &id(), &cancel, |event| {
        if event == LegacyBoundary::Frozen {
            cancel.store(true, Ordering::Release);
        }
        Ok(())
    });
    assert!(
        matches!(result, Err(ref e) if e.code == ErrorCode::Cancelled),
        "final cancellation must still be precommit rollback"
    );
    assert!(repo
        .read_author(&alice.identity().author_id)
        .unwrap()
        .is_none());
}

#[test]
fn a_live_local_old_worker_is_not_a_valid_drained_session_proof() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-drain-proof-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Drain", &Profile::new("Alice").unwrap())
            .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let operation = id();
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = channel();
        let (go_tx, go_rx) = channel();
        let (old_repo, old_actor, old_payload) = (&repo, &alice, &payload);
        let worker = scope.spawn(move || {
            old_repo.publish_legacy_interleaved(old_actor, None, old_payload, |event| {
                if event == LegacyPublishBoundary::BeforeNoReplace {
                    ready_tx.send(()).unwrap();
                    go_rx.recv().unwrap();
                }
                Ok(())
            })
        });
        ready_rx.recv().unwrap();
        let upgrade = repo
            .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
            .unwrap();
        drop(upgrade);
        assert!(
            matches!(repo.recover_legacy_upgrade_drained(&operation, &alice), Err(ref e) if e.code == ErrorCode::ProjectLocked)
        );
        go_tx.send(()).unwrap();
        assert!(
            matches!(worker.join().unwrap(), Err(ref e) if e.code == ErrorCode::RevisionConflict)
        );
        assert_eq!(
            repo.recover_legacy_upgrade_drained(&operation, &alice)
                .unwrap(),
            LegacyRecovery::RolledBack
        );
    });
}

#[test]
fn invalid_backup_digest_stops_recovery_before_it_removes_owned_markers() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-corrupt-backup-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Integrity",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    repo.publish(&alice, None, &payload).unwrap();
    let operation = id();
    drop(
        repo.prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
            .unwrap(),
    );
    let marker = temp.0.join(format!(
        "annotations/{}/00000000000000000002.json",
        alice.identity().author_id
    ));
    let backup = temp.0.join(format!(
        "maintenance/{operation}/rollback/{}/00000000000000000001.json",
        alice.identity().author_id
    ));
    fs::write(&backup, b"different data").unwrap();
    let exact = fs::read(&marker).unwrap();
    assert!(repo.recover_legacy_upgrade(&operation).is_err());
    assert_eq!(fs::read(marker).unwrap(), exact);
}

#[test]
fn crash_after_no_replace_before_fenced_journal_update_recovers_from_durable_intent() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-marker-crash-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Crash", &Profile::new("Alice").unwrap())
            .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let base = repo.publish(&alice, None, &payload).unwrap();
    let operation = id();
    let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        repo.prepare_legacy_upgrade_controlled(
            &alice,
            &operation,
            &AtomicBool::new(false),
            |event| {
                if matches!(event, LegacyBoundary::AfterFencePublication { .. }) {
                    panic!("Simulated process interruption after atomic no_replace");
                }
                Ok(())
            },
        )
        .map(|_| ())
    }));
    assert!(crash.is_err());
    let log = LegacyJournal::parse(
        &fs::read(temp.0.join(format!("maintenance/{operation}/legacy.json"))).unwrap(),
    )
    .unwrap();
    assert!(!log.authors[0].fenced);
    assert!(repo.read_author(&alice.identity().author_id).is_err());
    assert_eq!(
        repo.recover_legacy_upgrade(&operation).unwrap(),
        LegacyRecovery::RollbackPending
    );
    assert_eq!(
        repo.read_author(&alice.identity().author_id)
            .unwrap()
            .unwrap()
            .checkpoint(),
        base
    );
}

#[test]
fn migration_holds_catalog_then_registration_locks_and_stabilizes_registered_authors() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-registration-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Registration",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let upgrade = repo
        .prepare_legacy_upgrade(&alice, &id(), &AtomicBool::new(false))
        .unwrap();
    for name in ["catalog/.commit.lock", "authors/.registration.lock"] {
        let competing = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(repo.root().join(name))
            .unwrap();
        assert!(
            competing.try_lock().is_err(),
            "the migration must hold {name}"
        );
    }
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = channel();
        let old_repo = &repo;
        let worker = scope.spawn(move || {
            ready_tx.send(()).unwrap();
            old_repo
                .adopt(&Profile::new("New author").unwrap())
                .unwrap()
        });
        ready_rx.recv().unwrap();
        assert_eq!(upgrade.authority().snapshot().authors.len(), 1);
        upgrade.rollback().unwrap();
        let registered = worker.join().unwrap();
        assert!(
            repo.purge_authority(&registered)
                .unwrap()
                .snapshot()
                .authors
                .len()
                == 2
        );
    });
}

#[test]
fn strict_legacy_log_codec_rejects_missing_duplicate_and_unsafe_fields() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-log-codec-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Codec", &Profile::new("Alice").unwrap())
            .unwrap();
    let operation = id();
    let _upgrade = repo
        .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
        .unwrap();
    let bytes = fs::read(temp.0.join(format!("maintenance/{operation}/legacy.json"))).unwrap();
    let good: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut falsely_finished = good.clone();
    falsely_finished["status"] = serde_json::json!("rolled-back");
    assert!(
        LegacyJournal::parse(&serde_json::to_vec(&falsely_finished).unwrap()).is_err(),
        "rolled-back requires retired backup proof records"
    );
    let mut bad = good.clone();
    bad["authors"][0]
        .as_object_mut()
        .unwrap()
        .remove("backupsReady");
    assert!(LegacyJournal::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    let text = String::from_utf8(bytes).unwrap();
    let duplicate = text.replacen('{', &format!("{{\"ownerId\":\"{}\",", id()), 1);
    assert!(LegacyJournal::parse(duplicate.as_bytes()).is_err());
    for (field, value) in [
        ("candidateRevision", serde_json::json!(u64::MAX)),
        ("retained", serde_json::json!([u64::MAX, 1])),
        (
            "predecessor",
            serde_json::json!({"revision":u64::MAX,"hash":"a".repeat(64)}),
        ),
    ] {
        let mut bad = good.clone();
        bad["authors"][0][field] = value;
        assert!(
            LegacyJournal::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "{field}"
        );
    }
}

#[test]
fn a_valid_but_unrelated_backup_layer_cannot_break_the_retained_parent_chain() {
    use annotator_core::collaboration::AuthorLayer;
    use sha2::{Digest, Sha256};
    let temp = Temp(std::env::temp_dir().join(format!("purge-backup-chain-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Chain", &Profile::new("Alice").unwrap())
            .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let base = repo.publish(&alice, None, &payload).unwrap();
    repo.publish(&alice, Some(&base), &payload).unwrap();
    let operation = id();
    drop(
        repo.prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
            .unwrap(),
    );
    let dir = temp.0.join(format!("maintenance/{operation}"));
    let backup = dir.join(format!(
        "rollback/{}/00000000000000000001.json",
        alice.identity().author_id
    ));
    let mut layer: AuthorLayer = serde_json::from_slice(&fs::read(&backup).unwrap()).unwrap();
    layer
        .payload
        .categories
        .push(annotator_core::model::Category {
            id: id(),
            name: "Unrelated valid branch".into(),
            color: "#123456".into(),
        });
    layer.hash = layer.computed_hash().unwrap();
    let bytes = serde_json::to_vec(&layer).unwrap();
    AuthorLayer::parse(&bytes, repo.manifest(), &alice.identity().author_id).unwrap();
    fs::write(&backup, &bytes).unwrap();
    let mut log: serde_json::Value =
        serde_json::from_slice(&fs::read(dir.join("legacy.json")).unwrap()).unwrap();
    log["authors"][0]["backups"][0]["byteHash"] =
        serde_json::json!(format!("{:x}", Sha256::digest(&bytes)));
    log["authors"][0]["backups"][0]["byteLength"] = serde_json::json!(bytes.len());
    fs::write(dir.join("legacy.json"), serde_json::to_vec(&log).unwrap()).unwrap();
    let marker = temp.0.join(format!(
        "annotations/{}/00000000000000000003.json",
        alice.identity().author_id
    ));
    let exact = fs::read(&marker).unwrap();
    assert!(repo.recover_legacy_upgrade(&operation).is_err());
    assert_eq!(
        fs::read(marker).expect("chain validation must precede marker removal"),
        exact
    );
}

#[test]
fn repeated_genuine_revision_winners_exhaust_a_bounded_retryable_conflict() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-bounded-race-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Conflict",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let mut base = None;
    let mut attempts = 0;
    let result = repo.prepare_legacy_upgrade_controlled(&alice, &id(), &AtomicBool::new(false), |event| {
        if matches!(event, LegacyBoundary::BeforeFence { ref author_id, .. } if author_id == &bob.identity().author_id) {
            base = Some(repo.publish_legacy_interleaved(&bob, base.as_ref(), &payload, |_| Ok(()))?);
            attempts += 1;
        }
        Ok(())
    });
    assert_eq!(attempts, 32);
    assert!(
        matches!(result, Err(ref e) if e.code == ErrorCode::RevisionConflict && e.retryable),
        "bounded contention must return an explicitly retryable conflict"
    );
    assert_eq!(
        repo.read_author(&bob.identity().author_id)
            .unwrap()
            .unwrap()
            .checkpoint(),
        base.unwrap()
    );
}

#[test]
fn a_new_normal_prune_during_restoration_cannot_be_undone_by_stale_backup_writes() {
    let temp = Temp(std::env::temp_dir().join(format!("purge-restore-prune-race-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Restore race",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let mut base = None;
    for _ in 0..16 {
        base = Some(repo.publish(&alice, base.as_ref(), &payload).unwrap());
    }
    let operation = id();
    let upgrade = repo
        .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
        .unwrap();
    let mut published = false;
    upgrade
        .rollback_interleaved(|author, revision| {
            if author == alice.identity().author_id && revision == 1 && !published {
                repo.publish_legacy_interleaved(&alice, base.as_ref(), &payload, |_| Ok(()))?;
                published = true;
            }
            Ok(())
        })
        .unwrap();
    assert!(published);
    assert!(
        !temp
            .0
            .join(format!(
                "annotations/{}/00000000000000000001.json",
                alice.identity().author_id
            ))
            .exists(),
        "rollback must not resurrect a layer which the new publication just legitimately retired"
    );
}

#[test]
fn interrupted_restoration_owns_and_repairs_its_prefix_after_a_new_prune_creates_a_gap() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-restore-gap-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Restore gap",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let mut base = None;
    for _ in 0..16 {
        base = Some(repo.publish(&alice, base.as_ref(), &payload).unwrap());
    }
    let operation = id();
    let upgrade = repo
        .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
        .unwrap();
    std::thread::scope(|scope| {
        let (start_tx, start_rx) = channel();
        let (enumerated_tx, enumerated_rx) = channel();
        let (go_tx, go_rx) = channel();
        let (done_tx, done_rx) = channel();
        let (old_repo, old_actor, old_payload) = (&repo, &alice, &payload);
        scope.spawn(move || {
            let base = start_rx.recv().unwrap();
            let result =
                old_repo.publish_legacy_interleaved(old_actor, Some(&base), old_payload, |event| {
                    if event == LegacyPublishBoundary::AfterPruneEnumeration {
                        enumerated_tx.send(()).unwrap();
                        go_rx.recv().unwrap();
                    }
                    Ok(())
                });
            done_tx.send(result).unwrap();
        });
        let mut began = false;
        let crash = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            upgrade.rollback_interleaved(|_, revision| {
            if revision == 1 && !began {
                let next = repo.publish_legacy_interleaved(&alice, base.as_ref(), &payload, |_| Ok(()))?;
                start_tx.send(next).unwrap(); enumerated_rx.recv().unwrap(); began = true;
            }
            if revision == 3 {
                go_tx.send(()).unwrap(); done_rx.recv().unwrap().unwrap();
                panic!("Interrupted after a new prune removed revision 2, leaving our restored revision 1");
            }
            Ok(())
        })
        }));
        assert!(crash.is_err());
    });
    let oldest = temp.0.join(format!(
        "annotations/{}/00000000000000000001.json",
        alice.identity().author_id
    ));
    assert!(oldest.exists());
    assert!(!temp
        .0
        .join(format!(
            "annotations/{}/00000000000000000002.json",
            alice.identity().author_id
        ))
        .exists());
    assert!(
        repo.read_author(&alice.identity().author_id).is_err(),
        "the ordinary strict reader must see the real numeric gap"
    );
    assert_eq!(
        repo.recover_legacy_upgrade(&operation).unwrap(),
        LegacyRecovery::RollbackPending
    );
    assert!(
        !oldest.exists(),
        "only the durably owned stale restoration is removed"
    );
    assert_eq!(
        repo.read_author(&alice.identity().author_id)
            .unwrap()
            .unwrap()
            .revision,
        18
    );
    assert_eq!(
        repo.recover_legacy_upgrade_drained(&operation, &alice)
            .unwrap(),
        LegacyRecovery::RolledBack
    );
}

#[test]
fn cancellation_with_a_busy_own_publication_still_removes_markers_without_retiring_backups() {
    use std::sync::mpsc::channel;
    let temp = Temp(std::env::temp_dir().join(format!("purge-busy-cancel-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    let (repo, alice) = CollaborationRepository::create_default(
        &temp.0,
        "Busy cancellation",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let base = repo.publish(&alice, None, &payload).unwrap();
    let operation = id();
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = channel();
        let (go_tx, go_rx) = channel();
        let (old_repo, old_actor, old_payload, old_base) = (&repo, &alice, &payload, &base);
        let worker = scope.spawn(move || {
            old_repo.publish_legacy_interleaved(old_actor, Some(old_base), old_payload, |event| {
                if event == LegacyPublishBoundary::BeforeNoReplace {
                    ready_tx.send(()).unwrap();
                    go_rx.recv().unwrap();
                }
                Ok(())
            })
        });
        ready_rx.recv().unwrap();
        let upgrade = repo
            .prepare_legacy_upgrade(&alice, &operation, &AtomicBool::new(false))
            .unwrap();
        let result = upgrade.rollback_with_drained_session(&alice);
        go_tx.send(()).unwrap();
        let resumed = worker.join().unwrap();
        assert_eq!(
            result.unwrap(),
            LegacyRecovery::RollbackPending,
            "failure to prove drain must still cancel preparation"
        );
        assert_eq!(
            resumed.unwrap().revision,
            2,
            "cancelled marker no longer blocks a genuine old publication"
        );
        assert_eq!(
            repo.recover_legacy_upgrade_drained(&operation, &alice)
                .unwrap(),
            LegacyRecovery::RolledBack
        );
    });
}

#[test]
fn accumulated_backup_limit_rejects_before_fencing_and_recovers_earlier_authors() {
    use annotator_core::collaboration::MAX_TOTAL_LAYER_BYTES;
    let temp = Temp(std::env::temp_dir().join(format!("purge-backup-budget-{}", id())));
    fs::create_dir(&temp.0).unwrap();
    // Native author enumeration is sorted by UUID. Alice must already be fenced
    // when Bob's first real winning publication pushes accumulated backups over
    // the budget, although Bob's current retained 16-layer window still fits.
    let mut alice_profile = Profile::new("Earlier author").unwrap();
    alice_profile.author_id = "00000000-0000-4000-8000-000000000001".into();
    let (repo, alice) =
        CollaborationRepository::create_default(&temp.0, "Backup budget", &alice_profile).unwrap();
    let (repo, _) = recycled_media(&repo, &alice);
    let payload = LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap();
    let alice_base = repo.publish(&alice, None, &payload).unwrap();
    let alice_path = temp.0.join(format!(
        "annotations/{}/00000000000000000001.json",
        alice.identity().author_id
    ));
    let original_alice = fs::read(&alice_path).unwrap();
    let original_entry = fs::read(temp.0.join("collaboration.json")).unwrap();
    let mut bob_profile = Profile::new("Racing author").unwrap();
    bob_profile.author_id = "00000000-0000-4000-8000-000000000002".into();
    let bob = repo.adopt(&bob_profile).unwrap();
    let mut large_payload = payload;
    large_payload.media_labels[0].note = "n".repeat(4 * 1024 * 1024 - 4096);
    let mut bob_base = None;
    for _ in 0..16 {
        bob_base = Some(
            repo.publish(&bob, bob_base.as_ref(), &large_payload)
                .unwrap(),
        );
    }
    let bob_dir = temp.0.join("annotations").join(&bob.identity().author_id);
    let retained_bytes: u64 = fs::read_dir(&bob_dir)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .map(|entry| entry.metadata().unwrap().len())
        .sum();
    assert!(retained_bytes < MAX_TOTAL_LAYER_BYTES as u64);
    let operation = id();
    let mut earlier_fenced = false;
    let mut raced = false;
    let result = repo.prepare_legacy_upgrade_controlled(&alice, &operation, &AtomicBool::new(false), |event| {
        if matches!(event, LegacyBoundary::AfterFence { ref author_id, .. } if author_id == &alice.identity().author_id) { earlier_fenced = true; }
        if matches!(event, LegacyBoundary::BeforeFence { ref author_id, .. } if author_id == &bob.identity().author_id) && !raced {
            assert!(earlier_fenced);
            bob_base = Some(repo.publish_legacy_interleaved(&bob, bob_base.as_ref(), &large_payload, |_| Ok(()))?);
            raced = true;
        }
        Ok(())
    });
    assert!(earlier_fenced && raced);
    match result {
        Err(error) => assert_eq!(error.code, ErrorCode::ResourceLimit),
        Ok(_) => panic!("preparation must reject excess accumulated backup ownership before persisting an unrecoverable journal or another fence"),
    }
    let log_path = temp.0.join(format!("maintenance/{operation}/legacy.json"));
    let journal = LegacyJournal::parse(&fs::read(&log_path).unwrap()).unwrap();
    assert_eq!(journal.status, LegacyStatus::RollbackPending);
    let bob_log = journal
        .authors
        .iter()
        .find(|author| author.author_id == bob.identity().author_id)
        .unwrap();
    assert_eq!(bob_log.backups.len(), 16);
    assert!(
        bob_log
            .backups
            .iter()
            .map(|backup| backup.byte_length)
            .sum::<usize>()
            <= MAX_TOTAL_LAYER_BYTES
    );
    assert!(!bob_log.fenced);
    let mut oversized = journal.clone();
    oversized
        .authors
        .iter_mut()
        .find(|author| author.author_id == bob.identity().author_id)
        .unwrap()
        .backups[0]
        .byte_length = annotator_core::collaboration::MAX_LAYER_BYTES;
    assert!(
        matches!(LegacyJournal::parse(&serde_json::to_vec(&oversized).unwrap()), Err(ref error) if error.code == ErrorCode::ResourceLimit),
        "strict journal validation must use the same accumulated budget"
    );
    assert!(!temp
        .0
        .join(format!(
            "maintenance/{operation}/rollback/{}/00000000000000000017.json",
            bob.identity().author_id
        ))
        .exists());
    assert_eq!(fs::read(&alice_path).unwrap(), original_alice);
    assert_eq!(
        fs::read(temp.0.join("collaboration.json")).unwrap(),
        original_entry
    );
    assert_eq!(
        repo.read_author(&alice.identity().author_id)
            .unwrap()
            .unwrap()
            .checkpoint(),
        alice_base
    );
    assert_eq!(
        repo.read_author(&bob.identity().author_id)
            .unwrap()
            .unwrap()
            .checkpoint(),
        bob_base.unwrap()
    );
    assert!(
        !bob_dir.join("00000000000000000001.json").exists(),
        "normal old pruning remains authoritative"
    );
    assert_eq!(
        repo.recover_legacy_upgrade(&operation).unwrap(),
        LegacyRecovery::RollbackPending
    );
    drop(bob);
    drop(alice);
    assert_eq!(
        repo.recover_legacy_upgrade(&operation).unwrap(),
        LegacyRecovery::RolledBack
    );
    assert_eq!(
        repo.read_author(&alice_profile.author_id)
            .unwrap()
            .unwrap()
            .revision,
        1
    );
    assert_eq!(
        repo.read_author(&bob_profile.author_id)
            .unwrap()
            .unwrap()
            .revision,
        17
    );
}
