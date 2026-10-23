use annotator_core::{collaboration::*, model::*, project::LocalProject};
use std::{fs, path::PathBuf, sync::Arc};

struct Fixture {
    root: PathBuf,
    local: PathBuf,
    repo: Arc<CollaborationRepository>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("workspace-test-{}", uuid::Uuid::new_v4()));
        let local = root.with_extension("local");
        for dir in [
            &root,
            &local,
            &root.join("media"),
            &root.join("accounts"),
            &root.join("annotations"),
        ] {
            fs::create_dir(dir).unwrap();
        }
        let doc = fixture_document();
        let media = doc
            .media
            .iter()
            .map(|m| PublicMedia {
                id: m.id.clone(),
                display_name: m.display_name.clone(),
                source_ref: format!("media/{}.wav", m.id),
                sha256: m.sha256.clone(),
                byte_length: m.byte_length,
                sample_rate: m.sample_rate,
                frame_count: m.frame_count,
                channel_count: m.channel_count,
                channel_layout: m.channel_layout.clone(),
            })
            .collect();
        let manifest = CollaborationManifest {
            kind: MANIFEST_KIND.into(),
            format_version: 1,
            project_id: doc.project_id,
            name: doc.name,
            created_at: doc.created_at,
            media,
        };
        for m in &manifest.media {
            fs::write(root.join(&m.source_ref), b"fixture").unwrap();
        }
        fs::write(
            root.join("collaboration.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let repo = Arc::new(CollaborationRepository::open(&root).unwrap());
        Self { root, local, repo }
    }
    fn actor(&self, name: &str) -> Arc<AuthorSession> {
        self.repo.register(name, name, "test-password").unwrap();
        Arc::new(self.repo.login(name, "test-password").unwrap())
    }
    fn open(&self, actor: Option<Arc<AuthorSession>>) -> LocalProject {
        LocalProject::open_shared(self.repo.clone(), actor, &self.local).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.local);
    }
}
fn fixture_document() -> ProjectDocument {
    ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v2.json")).unwrap()
}
fn change(p: &mut LocalProject, c: Change) {
    let d = p.snapshot().unwrap().document;
    p.apply_change(&d.project_id, d.revision, c).unwrap();
}
fn save(p: &mut LocalProject) {
    let d = p.snapshot().unwrap().document;
    p.save(&d.project_id, d.revision).unwrap();
}

#[test]
fn private_actor_caches_are_isolated_and_locked() {
    let f = Fixture::new();
    let a = f.actor("a");
    let b = f.actor("b");
    let mut pa = f.open(Some(a.clone()));
    let pb = f.open(Some(b));
    let pg = f.open(None);
    assert_ne!(pa.storage_root(), pb.storage_root());
    assert_ne!(pa.storage_root(), pg.storage_root());
    assert_eq!(pa.root(), f.repo.root());
    assert!(pa
        .storage_root()
        .starts_with(f.local.canonicalize().unwrap()));
    assert!(LocalProject::open_shared(f.repo.clone(), Some(a.clone()), &f.local).is_err());
    change(
        &mut pa,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut pa);
    assert!(pb.snapshot().unwrap().document.annotations.is_empty());
    assert!(pg.snapshot().unwrap().document.annotations.is_empty());
    let preferences = PlaybackPreferences {
        volume: 0.25,
        device_id: Some("author-a-device".into()),
        loop_enabled: true,
        source: WorkspaceSource::Original,
    };
    pa.workspace_mut()
        .unwrap()
        .save_preferences(preferences.clone())
        .unwrap();
    assert_eq!(
        pb.workspace().unwrap().preferences(),
        &PlaybackPreferences::default()
    );
    assert_eq!(
        pg.workspace().unwrap().preferences(),
        &PlaybackPreferences::default()
    );
    drop(pa);
    let pa = f.open(Some(a));
    assert_eq!(pa.snapshot().unwrap().document.annotations.len(), 1);
    assert_eq!(pa.workspace().unwrap().preferences(), &preferences);
    assert!(!f.root.join(".project.lock").exists());
    assert!(!f.root.join("workspace.json").exists());
}

fn annotation() -> Annotation {
    let mut a = fixture_document().annotations[0].clone();
    a.category_id = None;
    a
}

