use annotator_core::{
    collaboration::{
        profiles::Profile, purge::transaction::PurgeSelection, recycle::RecycleOperation, *,
    },
    model::*,
    project::{LocalProject, RecoverySource},
};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
struct Fixture {
    root: PathBuf,
    local: PathBuf,
    repo: Arc<CollaborationRepository>,
    actor: Arc<AuthorSession>,
    a: String,
    b: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("purge-workspace-{}", id()));
        fs::create_dir(&root).unwrap();
        let shared = root.join("shared");
        let local = root.join("local");
        fs::create_dir(&shared).unwrap();
        fs::create_dir(&local).unwrap();
        let (repo, actor) = CollaborationRepository::create_default(
            &shared,
            "Retirement",
            &Profile::new("Alice").unwrap(),
        )
        .unwrap();
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let mut ids = vec![];
        for _ in 0..2 {
            let media = repo
                .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
                .unwrap();
            ids.push(media.media().id.clone());
            repo.append_media(&actor, &media, &AtomicBool::new(false))
                .unwrap();
        }
        Self {
            root,
            local,
            repo: Arc::new(repo.reload_catalog().unwrap()),
            actor: Arc::new(actor),
            a: ids[0].clone(),
            b: ids[1].clone(),
        }
    }
    fn open(&self) -> LocalProject {
        LocalProject::open_shared(self.repo.clone(), Some(self.actor.clone()), &self.local).unwrap()
    }
    fn retire(&self, target: &str) -> Arc<CollaborationRepository> {
        let repo = CollaborationRepository::open(self.repo.root()).unwrap();
        repo.apply_recycle_controlled(
            &self.actor,
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
        let preview = repo
            .preview_purge(
                &self.actor,
                "test",
                &id(),
                PurgeSelection::Selected(vec![target.into()]),
            )
            .unwrap();
        let result = repo
            .commit_purge(&self.actor, "test", &preview, &AtomicBool::new(false))
            .unwrap();
        let current = CollaborationRepository::open(self.repo.root()).unwrap();
        current
            .retry_purge_cleanup(&self.actor, &result.operation_id)
            .unwrap();
        Arc::new(current)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn change(p: &mut LocalProject, c: Change) {
    let d = p.snapshot().unwrap().document;
    p.apply_change(&d.project_id, d.revision, c).unwrap();
}
fn note(p: &mut LocalProject, media: &str, value: &str) {
    change(
        p,
        Change::UpdateMediaNote {
            media_id: media.into(),
            note: value.into(),
            merge_key: None,
        },
    );
}
fn save(p: &mut LocalProject) {
    let d = p.snapshot().unwrap().document;
    p.save(&d.project_id, d.revision).unwrap();
}
fn adopt(p: &mut LocalProject, repo: Arc<CollaborationRepository>) {
    let d = p.snapshot().unwrap().document;
    p.adopt_shared_catalog(&d.project_id, d.revision, repo)
        .unwrap();
}
fn survivor(d: &ProjectDocument, b: &str) -> MediaDescriptor {
    d.media.iter().find(|m| m.id == b).unwrap().clone()
}
fn no_retired(d: &ProjectDocument, a: &str) {
    assert!(!serde_json::to_string(d).unwrap().contains(a));
    d.validate().unwrap();
}
fn decorate(p: &mut LocalProject, f: &Fixture) {
    let category = Category {
        id: id(),
        name: "Preserved".into(),
        color: "#112233".into(),
    };
    change(
        p,
        Change::AddCategory {
            category: category.clone(),
        },
    );
    for (media, value) in [(&f.a, "A"), (&f.b, "B")] {
        note(p, media, value);
        change(
            p,
            Change::SetMediaCategories {
                media_id: media.clone(),
                category_ids: vec![category.id.clone()],
            },
        );
        change(
            p,
            Change::UpdateChannelNote {
                media_id: media.clone(),
                channel_index: 0,
                note: value.into(),
                merge_key: None,
            },
        );
        let d = p.snapshot().unwrap().document;
        let region = Region {
            media_id: media.clone(),
            channel_index: 0,
            start_seconds: 0.0,
            end_seconds: 0.01,
            low_hz: 0.0,
            high_hz: 100.0,
        };
        change(
            p,
            Change::AddAnnotation {
                annotation: Annotation {
                    id: id(),
                    region: region.clone(),
                    category_ids: vec![category.id.clone()],
                    note: value.into(),
                    created_at: d.created_at,
                    updated_at: d.updated_at,
                },
            },
        );
        for operation in [
            EditOperation::Mask,
            EditOperation::Gain {
                gain_db: if media == &f.a { -3.0 } else { 6.0 },
            },
        ] {
            let mut fixture = ProjectDocument::from_json(include_str!(
                "../../../tests/fixtures/document-v3.json"
            ))
            .unwrap();
            let mut edit = fixture.edits.remove(0);
            edit.id = id();
            edit.region = region.clone();
            edit.operation = operation;
            change(p, Change::AddEdit { edit });
        }
        change(
            p,
            Change::UpdateAnalysis {
                media_id: media.clone(),
                settings: AnalysisSettings {
                    window_size: if media == &f.a { 1024 } else { 2048 },
                    hop_size: 256,
                    ..Default::default()
                },
            },
        );
        change(
            p,
            Change::UpdatePlaybackMix {
                media_id: media.clone(),
                mix: PlaybackMix {
                    muted_channels: if media == &f.a { vec![0] } else { vec![] },
                    solo_channels: if media == &f.b { vec![0] } else { vec![] },
                },
            },
        );
    }
    let mut view = p.snapshot().unwrap().document.view_state;
    view.active_media_id = Some(f.a.clone());
    view.compare_media_id = Some(f.b.clone());
    for media in [&f.a, &f.b] {
        view.media.insert(
            media.clone(),
            MediaView {
                visible_channels: vec![0],
                start_seconds: 0.0,
                end_seconds: 0.01,
                low_hz: 0.0,
                high_hz: 100.0,
                frequency_mix: 0.5,
                spectrum_kind: SpectrumKind::Stft,
                gain_db: if media == &f.a { -2.0 } else { 3.0 },
                dynamic_range_db: 80.0,
                palette: "magma".into(),
            },
        );
    }
    change(p, Change::UpdateViewState { view_state: view });
    save(p);
    p.workspace_mut()
        .unwrap()
        .set_hidden_media_ids(vec![f.a.clone(), f.b.clone()])
        .unwrap();
    let mut prefs = PlaybackPreferences::default();
    prefs.media_monitor_gain_db.insert(f.a.clone(), Some(-5.0));
    prefs.media_monitor_gain_db.insert(f.b.clone(), Some(7.0));
    prefs.volume = 0.42;
    p.workspace_mut().unwrap().save_preferences(prefs).unwrap();
}
#[test]
fn retirement_preserves_live_draft_both_history_stacks_and_pending_admission() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let ack = capture.publish().unwrap();
    note(&mut p, &f.b, "B saved newer");
    save(&mut p);
    note(&mut p, &f.b, "B live draft");
    note(&mut p, &f.b, "B redo draft");
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    let before = p.snapshot().unwrap();
    let prefs = p.workspace().unwrap().preferences().clone();
    let current = f.retire(&f.a);
    adopt(&mut p, current);
    let after = p.snapshot().unwrap();
    no_retired(&after.document, &f.a);
    assert_eq!(
        survivor(&before.document, &f.b),
        survivor(&after.document, &f.b)
    );
    assert_eq!(
        before
            .document
            .edits
            .iter()
            .filter(|e| e.region.media_id == f.b)
            .collect::<Vec<_>>(),
        after.document.edits.iter().collect::<Vec<_>>()
    );
    assert!(after.can_undo && after.can_redo);
    assert_eq!(after.document.categories, before.document.categories);
    assert_eq!(
        after.document.analysis.get(&f.b),
        before.document.analysis.get(&f.b)
    );
    assert_eq!(
        after.document.playback_mix.get(&f.b),
        before.document.playback_mix.get(&f.b)
    );
    assert_eq!(
        after.document.view_state.media.get(&f.b),
        before.document.view_state.media.get(&f.b)
    );
    assert_eq!(
        after.document.annotations,
        before
            .document
            .annotations
            .iter()
            .filter(|a| a.region.media_id == f.b)
            .cloned()
            .collect::<Vec<_>>()
    );
    assert_eq!(p.workspace().unwrap().preferences().volume, prefs.volume);
    assert_eq!(
        p.workspace()
            .unwrap()
            .preferences()
            .media_monitor_gain_db
            .get(&f.b),
        prefs.media_monitor_gain_db.get(&f.b)
    );
    assert_eq!(p.workspace().unwrap().hidden_media_ids(), &[f.b.clone()]);
    assert!(
        p.workspace_mut().unwrap().acknowledge(ack).is_err(),
        "late old-generation ack must not overwrite the rebased admission"
    );
    let d = p.snapshot().unwrap().document;
    let redone = p.redo(&d.project_id, d.revision).unwrap();
    no_retired(&redone.document, &f.a);
    assert_eq!(survivor(&redone.document, &f.b).note, "B redo draft");
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    let root = p.workspace().unwrap().root();
    for name in ["workspace.json", "workspace.recovery.json"] {
        let bytes = fs::read(root.join(name)).unwrap();
        assert!(!String::from_utf8(bytes).unwrap().contains(&f.a));
    }
    let e = p.workspace().unwrap().envelope();
    assert_eq!(
        e.pending
            .as_ref()
            .unwrap()
            .payload
            .media_labels
            .iter()
            .find(|m| m.media_id == f.b)
            .unwrap()
            .note,
        "B saved newer"
    );
    assert_eq!(
        e.confirmed
            .media_labels
            .iter()
            .find(|m| m.media_id == f.b)
            .map(|m| m.note.as_str()),
        Some("")
    );
    assert!(p.workspace().unwrap().author_session().is_some());
    // The old acknowledgement was rejected, but its projected admission remains
    // retryable and the independently newer pending payload must still publish.
    for expected in ["B", "B saved newer"] {
        let capture = p
            .workspace_mut()
            .unwrap()
            .prepare_publication()
            .unwrap()
            .unwrap();
        assert_eq!(
            capture
                .payload()
                .media_labels
                .iter()
                .find(|m| m.media_id == f.b)
                .unwrap()
                .note,
            expected
        );
        let ack = capture.publish().unwrap();
        p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    }
    assert!(p.workspace().unwrap().envelope().pending.is_none());
    assert_eq!(
        survivor(&p.snapshot().unwrap().document, &f.b).note,
        "B live draft"
    );
}
#[test]
fn reopen_projects_both_durable_candidates_before_recovery_choice() {
    for choose_recovery in [false, true] {
        let f = Fixture::new();
        let mut p = f.open();
        decorate(&mut p, &f);
        note(&mut p, &f.b, "B primary");
        save(&mut p);
        note(&mut p, &f.b, "B recovery");
        p.workspace_mut()
            .unwrap()
            .inject_fault(Some(WorkspaceFault::MainReplace));
        let d = p.snapshot().unwrap().document;
        assert!(p.save(&d.project_id, d.revision).is_err());
        let root = p.workspace().unwrap().root().to_owned();
        let primary_before = fs::read(root.join("workspace.json")).unwrap();
        let recovery_before = fs::read(root.join("workspace.recovery.json")).unwrap();
        assert_ne!(primary_before, recovery_before);
        drop(p);
        let current = f.retire(&f.a);
        let mut p = LocalProject::open_shared(current, Some(f.actor.clone()), &f.local).unwrap();
        let report = p.recovery().unwrap();
        no_retired(report.primary.as_ref().unwrap(), &f.a);
        no_retired(&report.candidates[0].document, &f.a);
        assert_eq!(
            survivor(report.primary.as_ref().unwrap(), &f.b).note,
            "B primary"
        );
        assert_eq!(
            survivor(&report.candidates[0].document, &f.b).note,
            "B recovery"
        );
        for name in ["workspace.json", "workspace.recovery.json"] {
            assert!(!fs::read_to_string(root.join(name)).unwrap().contains(&f.a));
        }
        p.resolve_recovery(choose_recovery.then_some(RecoverySource::Recovery))
            .unwrap();
        assert_eq!(
            survivor(&p.snapshot().unwrap().document, &f.b).note,
            if choose_recovery {
                "B recovery"
            } else {
                "B primary"
            }
        );
    }
}

#[test]
fn retirement_only_does_not_adopt_new_remote_media_and_rebased_capture_cannot_ack_old_workspace() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let media = f
        .repo
        .prepare_media(&source, &f.root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    let c = media.media().id.clone();
    f.repo
        .append_media(&f.actor, &media, &AtomicBool::new(false))
        .unwrap();
    let current = f.retire(&f.a);
    let ack = capture.publish().unwrap();
    assert!(p.workspace_mut().unwrap().acknowledge(ack).is_err());
    let head = current
        .read_author(&f.actor.identity().author_id)
        .unwrap()
        .unwrap();
    assert!(head
        .payload
        .annotations
        .iter()
        .all(|a| a.region.media_id != f.a));
    assert!(head.payload.media_labels.iter().all(|m| m.media_id != f.a));
    assert_eq!(
        head.payload
            .media_labels
            .iter()
            .find(|m| m.media_id == f.b)
            .unwrap()
            .note,
        "B"
    );
    let prepared = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare_retirement(CollaborationRepository::open(current.root()).unwrap())
        .unwrap();
    let d = p.snapshot().unwrap().document;
    p.adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .unwrap();
    assert_eq!(
        p.snapshot()
            .unwrap()
            .document
            .media
            .iter()
            .map(|m| &m.id)
            .collect::<Vec<_>>(),
        vec![&f.b]
    );
    assert!(!serde_json::to_string(p.workspace().unwrap().envelope())
        .unwrap()
        .contains(&c));
    adopt(&mut p, current);
    assert!(p
        .snapshot()
        .unwrap()
        .document
        .media
        .iter()
        .any(|m| m.id == c));
    assert_eq!(survivor(&p.snapshot().unwrap().document, &f.b).note, "B");
}

#[test]
fn exact_checkpoint_and_payload_free_provenance_survive_multiple_retirements() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
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
    note(&mut p, &f.b, "B unsynced");
    save(&mut p);
    let source_bytes = fs::read(p.workspace().unwrap().root().join("workspace.json")).unwrap();
    let old = p.workspace().unwrap().envelope().base.clone().unwrap();
    let current = f.retire(&f.a);
    let intermediate: serde_json::Value =
        serde_json::from_slice(&fs::read(current.root().join("collaboration.json")).unwrap())
            .unwrap();
    let middle_dir = current
        .root()
        .join("state")
        .join(intermediate["metadataGeneration"].as_str().unwrap());
    let current = f.retire(&f.b);
    // Task5 cleanup may remove these bodies. Source binding must use current
    // payload-free provenance, never demand the old physical generation.
    assert!(!middle_dir.join("generation.json").exists());
    assert!(!middle_dir
        .join("annotations")
        .join(&f.actor.identity().author_id)
        .join("00000000000000000001.json")
        .exists());
    adopt(&mut p, current.clone());
    assert!(p.snapshot().unwrap().document.media.is_empty());
    assert!(
        p.workspace()
            .unwrap()
            .envelope()
            .base
            .as_ref()
            .unwrap()
            .hash
            != old.hash
    );
    assert!(p.workspace().unwrap().envelope().pending.is_some());
    let root = p.workspace().unwrap().root().to_owned();
    drop(p);
    for (key, value) in [
        ("manifestHash", serde_json::json!("a".repeat(64))),
        (
            "base",
            serde_json::json!({"revision":999,"hash":"b".repeat(64)}),
        ),
    ] {
        // Use an old source envelope so bogus checkpoints must traverse a proof.
        let mut e: serde_json::Value = serde_json::from_slice(&source_bytes).unwrap();
        e[key] = value;
        fs::write(root.join("workspace.json"), serde_json::to_vec(&e).unwrap()).unwrap();
        fs::write(
            root.join("workspace.recovery.json"),
            serde_json::to_vec(&e).unwrap(),
        )
        .unwrap();
        assert!(
            LocalProject::open_shared(current.clone(), Some(f.actor.clone()), &f.local).is_err(),
            "bogus source/checkpoint accepted"
        );
    }
}

