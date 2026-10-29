use annotator_core::collaboration::{
    profiles::Profile, purge::transaction::PurgeSelection, recycle::RecycleOperation,
    AuthorSession, CollaborationRepository, LayerPayload,
};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
struct Fixture {
    root: PathBuf,
    repo: CollaborationRepository,
    actor: AuthorSession,
    ids: Vec<String>,
    audio: Vec<PathBuf>,
    bytes: Vec<u8>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("purge-cleanup-{}", id()));
        fs::create_dir(&root).unwrap();
        let (repo, actor) = CollaborationRepository::create_default(
            &root,
            "Cleanup",
            &Profile::new("Alice").unwrap(),
        )
        .unwrap();
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let bytes = fs::read(&source).unwrap();
        let mut ids = vec![];
        for _ in 0..2 {
            let p = repo
                .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
                .unwrap();
            ids.push(p.media().id.clone());
            repo.append_media(&actor, &p, &AtomicBool::new(false))
                .unwrap();
        }
        let repo = repo.reload_catalog().unwrap();
        let audio = ids
            .iter()
            .map(|id| {
                root.join(
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
        let mut doc = repo.manifest().base_document().unwrap();
        doc.media.iter_mut().find(|m| m.id == ids[0]).unwrap().note =
            "ERASE OBSOLETE PAYLOAD".into();
        repo.publish(&actor, None, &LayerPayload::from_document(&doc).unwrap())
            .unwrap();
        repo.apply_recycle_controlled(
            &actor,
            repo.read_recycle().unwrap().revision,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![ids[0].clone()],
                trash: true,
            },
            &AtomicBool::new(false),
            || Ok(()),
        )
        .unwrap();
        Self {
            root,
            repo,
            actor,
            ids,
            audio,
            bytes,
        }
    }
    fn commit(&self) -> String {
        let operation = id();
        let p = self
            .repo
            .preview_purge(&self.actor, "runtime", &operation, PurgeSelection::All)
            .unwrap();
        assert!(
            self.repo
                .commit_purge(&self.actor, "runtime", &p, &AtomicBool::new(false))
                .unwrap()
                .committed
        );
        operation
    }
}
#[test]
fn exact_cleanup_unlinks_audio_and_old_payload_but_preserves_duplicates_and_leases() {
    let f = Fixture::new();
    use annotator_core::collaboration::organization::OrganizationOperation;
    let folder = id();
    let org = f
        .repo
        .apply_organization(
            &f.actor,
            f.repo.read_organization().unwrap().revision,
            OrganizationOperation::CreateFolder {
                id: folder.clone(),
                parent_id: None,
                name: "Keep empty directory".into(),
            },
        )
        .unwrap();
    f.repo
        .apply_organization(
            &f.actor,
            org.revision,
            OrganizationOperation::MoveMedia {
                media_id: f.ids[0].clone(),
                folder_id: Some(folder.clone()),
            },
        )
        .unwrap();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    assert!(
        f.audio[0].exists(),
        "logical commit leaves explicit cleanup to native coordinator"
    );
    let result = repo.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(
        !f.audio[0].exists(),
        "retired project audio must actually be unlinked"
    );
    assert!(result.complete);
    assert_eq!(result.deleted_audio_bytes, f.bytes.len() as u64);
    assert_eq!(fs::read(&f.audio[1]).unwrap(), f.bytes);
    let org = repo.read_organization().unwrap();
    assert!(org.folders.iter().any(|node| node.id == folder));
    repo.apply_organization(
        &f.actor,
        org.revision,
        OrganizationOperation::RemoveFolder { id: folder },
    )
    .unwrap();
    assert!(!f
        .root
        .join("catalog")
        .join(format!("{}.json", f.ids[0]))
        .exists());
    assert!(!f
        .root
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000001.json")
        .exists());
    assert!(f
        .root
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join(".writer.lock")
        .exists());
    assert!(f
        .root
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000002.json")
        .exists());
    let again = CollaborationRepository::open(&f.root)
        .unwrap()
        .retry_purge_cleanup(&f.actor, &operation)
        .unwrap();
    assert!(again.complete);
    assert_eq!(again.deleted_audio_bytes, result.deleted_audio_bytes);
}