#[test]
fn publication_a_in_flight_preserves_saved_b_and_private_state_across_restart() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let author = actor.identity().author_id.clone();
    let mut p = f.open(Some(actor.clone()));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .expect("Saved annotation must be pending");
    let (start, wait) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        wait.recv().unwrap();
        job.publish().unwrap()
    });
    let id = annotation().id;
    change(
        &mut p,
        Change::UpdateAnnotationNote {
            id,
            note: "B latest".into(),
            merge_key: None,
        },
    );
    change(
        &mut p,
        Change::AddEdit {
            edit: fixture_document().edits[0].clone(),
        },
    );
    save(&mut p);
    let prefs = PlaybackPreferences {
        volume: 0.2,
        device_id: Some("local-speaker".into()),
        loop_enabled: true,
        source: WorkspaceSource::Original,
    };
    p.workspace_mut()
        .unwrap()
        .save_preferences(prefs.clone())
        .unwrap();
    let latest = p.snapshot().unwrap().document;
    start.send(()).unwrap();
    let ack = worker.join().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert_eq!(p.workspace().unwrap().envelope().document, latest);
    assert!(p.workspace().unwrap().envelope().pending.is_some());
    drop(p);
    let mut p = f.open(Some(actor));
    assert_eq!(p.snapshot().unwrap().document, latest);
    assert_eq!(p.workspace().unwrap().preferences(), &prefs);
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let ack = job.publish().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert!(p.workspace().unwrap().envelope().pending.is_none());
    let remote = f.repo.read_author(&author).unwrap().unwrap();
    assert_eq!(remote.revision, 2);
    assert_eq!(remote.payload.annotations[0].note, "B latest");
    let bytes = serde_json::to_string(&remote).unwrap();
    assert!(!bytes.contains("local-speaker"));
    assert!(!bytes.contains("edits"));
}

#[test]
fn guest_copy_is_explicit_remapped_atomic_and_undoable() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor));
    let mut guest = f.open(None);
    let source = fixture_document();
    for category in &source.categories {
        change(
            &mut guest,
            Change::AddCategory {
                category: category.clone(),
            },
        );
    }
    change(
        &mut guest,
        Change::AddAnnotation {
            annotation: source.annotations[0].clone(),
        },
    );
    change(
        &mut guest,
        Change::AddEdit {
            edit: source.edits[0].clone(),
        },
    );
    save(&mut guest);
    let payload = LayerPayload::from_document(&guest.snapshot().unwrap().document).unwrap();
    let d = p.snapshot().unwrap().document;
    p.publish_guest(&d.project_id, d.revision, &payload)
        .unwrap();
    let copied = p.snapshot().unwrap().document;
    assert_eq!(copied.annotations.len(), 1);
    assert!(copied.edits.is_empty());
    assert_ne!(copied.annotations[0].id, source.annotations[0].id);
    assert_ne!(copied.categories[0].id, source.categories[0].id);
    assert_eq!(
        copied.annotations[0].category_id,
        Some(copied.categories[0].id.clone())
    );
    p.undo(&copied.project_id, copied.revision).unwrap();
    assert!(p.snapshot().unwrap().document.annotations.is_empty());
    let media = p.snapshot().unwrap().document.media[0].id.clone();
    change(
        &mut p,
        Change::UpdateMediaNote {
            media_id: media.clone(),
            note: "owner".into(),
            merge_key: None,
        },
    );
    change(
        &mut guest,
        Change::UpdateMediaNote {
            media_id: media,
            note: "guest".into(),
            merge_key: None,
        },
    );
    let before = p.snapshot().unwrap();
    let g = LayerPayload::from_document(&guest.snapshot().unwrap().document).unwrap();
    assert!(p
        .publish_guest(&before.document.project_id, before.document.revision, &g)
        .is_err());
    assert_eq!(p.snapshot().unwrap(), before);
}