#[test]
fn known_retirement_projects_an_open_recovery_choice_without_promoting_either_candidate() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
    note(&mut p, &f.b, "B primary");
    save(&mut p);
    note(&mut p, &f.b, "B recovery");
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    let d = p.snapshot().unwrap().document;
    assert!(p.save(&d.project_id, d.revision).is_err());
    drop(p);
    let mut p = f.open();
    let d = p.workspace().unwrap().envelope().document.clone();
    let current = f.retire(&f.a);
    let prepared = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare(current)
        .unwrap();
    p.adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .unwrap();
    let report = p.recovery().unwrap();
    assert_eq!(
        survivor(report.primary.as_ref().unwrap(), &f.b).note,
        "B primary"
    );
    assert_eq!(
        survivor(&report.candidates[0].document, &f.b).note,
        "B recovery"
    );
    no_retired(report.primary.as_ref().unwrap(), &f.a);
    no_retired(&report.candidates[0].document, &f.a);
}

#[test]
fn failed_live_save_recovery_is_not_overwritten_by_retirement() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
    note(&mut p, &f.b, "B primary");
    save(&mut p);
    note(&mut p, &f.b, "B failed save proposal");
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    let d = p.snapshot().unwrap().document;
    assert!(p.save(&d.project_id, d.revision).is_err());
    p.workspace_mut().unwrap().inject_fault(None);
    let current = f.retire(&f.a);
    adopt(&mut p, current.clone());
    assert_eq!(
        survivor(&p.snapshot().unwrap().document, &f.b).note,
        "B failed save proposal"
    );
    drop(p);
    let p = LocalProject::open_shared(current, Some(f.actor.clone()), &f.local).unwrap();
    let report = p
        .recovery()
        .expect("retirement must preserve an unaccepted recovery proposal");
    assert_eq!(
        survivor(report.primary.as_ref().unwrap(), &f.b).note,
        "B primary"
    );
    assert_eq!(
        survivor(&report.candidates[0].document, &f.b).note,
        "B failed save proposal"
    );
}