#[cfg(windows)]
#[test]
fn windows_occupied_audio_is_pending_with_original_error_then_retry_counts_once() {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    let f = Fixture::new();
    let operation = f.commit();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&f.audio[0])
        .unwrap();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let result = repo.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(!result.complete);
    assert_eq!(result.deleted_audio_bytes, 0);
    assert_eq!(result.pending_count, 1);
    assert_eq!(result.failed_count, 1);
    let page = repo.purge_cleanup_page(&operation, 0, 50).unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].media_id, Some(f.ids[0].clone()));
    assert!(
        page.items[0].error.as_ref().unwrap().message.contains("32"),
        "{:?}",
        page.items[0].error
    );
    assert!(f.audio[0].exists());
    let reopened = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(
        reopened
            .purge_cleanup_summary(&operation)
            .unwrap()
            .failed_count,
        1
    );
    drop(held);
    let result = reopened.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(result.complete);
    assert!(!f.audio[0].exists());
    assert_eq!(result.deleted_audio_bytes, f.bytes.len() as u64);
    assert_eq!(
        reopened
            .retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .deleted_audio_bytes,
        result.deleted_audio_bytes
    );
}
#[test]
fn same_bytes_foreign_replacement_is_refused_but_manifest_owned_absence_settles_with_zero_bytes() {
    let f = Fixture::new();
    let operation = f.commit();
    let original = f.root.join("original-retired.wav");
    fs::rename(&f.audio[0], &original).unwrap();
    fs::write(&f.audio[0], &f.bytes).unwrap();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let result = repo.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(!result.complete);
    assert_eq!(result.failed_count, 1);
    assert_eq!(result.deleted_audio_bytes, 0);
    assert_eq!(fs::read(&f.audio[0]).unwrap(), f.bytes);
    fs::remove_file(&f.audio[0]).unwrap();
    let result = repo.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(result.complete);
    assert_eq!(result.deleted_audio_bytes, 0);
    assert!(
        original.exists(),
        "an unlisted path is never chased for matching bytes"
    );
}
#[test]
fn restart_after_successful_unlink_preserves_actual_count_and_does_not_repeat_other_paths() {
    use annotator_core::{collaboration::purge::cleanup::CleanupBoundary, error::AppError};
    let f = Fixture::new();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let mut injected = false;
    let result = repo
        .retry_purge_cleanup_controlled(
            &f.actor,
            &operation,
            1,
            &AtomicBool::new(false),
            |point, _| {
                if point == CleanupBoundary::AfterUnlink && !injected {
                    injected = true;
                    Err(AppError::invalid("lost progress acknowledgement"))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
    assert!(injected);
    assert!(!f.audio[0].exists());
    assert!(!result.complete);
    let result = CollaborationRepository::open(&f.root)
        .unwrap()
        .retry_purge_cleanup(&f.actor, &operation)
        .unwrap();
    assert!(result.complete);
    assert_eq!(
        result.deleted_audio_bytes,
        f.bytes.len() as u64,
        "successful unlink bytes survive the progress interruption"
    );
}
#[test]
fn independent_sources_zip_and_other_project_are_unchanged() {
    let f = Fixture::new();
    let other = Fixture::new();
    let external = std::env::temp_dir().join(format!("purge-external-{}", id()));
    fs::create_dir(&external).unwrap();
    let source = external.join("source.wav");
    let zip = external.join("archive.zip");
    let relink = external.join("private-relink.wav");
    fs::write(&source, &f.bytes).unwrap();
    fs::write(&zip, b"independent ZIP archive").unwrap();
    fs::write(&relink, &f.bytes).unwrap();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    assert!(
        repo.retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete
    );
    assert_eq!(fs::read(&source).unwrap(), f.bytes);
    assert_eq!(fs::read(&relink).unwrap(), f.bytes);
    assert_eq!(fs::read(&zip).unwrap(), b"independent ZIP archive");
    assert_eq!(fs::read(&other.audio[0]).unwrap(), other.bytes);
    assert_eq!(fs::read(&other.audio[1]).unwrap(), other.bytes);
    fs::remove_dir_all(external).unwrap();
}
#[test]
fn manifest_tampering_cannot_grant_traversal_or_live_generation_deletion() {
    let f = Fixture::new();
    let operation = f.commit();
    let dir = f.root.join("maintenance").join(&operation);
    let manifest = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cleanup-")
        })
        .unwrap();
    let mut data: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    data["targets"][0]["path"] = "../../foreign.wav".into();
    fs::write(&manifest, serde_json::to_vec(&data).unwrap()).unwrap();
    assert!(CollaborationRepository::open(&f.root)
        .unwrap()
        .retry_purge_cleanup(&f.actor, &operation)
        .is_err());
    assert!(f.audio[0].exists());
}
#[test]
fn bounded_pass_and_read_only_discovery_do_not_perform_shared_cleanup() {
    let f = Fixture::new();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let before = repo.purge_cleanup_summary(&operation).unwrap();
    assert!(before.pending_count > 2);
    let (_, operations) = CollaborationRepository::open_with_purge_inventory(&f.root).unwrap();
    assert!(operations
        .iter()
        .any(|o| o.operation_id == operation && o.committed));
    assert!(f.audio[0].exists());
    assert!(repo.purge_cleanup_page(&operation, 0, 51).is_err());
    let partial = repo
        .retry_purge_cleanup_controlled(&f.actor, &operation, 1, &AtomicBool::new(false), |_, _| {
            Ok(())
        })
        .unwrap();
    assert_eq!(partial.pending_count, before.pending_count - 1);
    assert_eq!(partial.deleted_audio_bytes, f.bytes.len() as u64);
    assert!(
        repo.recover_purge_maintenance(&f.actor, &operation)
            .unwrap()
            .cleanup
            .unwrap()
            .complete
    );
}

#[test]
fn ambiguous_unlink_before_durable_ack_settles_without_claiming_unproven_bytes() {
    use annotator_core::{collaboration::purge::cleanup::CleanupBoundary, error::AppError};
    let f = Fixture::new();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    repo.retry_purge_cleanup_controlled(
        &f.actor,
        &operation,
        1,
        &AtomicBool::new(false),
        |point, _| {
            if point == CleanupBoundary::AfterUnlinkBeforeProgress {
                Err(AppError::invalid(
                    "crash before durable unlink acknowledgement",
                ))
            } else {
                Ok(())
            }
        },
    )
    .unwrap();
    assert!(!f.audio[0].exists());
    let reopened = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(
        reopened
            .purge_cleanup_summary(&operation)
            .unwrap()
            .deleted_audio_bytes,
        0
    );
    let result = reopened.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(result.complete);
    assert_eq!(result.deleted_audio_bytes, 0);
}
#[cfg(windows)]
#[test]
fn junction_replacement_is_rejected_and_external_audio_remains_intact() {
    let f = Fixture::new();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let media = f.root.join("media");
    let original = f.root.join("original-media");
    fs::rename(&media, &original).unwrap();
    let external = std::env::temp_dir().join(format!("purge-junction-external-{}", id()));
    fs::create_dir(&external).unwrap();
    let name = f.audio[0].file_name().unwrap();
    fs::write(external.join(name), &f.bytes).unwrap();
    let output=std::process::Command::new("pwsh").args(["-NoProfile","-NonInteractive","-Command","New-Item -ItemType Junction -Path $env:TEST_PURGE_LINK -Target $env:TEST_PURGE_TARGET -ErrorAction Stop | Out-Null"]).env("TEST_PURGE_LINK",&media).env("TEST_PURGE_TARGET",&external).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        repo.retry_purge_cleanup(&f.actor, &operation).is_err(),
        "active retained-media authority cannot traverse the substituted junction"
    );
    assert_eq!(fs::read(external.join(name)).unwrap(), f.bytes);
    fs::remove_dir(&media).unwrap();
    fs::rename(&original, &media).unwrap();
    assert!(
        repo.retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete
    );
    fs::remove_dir_all(external).unwrap();
}
#[test]
fn file_identity_is_frozen_before_entry_commit() {
    use annotator_core::collaboration::purge::transaction::PurgeBoundary;
    let f = Fixture::new();
    let operation = id();
    let p = f
        .repo
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let original = f.root.join("captured-original.wav");
    let result = f
        .repo
        .commit_purge_controlled(&f.actor, "runtime", &p, &AtomicBool::new(false), |point| {
            if point == PurgeBoundary::BeforeEntryReplace {
                fs::rename(&f.audio[0], &original).unwrap();
                fs::write(&f.audio[0], &f.bytes).unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert!(result.committed);
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let result = repo.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert_eq!(result.failed_count, 1);
    assert!(!result.complete);
    assert_eq!(fs::read(&f.audio[0]).unwrap(), f.bytes);
    fs::remove_file(&f.audio[0]).unwrap();
    fs::rename(original, &f.audio[0]).unwrap();
    assert!(
        repo.retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete
    );
}
#[test]
fn committed_authority_overrides_preparing_status_and_old_fence_still_collides() {
    use annotator_core::collaboration::atomic;
    let f = Fixture::new();
    let operation = f.commit();
    let journal = f
        .root
        .join("maintenance")
        .join(&operation)
        .join("purge.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    data["status"] = "preparing".into();
    fs::write(&journal, serde_json::to_vec(&data).unwrap()).unwrap();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    assert!(
        repo.recover_purge_maintenance(&f.actor, &operation)
            .unwrap()
            .cleanup
            .unwrap()
            .complete
    );
    let fence = f
        .root
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000002.json");
    let bytes = fs::read(&fence).unwrap();
    assert!(atomic::publish_new(&fence, b"paused old publisher", None, None).is_err());
    assert_eq!(fs::read(&fence).unwrap(), bytes);
    assert_eq!(
        CollaborationRepository::open(&f.root)
            .unwrap()
            .manifest()
            .media
            .len(),
        1
    );
}
#[test]
fn later_generation_survives_removal_of_predecessor_bodies_and_keeps_current_provenance() {
    let f = Fixture::new();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    assert!(
        repo.retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete
    );
    let entry: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join("collaboration.json")).unwrap()).unwrap();
    let old = f
        .root
        .join("state")
        .join(entry["metadataGeneration"].as_str().unwrap());
    repo.apply_recycle_controlled(
        &f.actor,
        repo.read_recycle().unwrap().revision,
        RecycleOperation {
            operation_id: id(),
            media_ids: vec![f.ids[1].clone()],
            trash: true,
        },
        &AtomicBool::new(false),
        || Ok(()),
    )
    .unwrap();
    let next = id();
    let p = repo
        .preview_purge(&f.actor, "runtime", &next, PurgeSelection::All)
        .unwrap();
    repo.commit_purge(&f.actor, "runtime", &p, &AtomicBool::new(false))
        .unwrap();
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert!(
        current
            .retry_purge_cleanup(&f.actor, &next)
            .unwrap()
            .complete
    );
    assert!(!old.join("generation.json").exists());
    assert!(!old
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000001.json")
        .exists());
    assert!(CollaborationRepository::open(&f.root)
        .unwrap()
        .purge_authority(&f.actor)
        .is_ok());
    assert!(current.purge_cleanup_summary(&operation).unwrap().complete);
}

#[test]
fn superseded_attempt_backups_and_owned_orphan_candidate_payloads_are_removed() {
    use annotator_core::{collaboration::purge::transaction::PurgeBoundary, error::AppError};
    let f = Fixture::new();
    let operation = id();
    let p = f
        .repo
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert!(f
        .repo
        .commit_purge_controlled(&f.actor, "runtime", &p, &AtomicBool::new(false), |point| {
            if point == PurgeBoundary::BeforeSync {
                Err(AppError::invalid("crash with candidate files"))
            } else {
                Ok(())
            }
        })
        .is_err());
    let candidates: Vec<_> = fs::read_dir(f.root.join("state"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(candidates.len(), 1);
    let orphan = candidates[0]
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000001.json");
    assert!(orphan.exists());
    let attempt_backups: Vec<_> = fs::read_dir(f.root.join("maintenance"))
        .unwrap()
        .map(|e| {
            e.unwrap()
                .path()
                .join("rollback")
                .join(&f.actor.identity().author_id)
                .join("00000000000000000001.json")
        })
        .filter(|p| p.exists())
        .collect();
    assert_eq!(attempt_backups.len(), 1);
    let p = f
        .repo
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert!(
        f.repo
            .commit_purge(&f.actor, "runtime", &p, &AtomicBool::new(false))
            .unwrap()
            .committed
    );
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert!(
        current
            .retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete
    );
    for backup in attempt_backups {
        assert!(!backup.exists());
    }
    assert!(
        !orphan.exists(),
        "owned failed candidate must not retain obsolete user payload"
    );
}

#[test]
fn old_prune_removing_exact_history_after_capture_does_not_leave_permanent_cleanup_failure() {
    use annotator_core::collaboration::purge::transaction::PurgeBoundary;
    let f = Fixture::new();
    let operation = id();
    let p = f
        .repo
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    let old = f
        .root
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000001.json");
    f.repo
        .commit_purge_controlled(&f.actor, "runtime", &p, &AtomicBool::new(false), |point| {
            if point == PurgeBoundary::BeforeEntryReplace {
                fs::remove_file(&old).unwrap();
            }
            Ok(())
        })
        .unwrap();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let summary = repo.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(summary.complete);
    assert_eq!(summary.deleted_audio_bytes, f.bytes.len() as u64);
}

#[test]
fn precommit_recovery_is_non_destructive_and_reports_rollback_maintenance() {
    use annotator_core::{
        collaboration::purge::{cleanup::MaintenanceStatus, transaction::PurgeBoundary},
        error::AppError,
    };
    let f = Fixture::new();
    let operation = id();
    let p = f
        .repo
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert!(f
        .repo
        .commit_purge_controlled(&f.actor, "runtime", &p, &AtomicBool::new(false), |point| {
            if point == PurgeBoundary::BeforeSync {
                Err(AppError::invalid("precommit failure"))
            } else {
                Ok(())
            }
        })
        .is_err());
    assert!(f.audio[0].exists());
    assert_eq!(
        CollaborationRepository::open(&f.root)
            .unwrap()
            .manifest()
            .format_version,
        5
    );
    let attempts = f.repo.purge_maintenance_operations().unwrap();
    let legacy = attempts.iter().find(|o| o.legacy_attempt).unwrap();
    assert_eq!(legacy.status, MaintenanceStatus::RollbackPending);
    assert!(!legacy.committed);
    assert!(f.repo.retry_purge_cleanup(&f.actor, &operation).is_err());
    assert!(
        f.repo
            .acknowledge_purge_staging_drained(&f.actor, &operation)
            .is_err(),
        "an uncommitted preparation cannot acknowledge destructive cleanup maintenance"
    );
    let settled = f
        .repo
        .recover_purge_maintenance(&f.actor, &legacy.operation_id)
        .unwrap();
    assert_eq!(settled.status, MaintenanceStatus::RolledBack);
    assert!(f.audio[0].exists());
    assert_eq!(fs::read(&f.audio[0]).unwrap(), f.bytes);
}
#[test]
fn normal_media_publication_can_finish_between_cleanup_items() {
    use annotator_core::collaboration::purge::cleanup::CleanupBoundary;
    let f = Fixture::new();
    let operation = f.commit();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    let mut published = false;
    let result = repo
        .retry_purge_cleanup_controlled(
            &f.actor,
            &operation,
            1,
            &AtomicBool::new(false),
            |point, _| {
                if point == CleanupBoundary::BeforeUnlink && !published {
                    let current = CollaborationRepository::open(&f.root).unwrap();
                    let mut doc = current.manifest().base_document().unwrap();
                    doc.media[0].note = "normal concurrent edit".into();
                    let head = current
                        .read_author(&f.actor.identity().author_id)
                        .unwrap()
                        .unwrap()
                        .checkpoint();
                    current
                        .publish(
                            &f.actor,
                            Some(&head),
                            &LayerPayload::from_document(&doc).unwrap(),
                        )
                        .unwrap();
                    published = true;
                }
                Ok(())
            },
        )
        .unwrap();
    assert!(published);
    assert!(!result.complete);
    assert!(
        repo.retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete
    );
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(
        current
            .read_author(&f.actor.identity().author_id)
            .unwrap()
            .unwrap()
            .payload
            .media_labels[0]
            .note,
        "normal concurrent edit"
    );
}
#[test]
fn cleanup_resumes_in_a_fresh_process() {
    if let Some(root) = std::env::var_os("ANNOTATOR_PURGE_CLEANUP_CHILD_ROOT") {
        let repo = CollaborationRepository::open(&PathBuf::from(root)).unwrap();
        let actor = repo
            .adopt(&Profile::new("Recovery worker").unwrap())
            .unwrap();
        let operation = std::env::var("ANNOTATOR_PURGE_CLEANUP_CHILD_OPERATION").unwrap();
        let result = repo.retry_purge_cleanup(&actor, &operation).unwrap();
        assert!(result.complete);
        return;
    }
    let f = Fixture::new();
    let operation = f.commit();
    let partial = CollaborationRepository::open(&f.root)
        .unwrap()
        .retry_purge_cleanup_controlled(&f.actor, &operation, 1, &AtomicBool::new(false), |_, _| {
            Ok(())
        })
        .unwrap();
    assert!(!partial.complete);
    assert_eq!(partial.deleted_audio_bytes, f.bytes.len() as u64);
    // The still-open parent can acknowledge its own retired publication queue;
    // the recovery process cannot acquire that parent's held writer lease.
    f.repo
        .acknowledge_purge_staging_drained(&f.actor, &operation)
        .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "cleanup_resumes_in_a_fresh_process",
            "--nocapture",
        ])
        .env("ANNOTATOR_PURGE_CLEANUP_CHILD_ROOT", &f.root)
        .env("ANNOTATOR_PURGE_CLEANUP_CHILD_OPERATION", &operation)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result = CollaborationRepository::open(&f.root)
        .unwrap()
        .purge_cleanup_summary(&operation)
        .unwrap();
    assert!(result.complete);
    assert_eq!(result.deleted_audio_bytes, f.bytes.len() as u64);
}

#[test]
fn orphan_file_without_durable_identity_is_preserved_as_diagnostic_pending_work() {
    use annotator_core::{collaboration::purge::transaction::PurgeBoundary, error::AppError};
    let f = Fixture::new();
    let operation = id();
    let p = f
        .repo
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    assert!(f
        .repo
        .commit_purge_controlled(&f.actor, "runtime", &p, &AtomicBool::new(false), |point| {
            if point == PurgeBoundary::BeforeSync {
                Err(AppError::invalid("crash"))
            } else {
                Ok(())
            }
        })
        .is_err());
    let maintenance = f.root.join("maintenance").join(&operation);
    let record = fs::read_dir(&maintenance)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("candidate-file-")
        })
        .find(|p| {
            let data: serde_json::Value = serde_json::from_slice(&fs::read(p).unwrap()).unwrap();
            data["kind"] == "history"
        })
        .unwrap();
    let data: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    let orphan = f.root.join(data["path"].as_str().unwrap());
    fs::remove_file(&record).unwrap(); // Simulate loss of durable ownership evidence.
    let p = f
        .repo
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    f.repo
        .commit_purge(&f.actor, "runtime", &p, &AtomicBool::new(false))
        .unwrap();
    let current = CollaborationRepository::open(&f.root).unwrap();
    let result = current.retry_purge_cleanup(&f.actor, &operation).unwrap();
    assert!(!result.complete);
    assert_eq!(result.failed_count, 1);
    assert!(orphan.exists());
    assert!(current
        .purge_cleanup_page(&operation, 0, 50)
        .unwrap()
        .items
        .iter()
        .any(|item| item
            .error
            .as_ref()
            .is_some_and(|e| e.message.contains("durable ownership"))));
    fs::remove_file(orphan).unwrap();
    assert!(
        !current
            .retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete,
        "absence cannot manufacture durable ownership proof"
    );
}