#[test]
fn foreign_refresh_keeps_last_verified_layers_on_corrupt_missing_and_regressed_heads() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let id = actor.identity().author_id.clone();
    let payload = LayerPayload::from_document(&fixture_document()).unwrap();
    let first = f.repo.publish(&actor, None, &payload).unwrap();
    let mut remembered = RememberedLayers::new(f.repo.manifest().clone());
    let old = f.repo.snapshot().unwrap();
    remembered.update(old.clone()).unwrap();
    let mut changed = payload.clone();
    changed.annotations.clear();
    f.repo.publish(&actor, Some(&first), &changed).unwrap();
    remembered.update(f.repo.snapshot().unwrap()).unwrap();
    let latest = remembered.snapshot().authors[0].layer.clone();
    remembered.update(old).unwrap();
    assert_eq!(remembered.snapshot().authors[0].layer, latest);
    assert!(remembered.snapshot().authors[0].error.is_some());
    fs::write(
        f.root
            .join(format!("annotations/{id}/00000000000000000002.json")),
        b"corrupt",
    )
    .unwrap();
    remembered.update(f.repo.snapshot().unwrap()).unwrap();
    assert_eq!(remembered.snapshot().authors[0].layer, latest);
    remembered
        .update(CollaborationSnapshot {
            project_id: f.repo.manifest().project_id.clone(),
            authors: vec![],
        })
        .unwrap();
    assert_eq!(remembered.snapshot().authors[0].layer, latest);
    assert!(remembered.snapshot().authors[0].error.is_some());
}

#[test]
fn private_only_changes_and_same_payload_in_flight_never_create_extra_revision() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let author = actor.identity().author_id.clone();
    let mut p = f.open(Some(actor.clone()));
    change(
        &mut p,
        Change::AddEdit {
            edit: fixture_document().edits[0].clone(),
        },
    );
    save(&mut p);
    assert!(p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .is_none());
    assert!(f.repo.read_author(&author).unwrap().is_none());
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let mut view = p.snapshot().unwrap().document.view_state;
    view.linked_time = true;
    change(&mut p, Change::UpdateViewState { view_state: view });
    save(&mut p);
    let latest = p.snapshot().unwrap().document;
    let ack = job.publish().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert_eq!(p.workspace().unwrap().envelope().document, latest);
    assert!(p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .is_none());
    drop(p);
    let p = f.open(Some(actor));
    assert_eq!(p.snapshot().unwrap().document, latest);
    assert_eq!(f.repo.read_author(&author).unwrap().unwrap().revision, 1);
}

#[test]
fn lost_ack_with_newer_saved_b_restarts_and_reconciles_a_without_duplicate_revision() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let author = actor.identity().author_id.clone();
    let mut p = f.open(Some(actor.clone()));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    change(
        &mut p,
        Change::UpdateAnnotationNote {
            id: annotation().id,
            note: "B survives lost ack".into(),
            merge_key: None,
        },
    );
    save(&mut p);
    assert!(job
        .publish_controlled(Some(atomic::PublishFault::AfterPublish))
        .is_err());
    drop(p);
    let mut p = f.open(Some(actor));
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
    assert_eq!(
        p.snapshot().unwrap().document.annotations[0].note,
        "B survives lost ack"
    );
    let ack = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap()
        .publish()
        .unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert_eq!(f.repo.read_author(&author).unwrap().unwrap().revision, 2);
}

#[test]
fn admitted_worker_keeps_author_lease_and_stale_ack_cannot_touch_reopened_cache() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor.clone()));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    drop(p);
    drop(actor);
    assert!(f.repo.login("a", "test-password").is_err());
    let ack = job.publish().unwrap();
    let actor = Arc::new(f.repo.login("a", "test-password").unwrap());
    let mut p = f.open(Some(actor));
    let before = p.workspace().unwrap().envelope().clone();
    assert!(p.workspace_mut().unwrap().acknowledge(ack).is_err());
    assert_eq!(*p.workspace().unwrap().envelope(), before);
}

#[test]
fn divergent_base_retains_local_and_explicit_load_resets_own_history() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor.clone()));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let mut remote = LayerPayload::from_document(&fixture_document()).unwrap();
    remote.annotations[0].note = "remote newer".into();
    f.repo.publish(&actor, None, &remote).unwrap();
    drop(p);
    let mut p = f.open(Some(actor.clone()));
    assert!(p.workspace().unwrap().sync_error().is_some());
    assert!(p.workspace_mut().unwrap().prepare_publication().is_err());
    assert_ne!(
        p.snapshot().unwrap().document.annotations[0].note,
        "remote newer"
    );
    change(
        &mut p,
        Change::AddEdit {
            edit: fixture_document().edits[0].clone(),
        },
    );
    save(&mut p);
    let layer = f
        .repo
        .read_author(&actor.identity().author_id)
        .unwrap()
        .unwrap();
    p.load_shared_version(Some(&layer)).unwrap();
    let snapshot = p.snapshot().unwrap();
    assert!(!snapshot.can_undo);
    assert_eq!(snapshot.document.annotations[0].note, "remote newer");
    assert_eq!(snapshot.document.edits.len(), 1);
    assert!(p.workspace().unwrap().envelope().pending.is_none());
    assert!(p.load_shared_version(None).is_err());
}