#[test]
fn remembered_layers_follow_exact_checkpoint_mappings_before_accepting_new_snapshot() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
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
    note(&mut p, &f.b, "B published second");
    save(&mut p);
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
    let mut remembered = RememberedLayers::new(f.repo.manifest().clone());
    remembered.update(f.repo.snapshot().unwrap()).unwrap();
    let old = remembered.snapshot().clone();
    let current = f.retire(&f.a);
    assert!(
        remembered
            .adopt_catalog(current.manifest().clone())
            .is_err(),
        "unsigned manifest cannot authorize shrink"
    );
    assert_eq!(remembered.snapshot(), &old);
    let prepared = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare(current.clone())
        .unwrap();
    remembered.adopt_prepared_catalog(&prepared).unwrap();
    let layer = remembered
        .snapshot()
        .authors
        .iter()
        .find_map(|a| a.layer.as_ref())
        .unwrap();
    assert!(!serde_json::to_string(layer).unwrap().contains(&f.a));
    assert_eq!(
        layer,
        &current
            .read_author(&f.actor.identity().author_id)
            .unwrap()
            .unwrap()
    );
    remembered.update(current.snapshot().unwrap()).unwrap();
    assert!(remembered
        .snapshot()
        .authors
        .iter()
        .all(|a| a.error.is_none()));
}