#[test]
fn process_exit_after_staged_payload_keeps_prior_identity_and_later_purge_removes_it() {
    use annotator_core::collaboration::purge::transaction::PurgeBoundary;
    if let Some(root) = std::env::var_os("ANNOTATOR_PURGE_STAGE_CHILD_ROOT") {
        let repo = CollaborationRepository::open(&PathBuf::from(root)).unwrap();
        let actor = repo
            .adopt(&Profile::new("Interrupted publisher").unwrap())
            .unwrap();
        let operation = std::env::var("ANNOTATOR_PURGE_STAGE_CHILD_OPERATION").unwrap();
        let target = std::env::var("ANNOTATOR_PURGE_STAGE_CHILD_TARGET").unwrap();
        let p = repo
            .preview_purge(
                &actor,
                "child",
                &operation,
                PurgeSelection::Selected(vec![target]),
            )
            .unwrap();
        repo.commit_purge_guarded_controlled(&actor,"child",&p,&AtomicBool::new(false),|point|{
            let phase=std::env::var("ANNOTATOR_PURGE_STAGE_CHILD_PHASE").unwrap();
            if (phase=="partial" && point==PurgeBoundary::AfterCandidatePartialWrite) || (phase=="staged" && point==PurgeBoundary::AfterCandidateStaged) || (phase=="published" && point==PurgeBoundary::AfterCandidatePublication) {std::process::exit(73);} Ok(())
        },|point|{ if std::env::var("ANNOTATOR_PURGE_STAGE_CHILD_PHASE").unwrap()=="legacy-backup" && matches!(point,annotator_core::collaboration::purge::legacy::LegacyBoundary::AfterBackupStaged{..}) {std::process::exit(73);} Ok(())},||Ok(())).unwrap();
        panic!("staging crash boundary did not run");
    }
    for phase in ["partial", "staged", "published", "legacy-backup"] {
        let f = Fixture::new();
        f.repo
            .apply_recycle_controlled(
                &f.actor,
                f.repo.read_recycle().unwrap().revision,
                RecycleOperation {
                    operation_id: id(),
                    media_ids: vec![f.ids[1].clone()],
                    trash: true,
                },
                &AtomicBool::new(false),
                || Ok(()),
            )
            .unwrap();
        let operation = id();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_exit_after_staged_payload_keeps_prior_identity_and_later_purge_removes_it",
                "--nocapture",
            ])
            .env("ANNOTATOR_PURGE_STAGE_CHILD_ROOT", &f.root)
            .env("ANNOTATOR_PURGE_STAGE_CHILD_OPERATION", &operation)
            .env("ANNOTATOR_PURGE_STAGE_CHILD_TARGET", &f.ids[1])
            .env("ANNOTATOR_PURGE_STAGE_CHILD_PHASE", phase)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(73),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let dir = f.root.join("maintenance").join(&operation);
        let attempt = if phase == "legacy-backup" {
            fs::read_dir(f.root.join("maintenance"))
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| p.join("legacy.json").exists())
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        } else {
            let journal: serde_json::Value =
                serde_json::from_slice(&fs::read(dir.join("purge.json")).unwrap()).unwrap();
            journal["receipt"]["legacyPreparationId"]
                .as_str()
                .unwrap()
                .to_string()
        };
        f.repo
            .recover_legacy_upgrade_drained(&attempt, &f.actor)
            .unwrap();
        let record_dir = if phase == "legacy-backup" {
            f.root.join("maintenance").join(&attempt)
        } else {
            dir
        };
        let record = fs::read_dir(&record_dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(if phase == "legacy-backup" {
                        "legacy-file-"
                    } else {
                        "candidate-file-"
                    })
            })
            .unwrap();
        let data: serde_json::Value = serde_json::from_slice(&fs::read(record).unwrap()).unwrap();
        let staged = f.root.join(
            data[if phase == "published" {
                "path"
            } else {
                "stagedPath"
            }]
            .as_str()
            .unwrap(),
        );
        assert!(staged.exists());
        let payload = fs::read(&staged).unwrap();
        assert!(!payload.is_empty());
        if phase != "partial" {
            assert!(String::from_utf8(payload)
                .unwrap()
                .contains("ERASE OBSOLETE PAYLOAD"));
        }
        let original = f.root.join("held-original-candidate-payload");
        if phase == "staged" {
            fs::rename(&staged, &original).unwrap();
            let bytes = fs::read(&original).unwrap();
            fs::write(&staged, bytes).unwrap();
        }
        let winning = f.commit();
        let current = CollaborationRepository::open(&f.root).unwrap();
        let result = current.retry_purge_cleanup(&f.actor, &winning).unwrap();
        if phase == "staged" {
            assert!(!result.complete);
            assert_eq!(result.failed_count, 1);
            assert!(
                staged.exists(),
                "same-byte foreign staging substitution is preserved"
            );
            fs::remove_file(&staged).unwrap();
            fs::rename(original, &staged).unwrap();
            assert!(
                current
                    .retry_purge_cleanup(&f.actor, &winning)
                    .unwrap()
                    .complete
            );
        } else {
            assert!(result.complete);
        }
        assert!(!staged.exists(),"payload-bearing staging file must have exact durable cleanup ownership before it was written");
    }
}