#[test]
fn all_private_write_faults_recover_complete_envelopes_and_never_lose_saved_data() {
    for fault in [
        WorkspaceFault::RecoveryWrite,
        WorkspaceFault::RecoverySync,
        WorkspaceFault::RecoveryReplace,
        WorkspaceFault::MainWrite,
        WorkspaceFault::MainSync,
        WorkspaceFault::MainReplace,
    ] {
        let f = Fixture::new();
        let mut p = f.open(None);
        change(
            &mut p,
            Change::AddAnnotation {
                annotation: annotation(),
            },
        );
        save(&mut p);
        let saved = p.snapshot().unwrap().document;
        let root = p.storage_root().to_path_buf();
        fs::write(root.join(".foreign.tmp"), b"do not delete").unwrap();
        change(
            &mut p,
            Change::UpdateAnnotationNote {
                id: annotation().id,
                note: "recoverable B".into(),
                merge_key: None,
            },
        );
        let newer = p.snapshot().unwrap().document;
        p.workspace_mut().unwrap().inject_fault(Some(fault));
        assert!(p.save(&newer.project_id, newer.revision).is_err());
        assert_eq!(p.persisted_revision(), saved.revision);
        drop(p);
        let mut p = f.open(None);
        let recovery_committed = matches!(
            fault,
            WorkspaceFault::MainWrite | WorkspaceFault::MainSync | WorkspaceFault::MainReplace
        );
        if recovery_committed {
            assert!(p.snapshot().is_err());
            assert!(p.workspace_mut().unwrap().prepare_publication().is_err());
            p.resolve_recovery(Some(annotator_core::project::RecoverySource::Recovery))
                .unwrap();
        }
        let restored = p.snapshot().unwrap().document;
        assert_eq!(restored, if recovery_committed { newer } else { saved });
        assert!(root.join(".foreign.tmp").exists());
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|s| s == "tmp"))
                .count(),
            1
        );
    }
}

#[test]
fn malformed_cache_recovers_from_valid_copy_and_rejects_invalid_identity_pending_and_versions() {
    for field in [
        "unknown",
        "actor",
        "generation",
        "formatVersion",
        "document",
        "pending",
    ] {
        let f = Fixture::new();
        let mut p = f.open(None);
        change(
            &mut p,
            Change::AddAnnotation {
                annotation: annotation(),
            },
        );
        save(&mut p);
        let root = p.storage_root().to_path_buf();
        let expected = p.snapshot().unwrap().document;
        drop(p);
        let mut v: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("workspace.json")).unwrap()).unwrap();
        match field {
            "unknown" => v["password"] = serde_json::json!("forbidden"),
            "actor" => v["actor"] = serde_json::json!(uuid::Uuid::new_v4().to_string()),
            "generation" => v["generation"] = serde_json::json!(0),
            "formatVersion" => v["formatVersion"] = serde_json::json!(2),
            "document" => v["document"]["media"][0]["sha256"] = serde_json::json!("b".repeat(64)),
            "pending" => v["pending"]["hash"] = serde_json::json!("c".repeat(64)),
            _ => unreachable!(),
        }
        let bytes = serde_json::to_vec(&v).unwrap();
        fs::write(root.join("workspace.json"), &bytes).unwrap();
        let mut p = f.open(None);
        assert!(p.snapshot().is_err());
        p.resolve_recovery(Some(annotator_core::project::RecoverySource::Recovery))
            .unwrap();
        assert_eq!(p.snapshot().unwrap().document, expected);
        drop(p);
        fs::write(root.join("workspace.json"), &bytes).unwrap();
        fs::write(root.join("workspace.recovery.json"), &bytes).unwrap();
        assert!(LocalProject::open_shared(f.repo.clone(), None, &f.local).is_err());
    }
}