#[test]
fn failed_preference_write_after_prepare_rejects_stale_recovery_bytes_before_any_replace() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
    note(&mut p, &f.b, "B recovery one");
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    let d = p.snapshot().unwrap().document;
    assert!(p.save(&d.project_id, d.revision).is_err());
    let current = f.retire(&f.a);
    let prepared = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare(current)
        .unwrap();
    let sequence = p.workspace().unwrap().envelope().sequence;
    let mut prefs = p.workspace().unwrap().preferences().clone();
    prefs.volume = 0.17;
    assert!(p.workspace_mut().unwrap().save_preferences(prefs).is_err());
    assert_eq!(p.workspace().unwrap().envelope().sequence, sequence);
    let root = p.workspace().unwrap().root().to_owned();
    let before = [
        fs::read(root.join("workspace.json")).unwrap(),
        fs::read(root.join("workspace.recovery.json")).unwrap(),
    ];
    p.workspace_mut().unwrap().inject_fault(None);
    assert!(
        p.adopt_prepared_catalog(&d.project_id, d.revision, prepared)
            .is_err(),
        "stale preparation overwrote a different same-sequence recovery proposal"
    );
    assert_eq!(fs::read(root.join("workspace.json")).unwrap(), before[0]);
    assert_eq!(
        fs::read(root.join("workspace.recovery.json")).unwrap(),
        before[1]
    );
}