#[cfg(windows)]
#[test]
fn later_purge_waits_for_earlier_occupied_history_and_backup_of_its_media() {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    let f = Fixture::new();
    let mut doc = f.repo.manifest().base_document().unwrap();
    doc.media
        .iter_mut()
        .find(|m| m.id == f.ids[1])
        .unwrap()
        .note = "B survives the first purge but must disappear after its own purge".into();
    let head = f
        .repo
        .read_author(&f.actor.identity().author_id)
        .unwrap()
        .unwrap()
        .checkpoint();
    f.repo
        .publish(
            &f.actor,
            Some(&head),
            &LayerPayload::from_document(&doc).unwrap(),
        )
        .unwrap();
    let history = f
        .root
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000002.json");
    assert!(String::from_utf8(fs::read(&history).unwrap())
        .unwrap()
        .contains("B survives"));
    let a = f.commit();
    let a_journal: serde_json::Value = serde_json::from_slice(
        &fs::read(f.root.join("maintenance").join(&a).join("purge.json")).unwrap(),
    )
    .unwrap();
    let backup = f
        .root
        .join("maintenance")
        .join(
            a_journal["receipt"]["legacyPreparationId"]
                .as_str()
                .unwrap(),
        )
        .join("rollback")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000002.json");
    let held_history = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&history)
        .unwrap();
    let held_backup = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&backup)
        .unwrap();
    let g1 = CollaborationRepository::open(&f.root).unwrap();
    let first = g1.retry_purge_cleanup(&f.actor, &a).unwrap();
    assert!(!first.complete);
    assert_eq!(first.pending_count, 2);
    assert_eq!(first.deleted_audio_bytes, f.bytes.len() as u64);
    let original_ids: Vec<_> = g1
        .purge_cleanup_page(&a, 0, 50)
        .unwrap()
        .items
        .into_iter()
        .map(|i| i.cleanup_id)
        .collect();
    g1.apply_recycle_controlled(
        &f.actor,
        g1.read_recycle().unwrap().revision,
        RecycleOperation {
            operation_id: id(),
            media_ids: vec![f.ids[1].clone()],
            trash: true,
        },
        &AtomicBool::new(false),
        || Ok(()),
    )
    .unwrap();
    let b = id();
    let p = g1
        .preview_purge(&f.actor, "runtime", &b, PurgeSelection::All)
        .unwrap();
    g1.commit_purge(&f.actor, "runtime", &p, &AtomicBool::new(false))
        .unwrap();
    let g2 = CollaborationRepository::open(&f.root).unwrap();
    let second = g2.retry_purge_cleanup(&f.actor, &b).unwrap();
    assert!(
        !second.complete,
        "B cannot be physically complete while earlier receipt-bound bodies still contain B"
    );
    assert_eq!(second.pending_count, 2);
    assert_eq!(second.failed_count, 2);
    assert_eq!(
        second.deleted_audio_bytes,
        f.bytes.len() as u64,
        "B never includes A's audio count"
    );
    let page = g2.purge_cleanup_page(&b, 0, 50).unwrap();
    assert_eq!(page.total, 2);
    assert!(page
        .items
        .iter()
        .all(|item| original_ids.contains(&item.cleanup_id)
            && item
                .error
                .as_ref()
                .is_some_and(|e| e.message.contains("32"))));
    assert!(history.exists());
    assert!(backup.exists());
    drop(held_history);
    drop(held_backup);
    let resumed = CollaborationRepository::open(&f.root)
        .unwrap()
        .retry_purge_cleanup(&f.actor, &b)
        .unwrap();
    assert!(resumed.complete);
    assert!(!history.exists());
    assert!(!backup.exists());
    assert_eq!(resumed.deleted_audio_bytes, f.bytes.len() as u64);
    assert_eq!(g2.purge_cleanup_page(&b, 0, 50).unwrap().total, 0);
    let earlier = g2.retry_purge_cleanup(&f.actor, &a).unwrap();
    assert!(earlier.complete);
    assert_eq!(earlier.deleted_audio_bytes, f.bytes.len() as u64);
}