#[test]
fn native_guards_keep_foreign_entities_out_of_personal_history_and_catalog_immutable() {
    let f = Fixture::new();
    let a = f.actor("a");
    let b = f.actor("b");
    let mut p = f.open(Some(a));
    let foreign = LayerPayload::from_document(&fixture_document()).unwrap();
    f.repo.publish(&b, None, &foreign).unwrap();
    let d = p.snapshot().unwrap().document;
    let foreign_id = foreign.annotations[0].id.clone();
    assert!(p
        .apply_change(
            &d.project_id,
            d.revision,
            Change::RemoveAnnotation { id: foreign_id }
        )
        .is_err());
    assert!(p
        .apply_change(
            &d.project_id,
            d.revision,
            Change::UpdateAnnotation {
                annotation: foreign.annotations[0].clone()
            }
        )
        .is_err());
    assert!(p.session_mut().is_err());
    assert!(p.store_mut().is_err());
    assert!(p
        .apply_change(
            &d.project_id,
            d.revision,
            Change::RemoveMedia {
                media_id: d.media[0].id.clone()
            }
        )
        .is_err());
    assert!(p
        .apply_change(
            &d.project_id,
            d.revision,
            Change::ImportMedia {
                media: d.media[0].clone()
            }
        )
        .is_err());
    let mut media = d.media[0].clone();
    media.sha256 = "f".repeat(64);
    assert!(p
        .apply_change(&d.project_id, d.revision, Change::RelinkMedia { media })
        .is_err());
    let mut own = annotation();
    own.id = uuid::Uuid::new_v4().to_string();
    change(&mut p, Change::AddAnnotation { annotation: own });
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    assert!(p.snapshot().unwrap().document.annotations.is_empty());
    let d = p.snapshot().unwrap().document;
    p.redo(&d.project_id, d.revision).unwrap();
    assert_eq!(p.snapshot().unwrap().document.annotations.len(), 1);
    assert_eq!(
        f.repo
            .read_author(&b.identity().author_id)
            .unwrap()
            .unwrap()
            .payload,
        foreign
    );
}

#[test]
fn failed_identity_preparation_keeps_old_session_and_rejects_cross_root_capability() {
    let f = Fixture::new();
    let other = Fixture::new();
    let actor = f.actor("a");
    let mut old = f.open(None);
    change(
        &mut old,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut old);
    let before = old.snapshot().unwrap();
    assert!(LocalProject::open_shared(other.repo.clone(), Some(actor), &f.local).is_err());
    assert!(LocalProject::open_shared(f.repo.clone(), None, &f.root).is_err());
    assert_eq!(old.snapshot().unwrap(), before);
}

#[test]
fn shared_export_is_sanitized_and_save_as_is_personal_ordinary_v2() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    change(
        &mut p,
        Change::AddEdit {
            edit: fixture_document().edits[0].clone(),
        },
    );
    let mut media = p.snapshot().unwrap().document.media[0].clone();
    media.source_ref = f.local.join("private.wav").to_string_lossy().into_owned();
    change(
        &mut p,
        Change::RelinkMedia {
            media: media.clone(),
        },
    );
    let mut view = p.snapshot().unwrap().document.view_state;
    view.linked_time = true;
    change(&mut p, Change::UpdateViewState { view_state: view });
    save(&mut p);
    let private = p.snapshot().unwrap().document;
    let public = p.export_document().unwrap();
    assert!(public.edits.is_empty());
    assert_eq!(public.view_state, ViewState::default());
    assert_eq!(
        public.media[0].source_ref,
        f.repo.manifest().media[0].source_ref
    );
    assert_eq!(public.annotations, private.annotations);
    assert!(!serde_json::to_string(&public)
        .unwrap()
        .contains("private.wav"));
    let local = f.local.join("copy");
    fs::create_dir(&local).unwrap();
    p.save_as(&local, &private.project_id, private.revision)
        .unwrap();
    assert!(!p.is_shared());
    assert_eq!(p.export_document().unwrap(), private);
    drop(p);
    let local = LocalProject::open(&local).unwrap();
    assert_eq!(local.snapshot().unwrap().document, private);
    assert!(!f.root.join("project.json").exists());
    assert!(!f.root.join("recovery.json").exists());
}