#[test]
fn every_retirement_write_fault_reopens_both_b_candidates_without_resurrection() {
    for fault in [
        WorkspaceFault::RecoveryWrite,
        WorkspaceFault::RecoverySync,
        WorkspaceFault::RecoveryReplace,
        WorkspaceFault::MainWrite,
        WorkspaceFault::MainSync,
        WorkspaceFault::MainReplace,
    ] {
        let f = Fixture::new();
        let mut p = f.open();
        decorate(&mut p, &f);
        note(&mut p, &f.b, "B primary");
        save(&mut p);
        note(&mut p, &f.b, "B proposal");
        p.workspace_mut()
            .unwrap()
            .inject_fault(Some(WorkspaceFault::MainReplace));
        let d = p.snapshot().unwrap().document;
        assert!(p.save(&d.project_id, d.revision).is_err());
        let current = f.retire(&f.a);
        let prepared = p
            .workspace()
            .unwrap()
            .catalog_source()
            .prepare(current.clone())
            .unwrap();
        p.workspace_mut().unwrap().inject_fault(Some(fault));
        assert!(p
            .adopt_prepared_catalog(&d.project_id, d.revision, prepared)
            .is_err());
        assert_eq!(
            p.snapshot().unwrap().document,
            d,
            "failed install changed live draft"
        );
        drop(p);
        let p = LocalProject::open_shared(current, Some(f.actor.clone()), &f.local).unwrap();
        let report = p.recovery().unwrap();
        no_retired(report.primary.as_ref().unwrap(), &f.a);
        no_retired(&report.candidates[0].document, &f.a);
        assert_eq!(
            survivor(report.primary.as_ref().unwrap(), &f.b).note,
            "B primary"
        );
        assert_eq!(
            survivor(&report.candidates[0].document, &f.b).note,
            "B proposal"
        );
        for name in ["workspace.json", "workspace.recovery.json"] {
            assert!(
                !fs::read_to_string(p.workspace().unwrap().root().join(name))
                    .unwrap()
                    .contains(&f.a)
            );
        }
    }
}