#[cfg(windows)]
fn publish_historical_b(f: &Fixture) -> PathBuf {
    let mut doc = f.repo.manifest().base_document().unwrap();
    doc.media
        .iter_mut()
        .find(|m| m.id == f.ids[1])
        .unwrap()
        .note = "Earlier B user body".into();
    let head = f
        .repo
        .read_author(&f.actor.identity().author_id)
        .unwrap()
        .unwrap()
        .checkpoint();
    f.repo
        .publish(
            &f.actor,
            Some(&head),
            &LayerPayload::from_document(&doc).unwrap(),
        )
        .unwrap();
    f.root
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000002.json")
}
fn purge_b(f: &Fixture) -> String {
    let current = CollaborationRepository::open(&f.root).unwrap();
    current
        .apply_recycle_controlled(
            &f.actor,
            current.read_recycle().unwrap().revision,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![f.ids[1].clone()],
                trash: true,
            },
            &AtomicBool::new(false),
            || Ok(()),
        )
        .unwrap();
    let operation = id();
    let p = current
        .preview_purge(&f.actor, "runtime", &operation, PurgeSelection::All)
        .unwrap();
    current
        .commit_purge(&f.actor, "runtime", &p, &AtomicBool::new(false))
        .unwrap();
    operation
}
#[cfg(windows)]
#[test]
fn inherited_metadata_uses_original_identity_and_never_expands_earlier_audio_targets_or_counts() {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    let f = Fixture::new();
    let history = publish_historical_b(&f);
    let a = f.commit();
    let held_history = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&history)
        .unwrap();
    let held_audio = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&f.audio[0])
        .unwrap();
    let g1 = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(
        g1.retry_purge_cleanup(&f.actor, &a).unwrap().pending_count,
        2
    );
    let manifest = fs::read_dir(f.root.join("maintenance").join(&a))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cleanup-")
        })
        .unwrap();
    let manifest_before = fs::read(&manifest).unwrap();
    drop(held_history);
    let original = f.root.join("held-earlier-original-history");
    fs::rename(&history, &original).unwrap();
    let bytes = fs::read(&original).unwrap();
    fs::write(&history, &bytes).unwrap();
    let b = purge_b(&f);
    let g2 = CollaborationRepository::open(&f.root).unwrap();
    let result = g2.retry_purge_cleanup(&f.actor, &b).unwrap();
    assert!(!result.complete);
    assert_eq!(result.pending_count, 1);
    assert_eq!(result.deleted_audio_bytes, f.bytes.len() as u64);
    assert!(f.audio[0].exists());
    assert_eq!(fs::read(&history).unwrap(), bytes);
    let page = g2.purge_cleanup_page(&b, 0, 50).unwrap();
    assert_eq!(page.items[0].source_operation_id, a);
    assert!(page.items[0]
        .error
        .as_ref()
        .unwrap()
        .message
        .contains("replaced"));
    fs::remove_file(&history).unwrap();
    fs::rename(&original, &history).unwrap();
    assert!(g2.retry_purge_cleanup(&f.actor, &b).unwrap().complete);
    assert!(!history.exists());
    assert_eq!(g2.purge_cleanup_summary(&a).unwrap().pending_count, 1);
    assert_eq!(g2.purge_cleanup_summary(&a).unwrap().deleted_audio_bytes, 0);
    assert_eq!(
        g2.retry_purge_cleanup(&f.actor, &b)
            .unwrap()
            .deleted_audio_bytes,
        f.bytes.len() as u64
    );
    assert_eq!(
        fs::read(&manifest).unwrap(),
        manifest_before,
        "original receipt-bound manifest is never rewritten"
    );
    drop(held_audio);
    let earlier = g2.retry_purge_cleanup(&f.actor, &a).unwrap();
    assert!(earlier.complete);
    assert_eq!(earlier.deleted_audio_bytes, f.bytes.len() as u64);
}
#[cfg(windows)]
#[test]
fn original_cleanup_can_complete_shared_metadata_while_later_cleanup_is_between_items() {
    use annotator_core::collaboration::purge::cleanup::CleanupBoundary;
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    let f = Fixture::new();
    let history = publish_historical_b(&f);
    let a = f.commit();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&history)
        .unwrap();
    let g1 = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(
        g1.retry_purge_cleanup(&f.actor, &a).unwrap().pending_count,
        1
    );
    let b = purge_b(&f);
    drop(held);
    let g2 = CollaborationRepository::open(&f.root).unwrap();
    let mut completed_original = false;
    let result = g2
        .retry_purge_cleanup_controlled(
            &f.actor,
            &b,
            usize::MAX,
            &AtomicBool::new(false),
            |point, _| {
                if point == CleanupBoundary::BeforeUnlink && !completed_original {
                    assert!(g2.retry_purge_cleanup(&f.actor, &a).unwrap().complete);
                    completed_original = true;
                }
                Ok(())
            },
        )
        .unwrap();
    assert!(completed_original);
    assert!(result.complete);
    assert!(!history.exists());
    assert_eq!(result.deleted_audio_bytes, f.bytes.len() as u64);
    assert_eq!(g2.purge_cleanup_page(&b, 0, 50).unwrap().total, 0);
}