#[test]
fn local_save_and_capture_continue_with_shared_directory_unavailable() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor));
    // Move only the owned manifest, avoiding Windows held-author-lock directory restrictions.
    let path = f.root.join("collaboration.json");
    let hidden = f.root.join("collaboration.offline");
    fs::rename(&path, &hidden).unwrap();
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    assert!(job.publish().is_err());
    assert_eq!(
        p.persisted_revision(),
        p.snapshot().unwrap().document.revision
    );
    fs::rename(hidden, path).unwrap();
    let ack = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap()
        .publish()
        .unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
}

#[test]
fn omitted_remote_empty_labels_do_not_turn_private_settings_into_public_changes() {
    let f = Fixture::new();
    let actor = f.actor("a");
    f.repo
        .publish(&actor, None, &LayerPayload::default())
        .unwrap();
    let mut p = f.open(Some(actor));
    change(
        &mut p,
        Change::AddEdit {
            edit: fixture_document().edits[0].clone(),
        },
    );
    save(&mut p);
    assert!(p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .is_none());
}

#[test]
fn private_cache_rejects_pending_removed_from_changed_document() {
    let f = Fixture::new();
    let mut p = f.open(None);
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let root = p.storage_root().to_path_buf();
    drop(p);
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("workspace.json")).unwrap()).unwrap();
    value["pending"] = serde_json::Value::Null;
    for name in ["workspace.json", "workspace.recovery.json"] {
        fs::write(root.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
    }
    assert!(LocalProject::open_shared(f.repo.clone(), None, &f.local).is_err());
}

#[cfg(windows)]
#[test]
fn reparse_cache_parent_cannot_create_private_directories_on_share() {
    let f = Fixture::new();
    let link = f.local.join("collaboration");
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&f.root)
        .output()
        .unwrap();
    assert!(status.status.success());
    let before: Vec<_> = fs::read_dir(&f.root)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert!(LocalProject::open_shared(f.repo.clone(), None, &f.local).is_err());
    let after: Vec<_> = fs::read_dir(&f.root)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    fs::remove_dir(link).unwrap();
    assert_eq!(
        after, before,
        "No private directories may be created through a share junction"
    );
}

#[test]
fn explicit_remote_load_preserves_latest_unsaved_private_operations() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor.clone()));
    f.repo
        .publish(&actor, None, &LayerPayload::default())
        .unwrap();
    change(
        &mut p,
        Change::AddEdit {
            edit: fixture_document().edits[0].clone(),
        },
    );
    let remote = f
        .repo
        .read_author(&actor.identity().author_id)
        .unwrap()
        .unwrap();
    p.load_shared_version(Some(&remote)).unwrap();
    assert_eq!(p.snapshot().unwrap().document.edits.len(), 1);
}

#[test]
fn guest_channel_conflicts_reject_whole_merge_without_history_changes() {
    for category_conflict in [false, true] {
        let f = Fixture::new();
        let actor = f.actor("a");
        let mut p = f.open(Some(actor));
        let mut guest = LayerPayload::from_document(&fixture_document()).unwrap();
        let media = guest.media_labels[0].media_id.clone();
        if category_conflict {
            let category = fixture_document().categories[0].clone();
            change(
                &mut p,
                Change::AddCategory {
                    category: category.clone(),
                },
            );
            change(
                &mut p,
                Change::SetChannelCategory {
                    media_id: media.clone(),
                    channel_index: 0,
                    category_id: Some(category.id.clone()),
                },
            );
            guest.media_labels[0].channel_category_ids[0] = Some(category.id);
        } else {
            change(
                &mut p,
                Change::UpdateChannelNote {
                    media_id: media,
                    channel_index: 0,
                    note: "owner channel".into(),
                    merge_key: None,
                },
            );
        }
        let before = p.snapshot().unwrap();
        assert!(p
            .publish_guest(
                &before.document.project_id,
                before.document.revision,
                &guest
            )
            .is_err());
        assert_eq!(p.snapshot().unwrap(), before);
    }
}