#[test]
fn retirement_rejects_surviving_public_descriptor_mutation_even_with_private_relink() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
    let mut b = survivor(&p.snapshot().unwrap().document, &f.b);
    b.source_ref = "C:/private/relink.wav".into();
    change(&mut p, Change::RelinkMedia { media: b });
    save(&mut p);
    let root = p.workspace().unwrap().root().to_owned();
    let source = fs::read(root.join("workspace.json")).unwrap();
    drop(p);
    let current = f.retire(&f.a);
    for mutation in ["displayName", "sourceRef"] {
        let mut e: serde_json::Value = serde_json::from_slice(&source).unwrap();
        let catalog = e["catalog"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|m| m["id"] == f.b)
            .unwrap();
        catalog[mutation] = serde_json::json!(if mutation == "displayName" {
            "Tampered name"
        } else {
            "media/tampered.wav"
        });
        if mutation == "displayName" {
            e["document"]["media"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|m| m["id"] == f.b)
                .unwrap()[mutation] = serde_json::json!("Tampered name");
        }
        for name in ["workspace.json", "workspace.recovery.json"] {
            fs::write(root.join(name), serde_json::to_vec(&e).unwrap()).unwrap();
        }
        assert!(
            LocalProject::open_shared(current.clone(), Some(f.actor.clone()), &f.local).is_err()
        );
    }
}

#[test]
fn view_only_retirement_and_personal_copy_preserve_private_b_without_shared_writes() {
    let f = Fixture::new();
    let mut p = LocalProject::open_shared_view_only(f.repo.clone(), &f.local).unwrap();
    for media in [&f.a, &f.b] {
        let mut fixture =
            ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v3.json"))
                .unwrap();
        let mut edit = fixture.edits.remove(0);
        edit.id = id();
        edit.region.media_id = media.clone();
        edit.region.start_seconds = 0.0;
        edit.region.end_seconds = 0.01;
        edit.region.low_hz = 0.0;
        edit.region.high_hz = 100.0;
        change(&mut p, Change::AddEdit { edit });
    }
    save(&mut p);
    let current = f.retire(&f.a);
    fn inventory(
        path: &std::path::Path,
        result: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>,
    ) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                inventory(&path, result);
            } else if path.extension().is_none_or(|extension| extension != "lock") {
                result.insert(path.clone(), fs::read(path).unwrap());
            }
        }
    }
    let mut before = Default::default();
    inventory(current.root(), &mut before);
    let prepared = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare(current.clone())
        .unwrap();
    let d = p.snapshot().unwrap().document;
    p.adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .unwrap();
    assert!(p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .is_none());
    let d = p.snapshot().unwrap().document;
    no_retired(&d, &f.a);
    assert_eq!(d.edits.len(), 1);
    assert_eq!(d.edits[0].region.media_id, f.b);
    let copy = f.root.join("copy");
    fs::create_dir(&copy).unwrap();
    p.save_as(&copy, &d.project_id, d.revision).unwrap();
    assert_eq!(p.snapshot().unwrap().document.edits, d.edits);
    assert!(!fs::read_to_string(copy.join("project.json"))
        .unwrap()
        .contains(&f.a));
    let mut after = Default::default();
    inventory(current.root(), &mut after);
    assert_eq!(before, after);
}

#[test]
fn retiring_longest_media_keeps_linked_survivor_view_valid() {
    let f = Fixture::new();
    let mut p = f.open();
    decorate(&mut p, &f);
    let mut d = p.snapshot().unwrap().document;
    d.media
        .iter_mut()
        .find(|m| m.id == f.b)
        .unwrap()
        .frame_count /= 2;
    d.view_state.linked_time = true;
    d.view_state.media.get_mut(&f.b).unwrap().end_seconds =
        d.media.iter().find(|m| m.id == f.a).unwrap().duration();
    d.validate().unwrap();
    annotator_core::collaboration::purge::projection::project_document(
        &mut d,
        &std::collections::HashSet::from([f.a.clone()]),
    )
    .unwrap();
    assert_eq!(
        d.view_state.media[&f.b].end_seconds,
        survivor(&d, &f.b).duration()
    );
    no_retired(&d, &f.a);
}