#[test]
fn paused_old_publisher_staging_after_commit_cannot_leave_payload_behind_complete() {
    use annotator_core::{collaboration::LegacyPublishBoundary, error::ErrorCode};
    use std::time::{Duration, Instant};
    if let Some(root) = std::env::var_os("ANNOTATOR_OLD_STAGE_ROOT") {
        let mode = std::env::var("ANNOTATOR_OLD_STAGE_MODE").unwrap();
        let root = PathBuf::from(root);
        let repo = CollaborationRepository::open(&root).unwrap();
        let actor = repo
            .adopt(&Profile::new("Frozen old worker").unwrap())
            .unwrap();
        let media = std::env::var("ANNOTATOR_OLD_STAGE_MEDIA").unwrap();
        let mut doc = repo.manifest().base_document().unwrap();
        doc.media.iter_mut().find(|m| m.id == media).unwrap().note =
            "OLD LATE STAGED USER PAYLOAD".into();
        let result = repo.publish_legacy_interleaved(
            &actor,
            None,
            &LayerPayload::from_document(&doc).unwrap(),
            |point| {
                if (point == LegacyPublishBoundary::BeforeNoReplace
                    && mode != "precommit-collision")
                    || (point == LegacyPublishBoundary::AfterStagingSync
                        && mode == "precommit-collision")
                {
                    fs::write(
                        root.join("old-stage-ready"),
                        actor.identity().author_id.as_bytes(),
                    )
                    .unwrap();
                    let deadline = Instant::now() + Duration::from_secs(30);
                    while !root.join("old-stage-go").exists() {
                        assert!(Instant::now() < deadline);
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                if point == LegacyPublishBoundary::AfterStagingSync && mode == "late-crash" {
                    std::process::exit(73);
                }
                Ok(())
            },
        );
        assert_eq!(
            result.unwrap_err().code,
            ErrorCode::RevisionConflict,
            "old no_replace still collides with permanent fence"
        );
        return;
    }
    for mode in ["late-crash", "late-collision", "precommit-collision"] {
        let f = Fixture::new();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "paused_old_publisher_staging_after_commit_cannot_leave_payload_behind_complete",
                "--nocapture",
            ])
            .env("ANNOTATOR_OLD_STAGE_ROOT", &f.root)
            .env("ANNOTATOR_OLD_STAGE_MEDIA", &f.ids[0])
            .env("ANNOTATOR_OLD_STAGE_MODE", mode)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !f.root.join("old-stage-ready").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let old_author = fs::read_to_string(f.root.join("old-stage-ready")).unwrap();
        let operation = f.commit();
        let current = CollaborationRepository::open(&f.root).unwrap();
        let before = current.retry_purge_cleanup(&f.actor, &operation).unwrap();
        assert!(
            !before.complete,
            "a paused old writer has not provided staging retirement proof"
        );
        fs::write(
            f.root.join("old-stage-go"),
            b"resume old generic staging after entry switch",
        )
        .unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(if mode == "late-crash" { 73 } else { 0 }),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let staged = fs::read_dir(f.root.join("annotations").join(&old_author))
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.file_name().unwrap().to_string_lossy().ends_with(".tmp"));
        let fence = f
            .root
            .join("annotations")
            .join(&old_author)
            .join("00000000000000000001.json");
        assert!(fence.exists(), "permanent numeric fence remains");
        let fence_bytes = fs::read(&fence).unwrap();
        let after = CollaborationRepository::open(&f.root)
            .unwrap()
            .retry_purge_cleanup(&f.actor, &operation)
            .unwrap();
        if mode == "late-crash" {
            let staged = staged.unwrap();
            let bytes = fs::read(&staged).unwrap();
            assert!(String::from_utf8(bytes.clone())
                .unwrap()
                .contains("OLD LATE STAGED USER PAYLOAD"));
            assert!(!after.complete);
            assert_eq!(after.failed_count, 1);
            let page = current.purge_cleanup_page(&operation, 0, 50).unwrap();
            assert_eq!(page.total, 1);
            assert!(page.items[0]
                .error
                .as_ref()
                .unwrap()
                .message
                .contains("Unowned legacy staging"));
            assert_eq!(
                fs::read(&staged).unwrap(),
                bytes,
                "unknown file is never deleted or rebound from its current bytes"
            );
            fs::remove_file(staged).unwrap(); // only this test's creator removes its own unowned fixture
            assert!(
                current
                    .retry_purge_cleanup(&f.actor, &operation)
                    .unwrap()
                    .complete,
                "absent staging plus exact retirement proof completes observation"
            );
        } else {
            assert!(
                staged.is_none(),
                "normal old collision self-cleans its exact staging object"
            );
            assert!(after.complete);
        }
        assert_eq!(
            current
                .purge_cleanup_summary(&operation)
                .unwrap()
                .deleted_audio_bytes,
            f.bytes.len() as u64,
            "unproven staging absence adds no bytes"
        );
        assert_eq!(fs::read(&fence).unwrap(), fence_bytes);
    }
}