fn inventory(root: &std::path::Path) -> Vec<(String, String)> {
    use sha2::{Digest, Sha256};
    fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out)
            } else {
                out.push((
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    if path.extension().is_some_and(|e| e == "lock") {
                        "OS-lock (excluded from hashing)".into()
                    } else {
                        format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
                    },
                ));
            }
        }
    }
    let mut out = vec![];
    walk(root, root, &mut out);
    out.sort();
    out
}
#[test]
fn disk_inventory_proves_private_save_does_not_touch_share() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor));
    let shared_before = inventory(&f.root);
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    change(
        &mut p,
        Change::AddEdit {
            edit: fixture_document().edits[0].clone(),
        },
    );
    save(&mut p);
    p.workspace_mut()
        .unwrap()
        .save_preferences(PlaybackPreferences {
            volume: 0.1,
            device_id: Some("private-output".into()),
            loop_enabled: true,
            source: WorkspaceSource::Original,
        })
        .unwrap();
    assert_eq!(shared_before, inventory(&f.root));
    let local = inventory(&f.local);
    assert_eq!(local.len(), 3);
    for (path, _) in &local {
        if path.ends_with(".lock") {
            continue;
        }
        let text = fs::read_to_string(f.local.join(path)).unwrap();
        assert!(!text.contains("test-password"));
        assert!(!text.contains("passwordHash"));
    }
    println!("Shared inventory unchanged after private annotation/edit/preferences save: {shared_before:#?}");
    println!("App-local inventory (relative path, SHA256): {local:#?}");
}

#[test]
fn shared_save_as_rejects_root_and_descendants_before_any_write() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let mut p = f.open(Some(actor));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let descendant = f.root.join("personal-copy");
    fs::create_dir(&descendant).unwrap();
    let before = inventory(&f.root);
    let snapshot = p.snapshot().unwrap();
    let storage = p.storage_root().to_path_buf();
    for target in [&f.root, &descendant] {
        assert!(p
            .save_as(
                target,
                &snapshot.document.project_id,
                snapshot.document.revision
            )
            .is_err());
        assert_eq!(inventory(&f.root), before);
        assert!(p.is_shared());
        assert_eq!(p.storage_root(), storage);
        assert_eq!(p.snapshot().unwrap(), snapshot);
    }
}

#[cfg(windows)]
#[test]
fn shared_save_as_rejects_junction_alias_before_any_write() {
    let f = Fixture::new();
    let mut p = f.open(None);
    let link = f.local.join("share-alias");
    assert!(std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&f.root)
        .output()
        .unwrap()
        .status
        .success());
    let snapshot = p.snapshot().unwrap();
    let before = inventory(&f.root);
    let result = p.save_as(
        &link,
        &snapshot.document.project_id,
        snapshot.document.revision,
    );
    fs::remove_dir(link).unwrap();
    assert!(result.is_err());
    assert_eq!(inventory(&f.root), before);
    assert!(p.is_shared());
}

#[test]
fn discarded_failed_shared_saves_never_reappear_and_accepted_pending_survives() {
    for fault in [
        WorkspaceFault::MainWrite,
        WorkspaceFault::MainSync,
        WorkspaceFault::MainReplace,
    ] {
        let f = Fixture::new();
        let actor = f.actor("a");
        let mut p = f.open(Some(actor.clone()));
        change(
            &mut p,
            Change::AddAnnotation {
                annotation: annotation(),
            },
        );
        save(&mut p);
        let accepted = p.workspace().unwrap().envelope().clone();
        change(
            &mut p,
            Change::UpdateAnnotationNote {
                id: annotation().id,
                note: "discarded B".into(),
                merge_key: None,
            },
        );
        let d = p.snapshot().unwrap().document;
        p.workspace_mut().unwrap().inject_fault(Some(fault));
        assert!(p.save(&d.project_id, d.revision).is_err());
        p.prepare_close(&d.project_id, d.revision, true).unwrap();
        drop(p);
        let mut p = f.open(Some(actor));
        assert!(p.recovery().is_none());
        assert_eq!(p.snapshot().unwrap().document, accepted.document);
        assert_eq!(p.workspace().unwrap().envelope().pending, accepted.pending);
        let job = p
            .workspace_mut()
            .unwrap()
            .prepare_publication()
            .unwrap()
            .unwrap();
        assert_eq!(job.payload(), &accepted.pending.unwrap().payload);
    }
}