/// A real failed append adoption leaves accepted A/B and proposed A/B/C.
fn wider_failed_recovery(f: &Fixture, p: &mut LocalProject) -> (String, PathBuf) {
    decorate(p, f);
    note(p, &f.b, "B saved before growth");
    save(p);
    note(p, &f.b, "B live before growth");
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let media = f
        .repo
        .prepare_media(&source, &f.root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    let c = media.media().id.clone();
    f.repo
        .append_media(&f.actor, &media, &AtomicBool::new(false))
        .unwrap();
    let expanded = Arc::new(f.repo.reload_catalog().unwrap());
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    let d = p.snapshot().unwrap().document;
    assert!(p
        .adopt_shared_catalog(&d.project_id, d.revision, expanded)
        .is_err());
    p.workspace_mut().unwrap().inject_fault(None);
    let root = p.workspace().unwrap().root().to_owned();
    // Populate a valid private C payload in this independent recovery fixture.
    // Its authoritative public descriptor is the real failed-adoption descriptor.
    update_recovery_note(&root, &c, "C recovery draft");
    (c, root)
}
fn update_recovery_note(root: &std::path::Path, media: &str, note: &str) {
    let path = root.join("workspace.recovery.json");
    let mut e: PrivateEnvelope = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    e.document
        .media
        .iter_mut()
        .find(|m| m.id == media)
        .unwrap()
        .note = note.into();
    let payload = LayerPayload::from_document(&e.document).unwrap();
    e.pending = Some(PendingPayload {
        generation: e.generation,
        hash: payload.hash().unwrap(),
        payload,
    });
    e.document.validate().unwrap();
    fs::write(path, serde_json::to_vec(&e).unwrap()).unwrap();
}
fn private_json(root: &std::path::Path, name: &str) -> serde_json::Value {
    serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap()
}
fn scoped_ids(e: &serde_json::Value, field: &str) -> std::collections::BTreeSet<String> {
    let media = if field == "catalog" {
        &e["catalog"]
    } else {
        &e["document"]["media"]
    };
    media
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_owned())
        .collect()
}
#[test]
fn retirement_after_failed_catalog_growth_preserves_independent_durable_scopes() {
    for choose_recovery in [false, true] {
        let f = Fixture::new();
        let mut p = f.open();
        let (c, root) = wider_failed_recovery(&f, &mut p);
        let before_live = p.snapshot().unwrap().document;
        let before_main = private_json(&root, "workspace.json");
        let before_recovery = private_json(&root, "workspace.recovery.json");
        assert_eq!(
            scoped_ids(&before_main, "catalog"),
            [f.a.clone(), f.b.clone()].into()
        );
        assert_eq!(
            scoped_ids(&before_recovery, "catalog"),
            [f.a.clone(), f.b.clone(), c.clone()].into()
        );
        let public_c = before_recovery["catalog"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == c)
            .unwrap()
            .clone();
        let private_c = before_recovery["document"]["media"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == c)
            .unwrap()
            .clone();
        let audio = f.repo.root().join(public_c["sourceRef"].as_str().unwrap());
        let audio_before = fs::read(&audio).unwrap();
        let current = f.retire(&f.a);
        let prepared = p
            .workspace()
            .unwrap()
            .catalog_source()
            .prepare_retirement(CollaborationRepository::open(current.root()).unwrap())
            .expect("valid wider recovery must not prevent retirement of accepted media");
        let d = p.snapshot().unwrap().document;
        p.adopt_prepared_catalog(&d.project_id, d.revision, prepared)
            .unwrap();
        let after_live = p.snapshot().unwrap().document;
        no_retired(&after_live, &f.a);
        assert_eq!(after_live.media.len(), 1);
        assert_eq!(survivor(&after_live, &f.b), survivor(&before_live, &f.b));
        assert!(
            p.recovery().is_none(),
            "retirement must not require an unrelated recovery action"
        );
        let main = private_json(&root, "workspace.json");
        let recovery = private_json(&root, "workspace.recovery.json");
        for field in ["catalog", "document"] {
            assert_eq!(scoped_ids(&main, field), [f.b.clone()].into());
            assert_eq!(
                scoped_ids(&recovery, field),
                [f.b.clone(), c.clone()].into()
            );
        }
        for (e, before) in [(&main, &before_main), (&recovery, &before_recovery)] {
            assert!(!e.to_string().contains(&f.a));
            assert_eq!(e["sequence"], before["sequence"]);
            assert_eq!(e["generation"], before["generation"]);
            assert_eq!(e["preferences"]["volume"], before["preferences"]["volume"]);
            assert_eq!(
                e["pending"]["payload"]["mediaLabels"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| m["mediaId"] == f.b),
                before["pending"]["payload"]["mediaLabels"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| m["mediaId"] == f.b)
            );
        }
        assert_eq!(
            recovery["catalog"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["id"] == c)
                .unwrap(),
            &public_c
        );
        assert_eq!(
            recovery["document"]["media"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["id"] == c)
                .unwrap(),
            &private_c
        );
        assert_eq!(
            recovery["pending"]["payload"]["mediaLabels"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["mediaId"] == c)
                .unwrap()["note"],
            "C recovery draft"
        );
        assert_eq!(fs::read(&audio).unwrap(), audio_before);
        assert!(Arc::ptr_eq(
            &p.workspace().unwrap().author_session().unwrap(),
            &f.actor
        ));
        let d = p.snapshot().unwrap().document;
        let undone = p.undo(&d.project_id, d.revision).unwrap();
        no_retired(&undone.document, &f.a);
        assert_eq!(
            survivor(&undone.document, &f.b).note,
            "B saved before growth"
        );
        let d = p.snapshot().unwrap().document;
        assert_eq!(
            survivor(&p.redo(&d.project_id, d.revision).unwrap().document, &f.b).note,
            "B live before growth"
        );
        drop(p);
        // Opening explicitly adopts ordinary catalog additions in both choices.
        let mut p = LocalProject::open_shared(current, Some(f.actor.clone()), &f.local).unwrap();
        let report = p.recovery().unwrap();
        assert_eq!(survivor(report.primary.as_ref().unwrap(), &c).note, "");
        assert_eq!(
            survivor(&report.candidates[0].document, &c).note,
            "C recovery draft"
        );
        p.resolve_recovery(choose_recovery.then_some(RecoverySource::Recovery))
            .unwrap();
        assert_eq!(
            survivor(&p.snapshot().unwrap().document, &c).note,
            if choose_recovery {
                "C recovery draft"
            } else {
                ""
            }
        );
        assert_eq!(fs::read(audio).unwrap(), audio_before);
    }
}