#[test]
fn a_live_new_client_acknowledges_exact_legacy_staging_scope_without_closing() {
    let f = Fixture::new();
    let bob = f.repo.adopt(&Profile::new("Live Bob").unwrap()).unwrap();
    let a = f.commit();
    let current = CollaborationRepository::open(&f.root).unwrap();
    let pending = current.retry_purge_cleanup(&f.actor, &a).unwrap();
    assert!(!pending.complete);
    assert_eq!(pending.pending_count, 1);
    assert_eq!(pending.failed_count, 1);
    let dir = f.root.join("maintenance").join(&a);
    let snapshot = || {
        let mut files: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .map(|p| (p.file_name().unwrap().to_os_string(), fs::read(p).unwrap()))
            .collect();
        files.sort();
        files
    };
    let before = snapshot();
    current.purge_cleanup_summary(&a).unwrap();
    current.purge_cleanup_page(&a, 0, 50).unwrap();
    CollaborationRepository::open_with_purge_inventory(&f.root).unwrap();
    assert_eq!(
        snapshot(),
        before,
        "read-only observation never writes retirement acknowledgements"
    );
    let b = purge_b(&f);
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert!(!current.retry_purge_cleanup(&f.actor, &b).unwrap().complete);
    let acknowledged = current.acknowledge_purge_staging_drained(&bob, &b).unwrap();
    assert!(acknowledged.complete,"the inherited exact source/lease-bound own queue acknowledgement must complete its observer");
    assert!(current.purge_cleanup_summary(&a).unwrap().complete);
    // Holding Bob's live session throughout is intentional; no session closure is required.
    assert_eq!(bob.identity().display_name, "Live Bob");
}