#[test]
fn failed_discard_suppression_requires_choice_and_recovers_full_accepted_checkpoint() {
    let f = Fixture::new();
    let actor = f.actor("a");
    f.repo
        .publish(&actor, None, &LayerPayload::default())
        .unwrap();
    let mut p = f.open(Some(actor.clone()));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    p.workspace_mut()
        .unwrap()
        .save_preferences(PlaybackPreferences {
            volume: 0.2,
            device_id: Some("accepted-device".into()),
            loop_enabled: true,
            source: WorkspaceSource::Original,
        })
        .unwrap();
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let accepted = p.workspace().unwrap().envelope().clone();
    drop(job);
    change(
        &mut p,
        Change::UpdateAnnotationNote {
            id: annotation().id,
            note: "discarded B".into(),
            merge_key: None,
        },
    );
    let d = p.snapshot().unwrap().document;
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    assert!(p.save(&d.project_id, d.revision).is_err());
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::RecoveryWrite));
    p.prepare_close(&d.project_id, d.revision, true).unwrap();
    drop(p);
    let mut p = f.open(Some(actor));
    assert!(p.recovery().is_some());
    assert!(p.snapshot().is_err());
    assert!(p.workspace_mut().unwrap().prepare_publication().is_err());
    assert!(p
        .apply_change(
            &d.project_id,
            d.revision,
            Change::AddEdit {
                edit: fixture_document().edits[0].clone()
            }
        )
        .is_err());
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    assert!(p.resolve_recovery(None).is_err());
    assert!(p.recovery().is_some());
    assert!(p.snapshot().is_err());
    assert!(p.workspace_mut().unwrap().prepare_publication().is_err());
    p.workspace_mut().unwrap().inject_fault(None);
    p.resolve_recovery(None).unwrap();
    let recovered = p.workspace().unwrap().envelope();
    assert_eq!(recovered.document, accepted.document);
    assert_eq!(recovered.base, accepted.base);
    assert_eq!(recovered.confirmed, accepted.confirmed);
    assert_eq!(recovered.pending, accepted.pending);
    assert_eq!(recovered.preferences, accepted.preferences);
    // Capturing again must reuse the admitted A generation, not the failed B generation.
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    assert_eq!(
        job.generation(),
        accepted.pending.as_ref().unwrap().generation
    );
    let ack = job.publish().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert!(p.workspace().unwrap().envelope().pending.is_none());
}

#[test]
fn explicit_recovery_preserves_inflight_a_and_newer_b_after_lost_ack() {
    let f = Fixture::new();
    let actor = f.actor("a");
    let baseline = f
        .repo
        .publish(&actor, None, &LayerPayload::default())
        .unwrap();
    let mut p = f.open(Some(actor.clone()));
    change(
        &mut p,
        Change::AddAnnotation {
            annotation: annotation(),
        },
    );
    save(&mut p);
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    change(
        &mut p,
        Change::UpdateAnnotationNote {
            id: annotation().id,
            note: "recover B explicitly".into(),
            merge_key: None,
        },
    );
    let b = p.snapshot().unwrap().document;
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainSync));
    assert!(p.save(&b.project_id, b.revision).is_err());
    assert!(job
        .publish_controlled(Some(atomic::PublishFault::AfterPublish))
        .is_err());
    drop(p);
    let mut p = f.open(Some(actor.clone()));
    assert!(p.recovery().is_some());
    assert!(p.snapshot().is_err());
    assert!(p.workspace_mut().unwrap().prepare_publication().is_err());
    p.resolve_recovery(Some(annotator_core::project::RecoverySource::Recovery))
        .unwrap();
    assert_eq!(p.snapshot().unwrap().document, b);
    assert_eq!(p.workspace().unwrap().envelope().base, Some(baseline));
    // The admitted A survives recovery as a separate checkpoint from pending B.
    let job = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    assert_ne!(job.payload().annotations[0].note, "recover B explicitly");
    let ack = job.publish().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert_eq!(
        p.workspace()
            .unwrap()
            .envelope()
            .pending
            .as_ref()
            .unwrap()
            .payload
            .annotations[0]
            .note,
        "recover B explicitly"
    );
    let ack = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap()
        .publish()
        .unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert_eq!(
        f.repo
            .read_author(&actor.identity().author_id)
            .unwrap()
            .unwrap()
            .revision,
        3
    );
}