#[test]
fn wider_recovery_retirement_rejects_stale_bytes_and_retries_partial_local_publication() {
    let f = Fixture::new();
    let mut p = f.open();
    let (c, root) = wider_failed_recovery(&f, &mut p);
    let current = f.retire(&f.a);
    let prepare = |p: &LocalProject| {
        p.workspace()
            .unwrap()
            .catalog_source()
            .prepare_retirement(CollaborationRepository::open(current.root()).unwrap())
            .unwrap()
    };
    let prepared = prepare(&p);
    let main_before = fs::read(root.join("workspace.json")).unwrap();
    let seq = private_json(&root, "workspace.recovery.json")["sequence"].clone();
    update_recovery_note(&root, &c, "C newer same-sequence proposal");
    assert_eq!(
        private_json(&root, "workspace.recovery.json")["sequence"],
        seq
    );
    let recovery_newer = fs::read(root.join("workspace.recovery.json")).unwrap();
    let d = p.snapshot().unwrap().document;
    assert!(p
        .adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .is_err());
    assert_eq!(fs::read(root.join("workspace.json")).unwrap(), main_before);
    assert_eq!(
        fs::read(root.join("workspace.recovery.json")).unwrap(),
        recovery_newer
    );

    let prepared = prepare(&p);
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    assert!(p
        .adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .is_err());
    assert_eq!(p.snapshot().unwrap().document, d);
    assert_eq!(fs::read(root.join("workspace.json")).unwrap(), main_before);
    let projected_recovery = private_json(&root, "workspace.recovery.json");
    assert!(!projected_recovery.to_string().contains(&f.a));
    assert_eq!(
        scoped_ids(&projected_recovery, "catalog"),
        [f.b.clone(), c.clone()].into()
    );
    assert_eq!(
        projected_recovery["document"]["media"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == c)
            .unwrap()["note"],
        "C newer same-sequence proposal"
    );
    p.workspace_mut().unwrap().inject_fault(None);
    let prepared = prepare(&p);
    p.adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .unwrap();
    assert_eq!(
        scoped_ids(&private_json(&root, "workspace.json"), "catalog"),
        [f.b.clone()].into()
    );
    assert_eq!(
        private_json(&root, "workspace.recovery.json"),
        projected_recovery,
        "retry must not increment or change an already migrated proposal"
    );
    drop(p);
    let p = LocalProject::open_shared(current, Some(f.actor.clone()), &f.local).unwrap();
    let report = p.recovery().unwrap();
    assert_eq!(survivor(report.primary.as_ref().unwrap(), &c).note, "");
    assert_eq!(
        survivor(&report.candidates[0].document, &c).note,
        "C newer same-sequence proposal"
    );
}

#[test]
fn retirement_rejects_mutated_descriptor_of_media_present_only_in_recovery() {
    let f = Fixture::new();
    let mut p = f.open();
    let (c, root) = wider_failed_recovery(&f, &mut p);
    let current = f.retire(&f.a);
    let mut recovery = private_json(&root, "workspace.recovery.json");
    recovery["catalog"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|m| m["id"] == c)
        .unwrap()["displayName"] = serde_json::json!("Replaced public C name");
    recovery["document"]["media"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|m| m["id"] == c)
        .unwrap()["displayName"] = serde_json::json!("Replaced public C name");
    fs::write(
        root.join("workspace.recovery.json"),
        serde_json::to_vec(&recovery).unwrap(),
    )
    .unwrap();
    let main_before = fs::read(root.join("workspace.json")).unwrap();
    let recovery_before = fs::read(root.join("workspace.recovery.json")).unwrap();
    let result = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare_retirement(CollaborationRepository::open(current.root()).unwrap());
    assert!(
        result.is_err(),
        "a recovery-only survivor still needs its exact public descriptor"
    );
    assert_eq!(fs::read(root.join("workspace.json")).unwrap(), main_before);
    assert_eq!(
        fs::read(root.join("workspace.recovery.json")).unwrap(),
        recovery_before
    );
}