#[test]
fn own_staging_acknowledgement_waits_for_the_actual_local_publication_gate() {
    use annotator_core::{collaboration::LegacyPublishBoundary, error::ErrorCode};
    use std::sync::mpsc::channel;
    let f = Fixture::new();
    let head = f
        .repo
        .read_author(&f.actor.identity().author_id)
        .unwrap()
        .unwrap()
        .checkpoint();
    let payload = LayerPayload::from_document(&f.repo.manifest().base_document().unwrap()).unwrap();
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = channel();
        let (go_tx, go_rx) = channel();
        let f_ref = &f;
        let worker = scope.spawn(move || {
            f_ref
                .repo
                .publish_legacy_interleaved(&f_ref.actor, Some(&head), &payload, |point| {
                    if point == LegacyPublishBoundary::BeforeNoReplace {
                        ready_tx.send(()).unwrap();
                        go_rx.recv().unwrap();
                    }
                    Ok(())
                })
        });
        ready_rx.recv().unwrap();
        let operation = f.commit();
        let current = CollaborationRepository::open(&f.root).unwrap();
        let pending = current.retry_purge_cleanup(&f.actor, &operation).unwrap();
        assert!(!pending.complete);
        assert_eq!(pending.pending_count, 1);
        let pending = current
            .acknowledge_purge_staging_drained(&f.actor, &operation)
            .unwrap();
        assert!(
            !pending.complete,
            "a held live lease alone does not prove its own worker drained"
        );
        go_tx.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        assert!(
            current
                .acknowledge_purge_staging_drained(&f.actor, &operation)
                .unwrap()
                .complete
        );
    });
}
#[test]
fn staging_acknowledgement_is_bound_to_exact_source_and_permanent_fence() {
    let f = Fixture::new();
    let bob = f
        .repo
        .adopt(&Profile::new("Bob source proof").unwrap())
        .unwrap();
    let operation = f.commit();
    let current = CollaborationRepository::open(&f.root).unwrap();
    assert!(
        !current
            .retry_purge_cleanup(&f.actor, &operation)
            .unwrap()
            .complete
    );
    let fence = f
        .root
        .join("annotations")
        .join(&bob.identity().author_id)
        .join("00000000000000000001.json");
    let fence_bytes = fs::read(&fence).unwrap();
    let mut changed = fence_bytes.clone();
    changed.push(b' ');
    fs::write(&fence, changed).unwrap();
    assert!(
        !current
            .acknowledge_purge_staging_drained(&bob, &operation)
            .unwrap()
            .complete
    );
    assert!(
        current.purge_cleanup_page(&operation, 0, 50).unwrap().items[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("collision fence changed")
    );
    fs::write(&fence, &fence_bytes).unwrap();
    let visible: serde_json::Value = serde_json::from_slice(
        &fs::read(
            f.root
                .join("maintenance")
                .join(&operation)
                .join("purge.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let journal = f
        .root
        .join("maintenance")
        .join(visible["receipt"]["legacyPreparationId"].as_str().unwrap())
        .join("legacy.json");
    let original = fs::read(&journal).unwrap();
    let mut changed: serde_json::Value = serde_json::from_slice(&original).unwrap();
    changed["sourceEntryHash"] = "b".repeat(64).into();
    fs::write(&journal, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(
        !current
            .acknowledge_purge_staging_drained(&bob, &operation)
            .unwrap()
            .complete
    );
    assert!(
        current.purge_cleanup_page(&operation, 0, 50).unwrap().items[0]
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("ownership changed")
    );
    fs::write(&journal, original).unwrap();
    assert!(
        current
            .acknowledge_purge_staging_drained(&bob, &operation)
            .unwrap()
            .complete
    );
    assert_eq!(fs::read(&fence).unwrap(), fence_bytes);
}
