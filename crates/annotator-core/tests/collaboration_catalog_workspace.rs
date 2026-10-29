#![cfg(windows)]
mod support;
use annotator_core::{
    collaboration::*,
    model::*,
    project::{LocalProject, RecoverySource},
};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
use support::*;

struct Fixture {
    root: PathBuf,
    local: PathBuf,
    repo: Arc<CollaborationRepository>,
    actor: Arc<AuthorSession>,
}
impl Fixture {
    fn new() -> Self {
        let mut f = Self::empty();
        f.append();
        f.repo = Arc::new(f.repo.reload_catalog().unwrap());
        f
    }
    fn empty() -> Self {
        let root = std::env::temp_dir().join(format!("catalog-workspace-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let local = root.join("local");
        let shared = root.join("shared");
        fs::create_dir(&local).unwrap();
        fs::create_dir(&shared).unwrap();
        let identity = selected(&local).unwrap();
        let (repo, actor) =
            CollaborationRepository::create_default(&shared, "Catalog", &identity).unwrap();
        Self {
            root,
            local,
            repo: Arc::new(repo),
            actor: Arc::new(actor),
        }
    }
    fn prepare(&self) -> PreparedCatalogMedia {
        let key = uuid::Uuid::new_v4().to_string();
        let source = self.root.join(format!("{key}.wav"));
        let cache = self.root.join(key);
        fs::create_dir(&cache).unwrap();
        let mut b = Vec::new();
        b.extend(b"RIFF");
        b.extend(16036u32.to_le_bytes());
        b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend(8000u32.to_le_bytes());
        b.extend(16000u32.to_le_bytes());
        b.extend(2u16.to_le_bytes());
        b.extend(16u16.to_le_bytes());
        b.extend(b"data");
        b.extend(16000u32.to_le_bytes());
        b.resize(16044, 0);
        fs::write(&source, b).unwrap();
        self.repo
            .prepare_media(&source, &cache, &AtomicBool::new(false))
            .unwrap()
    }
    fn append(&self) -> String {
        let prepared = self.prepare();
        self.repo
            .append_media(&self.actor, &prepared, &AtomicBool::new(false))
            .unwrap()
            .id
    }
    fn open(&self) -> LocalProject {
        LocalProject::open_shared(self.repo.clone(), Some(self.actor.clone()), &self.local).unwrap()
    }
    fn latest(&self) -> Arc<CollaborationRepository> {
        Arc::new(self.repo.reload_catalog().unwrap())
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
fn note(p: &mut LocalProject, id: &str, value: &str) {
    change(
        p,
        Change::UpdateMediaNote {
            media_id: id.into(),
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
fn media_note(p: &LocalProject, id: &str) -> String {
    p.snapshot()
        .unwrap()
        .document
        .media
        .iter()
        .find(|m| m.id == id)
        .unwrap()
        .note
        .clone()
}

#[test]
fn prepared_append_keeps_sequence_barrier_and_installs_without_share_io() {
    let f = Fixture::new();
    let mut p = f.open();
    let added = f.append();
    let current = f.latest();
    let prepared = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare(current.clone())
        .unwrap();
    let mut prefs = p.workspace().unwrap().preferences().clone();
    prefs.volume = 0.31;
    p.workspace_mut().unwrap().save_preferences(prefs).unwrap();
    let d = p.snapshot().unwrap().document;
    assert!(p
        .adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .is_err());
    let prepared = p
        .workspace()
        .unwrap()
        .catalog_source()
        .prepare(current)
        .unwrap();
    let entry = f.repo.root().join("collaboration.json");
    let unavailable = f.repo.root().join("collaboration.offline");
    fs::rename(&entry, &unavailable).unwrap();
    p.adopt_prepared_catalog(&d.project_id, d.revision, prepared)
        .unwrap();
    assert!(p
        .snapshot()
        .unwrap()
        .document
        .media
        .iter()
        .any(|m| m.id == added));
    assert_eq!(p.workspace().unwrap().preferences().volume, 0.31);
    fs::rename(unavailable, entry).unwrap();
}

#[test]
fn adoption_preserves_a_in_flight_b_saved_c_live_and_history_relinks_preferences() {
    let f = Fixture::new();
    let mut p = f.open();
    let id = f.repo.manifest().media[0].id.clone();
    let mut relink = p.snapshot().unwrap().document.media[0].clone();
    relink.source_ref = "C:/private/relinked.wav".into();
    change(&mut p, Change::RelinkMedia { media: relink });
    note(&mut p, &id, "A");
    save(&mut p);
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let captured = capture.payload().clone();
    note(&mut p, &id, "B");
    save(&mut p);
    let mut fixture =
        ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v3.json"))
            .unwrap();
    let mut edit = fixture.edits.remove(0);
    edit.region.media_id = id.clone();
    edit.region.start_seconds = 0.0;
    edit.region.end_seconds = 0.5;
    edit.region.low_hz = 0.0;
    edit.region.high_hz = 3000.0;
    change(&mut p, Change::AddEdit { edit });
    let settings = AnalysisSettings {
        window_size: 1024,
        hop_size: 256,
        ..Default::default()
    };
    change(
        &mut p,
        Change::UpdateAnalysis {
            media_id: id.clone(),
            settings,
        },
    );
    change(
        &mut p,
        Change::UpdatePlaybackMix {
            media_id: id.clone(),
            mix: PlaybackMix {
                muted_channels: vec![0],
                solo_channels: vec![],
            },
        },
    );
    let mut view = p.snapshot().unwrap().document.view_state;
    view.linked_time = true;
    change(&mut p, Change::UpdateViewState { view_state: view });
    save(&mut p);
    let private = p.snapshot().unwrap().document;
    let b = p.workspace().unwrap().envelope().pending.clone();
    note(&mut p, &id, "C");
    let prefs = PlaybackPreferences {
        monitor_gain_db: 0.0,
        media_monitor_gain_db: Default::default(),
        volume: 0.2,
        ..Default::default()
    };
    p.workspace_mut()
        .unwrap()
        .save_preferences(prefs.clone())
        .unwrap();
    let added = f.append();
    adopt(&mut p, f.latest());
    assert_eq!(media_note(&p, &id), "C");
    assert_eq!(p.workspace().unwrap().envelope().pending, b);
    assert_eq!(
        p.snapshot()
            .unwrap()
            .document
            .media
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .source_ref,
        "C:/private/relinked.wav"
    );
    let ack = capture.publish().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert_eq!(p.workspace().unwrap().envelope().confirmed, captured);
    assert_eq!(media_note(&p, &id), "C");
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    assert_eq!(media_note(&p, &id), "B");
    assert!(p
        .snapshot()
        .unwrap()
        .document
        .media
        .iter()
        .any(|m| m.id == added));
    let d = p.snapshot().unwrap().document;
    p.redo(&d.project_id, d.revision).unwrap();
    assert_eq!(media_note(&p, &id), "C");
    drop(p);
    let mut p = LocalProject::open_shared(f.latest(), Some(f.actor.clone()), &f.local).unwrap();
    assert_eq!(media_note(&p, &id), "B");
    assert_eq!(p.workspace().unwrap().preferences(), &prefs);
    let reopened = p.snapshot().unwrap().document;
    assert_eq!(reopened.edits, private.edits);
    assert_eq!(reopened.analysis[&id], private.analysis[&id]);
    assert_eq!(reopened.playback_mix[&id], private.playback_mix[&id]);
    assert_eq!(reopened.view_state, private.view_state);
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let ack = capture.publish().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    assert!(p.workspace().unwrap().envelope().pending.is_none());
    assert_eq!(
        f.latest()
            .read_author(&f.actor.identity().author_id)
            .unwrap()
            .unwrap()
            .payload
            .media_labels
            .iter()
            .find(|m| m.media_id == id)
            .unwrap()
            .note,
        "B"
    );
}

#[test]
fn reopening_adds_defaults_without_rewriting_confirmed_or_republishing_empty_labels() {
    let f = Fixture::new();
    let mut p = f.open();
    let id = f.repo.manifest().media[0].id.clone();
    note(&mut p, &id, "published");
    save(&mut p);
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let ack = capture.publish().unwrap();
    p.workspace_mut().unwrap().acknowledge(ack).unwrap();
    let confirmed = p.workspace().unwrap().envelope().confirmed.clone();
    let base = p.workspace().unwrap().envelope().base.clone();
    drop(p);
    f.append();
    let mut p = LocalProject::open_shared(f.latest(), Some(f.actor.clone()), &f.local).unwrap();
    assert_eq!(p.snapshot().unwrap().document.media.len(), 2);
    assert_eq!(p.workspace().unwrap().envelope().confirmed, confirmed);
    save(&mut p);
    assert_eq!(p.workspace().unwrap().envelope().base, base);
    assert!(p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .is_none());
}

#[test]
fn recovery_candidates_expand_but_still_require_explicit_choice() {
    let f = Fixture::new();
    let mut p = f.open();
    let id = f.repo.manifest().media[0].id.clone();
    note(&mut p, &id, "accepted");
    save(&mut p);
    note(&mut p, &id, "recovery");
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    let d = p.snapshot().unwrap().document;
    assert!(p.save(&d.project_id, d.revision).is_err());
    drop(p);
    f.append();
    let mut p = LocalProject::open_shared(f.latest(), Some(f.actor.clone()), &f.local).unwrap();
    assert!(p.snapshot().is_err());
    assert!(p.workspace_mut().unwrap().prepare_publication().is_err());
    let report = p.recovery().unwrap();
    assert_eq!(report.primary.as_ref().unwrap().media.len(), 2);
    assert_eq!(report.candidates[0].document.media.len(), 2);
    p.resolve_recovery(Some(RecoverySource::Recovery)).unwrap();
    assert_eq!(media_note(&p, &id), "recovery");
    save(&mut p);
}

#[test]
fn hidden_media_is_private_durable_and_not_a_catalog_or_export_filter() {
    let f = Fixture::new();
    let mut p = f.open();
    let id = f.repo.manifest().media[0].id.clone();
    note(&mut p, &id, "keep this label");
    save(&mut p);
    let pending = p.workspace().unwrap().envelope().pending.clone();
    p.workspace_mut()
        .unwrap()
        .set_media_hidden(&id, true)
        .unwrap();
    p.workspace_mut()
        .unwrap()
        .set_media_hidden(&id, true)
        .unwrap();
    assert_eq!(
        p.workspace().unwrap().hidden_media_ids(),
        std::slice::from_ref(&id)
    );
    assert_eq!(p.workspace().unwrap().envelope().pending, pending);
    assert_eq!(
        p.export_document().unwrap().media[0].note,
        "keep this label"
    );
    assert!(p
        .workspace_mut()
        .unwrap()
        .set_media_hidden(&uuid::Uuid::new_v4().to_string(), true)
        .is_err());
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    assert_eq!(p.snapshot().unwrap().document.media.len(), 1);
    assert_eq!(
        p.workspace().unwrap().hidden_media_ids(),
        std::slice::from_ref(&id)
    );
    f.append();
    adopt(&mut p, f.latest());
    drop(p);
    let mut p = LocalProject::open_shared(f.latest(), Some(f.actor.clone()), &f.local).unwrap();
    assert_eq!(
        p.workspace().unwrap().hidden_media_ids(),
        std::slice::from_ref(&id)
    );
    assert_eq!(p.export_document().unwrap().media.len(), 2);
    p.workspace_mut()
        .unwrap()
        .set_media_hidden(&id, false)
        .unwrap();
    assert!(p.workspace().unwrap().hidden_media_ids().is_empty());
}

#[test]
fn v2_view_only_is_explicit_and_guards_every_public_mutation_and_direct_save() {
    let f = Fixture::new();
    assert!(LocalProject::open_shared(f.repo.clone(), None, &f.local).is_err());
    let mut p = LocalProject::open_shared_view_only(f.repo.clone(), &f.local).unwrap();
    assert!(p.workspace().unwrap().is_view_only());
    let d = p.snapshot().unwrap().document;
    let id = d.media[0].id.clone();
    let fixture =
        ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v3.json"))
            .unwrap();
    let mut annotation = fixture.annotations[0].clone();
    annotation.region.media_id = id.clone();
    let category = fixture.categories[0].clone();
    for c in [
        Change::UpdateMediaNote {
            media_id: id.clone(),
            note: "forbidden".into(),
            merge_key: None,
        },
        Change::UpdateChannelNote {
            media_id: id.clone(),
            channel_index: 0,
            note: "forbidden".into(),
            merge_key: None,
        },
        Change::SetMediaCategories {
            media_id: id.clone(),
            category_ids: vec![],
        },
        Change::SetChannelCategories {
            media_id: id.clone(),
            channel_index: 0,
            category_ids: vec![],
        },
        Change::AddCategory {
            category: category.clone(),
        },
        Change::UpdateCategory {
            category: category.clone(),
        },
        Change::RemoveCategory {
            id: category.id.clone(),
        },
        Change::AddAnnotation {
            annotation: annotation.clone(),
        },
        Change::UpdateAnnotation {
            annotation: annotation.clone(),
        },
        Change::UpdateAnnotationNote {
            id: annotation.id.clone(),
            note: "forbidden".into(),
            merge_key: None,
        },
        Change::RemoveAnnotation {
            id: annotation.id.clone(),
        },
        Change::ImportMedia {
            media: d.media[0].clone(),
        },
        Change::RemoveMedia {
            media_id: id.clone(),
        },
    ] {
        assert!(p.apply_change(&d.project_id, d.revision, c).is_err());
        assert_eq!(p.snapshot().unwrap().document, d);
    }
    let mut forged = d.clone();
    forged.media[0].note = "bypass".into();
    assert!(p.workspace_mut().unwrap().save(&forged).is_err());
    assert!(p.initialize_shared_private(forged).is_err());

    let mut edit = fixture.edits[0].clone();
    edit.region.media_id = id.clone();
    edit.region.start_seconds = 0.0;
    edit.region.end_seconds = 0.5;
    edit.region.low_hz = 0.0;
    edit.region.high_hz = 3000.0;
    change(&mut p, Change::AddEdit { edit });
    let mut relink = d.media[0].clone();
    relink.source_ref = "C:/private/view.wav".into();
    change(&mut p, Change::RelinkMedia { media: relink });
    let mut view = d.view_state.clone();
    view.linked_time = true;
    change(&mut p, Change::UpdateViewState { view_state: view });
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    let d = p.snapshot().unwrap().document;
    p.redo(&d.project_id, d.revision).unwrap();
    save(&mut p);
    p.workspace_mut()
        .unwrap()
        .save_preferences(PlaybackPreferences {
            monitor_gain_db: 0.0,
            media_monitor_gain_db: Default::default(),
            volume: 0.1,
            ..Default::default()
        })
        .unwrap();
    p.workspace_mut()
        .unwrap()
        .set_media_hidden(&id, true)
        .unwrap();
    assert!(p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .is_none());
    assert!(f
        .repo
        .read_author(&f.actor.identity().author_id)
        .unwrap()
        .is_none());
    drop(p);
    let p = LocalProject::open_shared_view_only(f.repo.clone(), &f.local).unwrap();
    assert_eq!(p.snapshot().unwrap().document.edits.len(), 1);
    assert_eq!(p.workspace().unwrap().preferences().volume, 0.1);
}

#[test]
fn clean_adoption_stays_saved_and_remembered_layers_accept_new_catalog() {
    let f = Fixture::new();
    let mut p = f.open();
    let mut layers = RememberedLayers::new(f.repo.manifest().clone());
    layers.update(f.repo.snapshot().unwrap()).unwrap();
    f.append();
    let latest = f.latest();
    adopt(&mut p, latest.clone());
    assert_eq!(
        p.snapshot().unwrap().document,
        p.workspace().unwrap().envelope().document
    );
    assert_eq!(
        p.persisted_revision(),
        p.snapshot().unwrap().document.revision
    );
    layers.adopt_catalog(latest.manifest().clone()).unwrap();
    let mut payload =
        LayerPayload::from_document(&latest.manifest().base_document().unwrap()).unwrap();
    payload
        .media_labels
        .iter_mut()
        .find(|m| m.media_id != f.repo.manifest().media[0].id)
        .unwrap()
        .note = "new media label".into();
    latest.publish(&f.actor, None, &payload).unwrap();
    layers.update(latest.snapshot().unwrap()).unwrap();
    assert_eq!(
        layers.snapshot().authors[0].layer.as_ref().unwrap().payload,
        payload
    );
}

#[test]
fn adopted_catalog_cannot_substitute_existing_metadata_or_project_identity() {
    let f = Fixture::new();
    let mut p = f.open();
    let before = p.snapshot().unwrap();
    let record = f
        .repo
        .root()
        .join("catalog")
        .join(format!("{}.json", f.repo.manifest().media[0].id));
    let bytes = fs::read(&record).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["media"]["displayName"] = "substituted".into();
    fs::write(&record, serde_json::to_vec(&value).unwrap()).unwrap();
    let changed = Arc::new(CollaborationRepository::open(f.repo.root()).unwrap());
    assert!(p
        .adopt_shared_catalog(
            &before.document.project_id,
            before.document.revision,
            changed.clone()
        )
        .is_err());
    assert_eq!(p.snapshot().unwrap(), before);
    drop(p);
    assert!(LocalProject::open_shared(changed, Some(f.actor.clone()), &f.local).is_err());
    fs::write(record, bytes).unwrap();
    let mut p = f.open();
    let other = Fixture::new();
    assert!(p
        .adopt_shared_catalog(
            &before.document.project_id,
            before.document.revision,
            other.repo.clone()
        )
        .is_err());
    assert_eq!(p.snapshot().unwrap(), before);
}

#[test]
fn failed_adoption_keeps_live_history_and_ack_then_reopens_with_recovery_gate() {
    let f = Fixture::new();
    let mut p = f.open();
    let id = f.repo.manifest().media[0].id.clone();
    note(&mut p, &id, "A");
    save(&mut p);
    let capture = p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .unwrap();
    let captured = capture.payload().clone();
    note(&mut p, &id, "unsaved");
    let before = p.snapshot().unwrap();
    f.append();
    p.workspace_mut()
        .unwrap()
        .inject_fault(Some(WorkspaceFault::MainReplace));
    assert!(p
        .adopt_shared_catalog(
            &before.document.project_id,
            before.document.revision,
            f.latest()
        )
        .is_err());
    assert_eq!(p.snapshot().unwrap(), before);
    assert_eq!(p.workspace().unwrap().manifest().media.len(), 1);
    p.workspace_mut().unwrap().inject_fault(None);
    let ack = capture.publish().unwrap();
    // Crash before ack: recovery proposal has the exact admitted payload, not a rewritten hash.
    drop(ack);
    drop(p);
    let mut p = LocalProject::open_shared(f.latest(), Some(f.actor.clone()), &f.local).unwrap();
    assert!(p.recovery().is_some());
    assert!(p.snapshot().is_err());
    p.resolve_recovery(Some(RecoverySource::Recovery)).unwrap();
    let remote = f
        .latest()
        .read_author(&f.actor.identity().author_id)
        .unwrap();
    p.workspace_mut()
        .unwrap()
        .observe_remote(remote.as_ref())
        .unwrap();
    assert_eq!(p.workspace().unwrap().envelope().confirmed, captured);
    assert!(p
        .workspace_mut()
        .unwrap()
        .prepare_publication()
        .unwrap()
        .is_none());
    assert_eq!(media_note(&p, &id), "A");
}

#[test]
fn reopen_rejects_replaced_public_source_path_even_after_private_relink() {
    let f = Fixture::new();
    let mut p = f.open();
    let mut media = p.snapshot().unwrap().document.media[0].clone();
    media.source_ref = "C:/private/relinked.wav".into();
    change(&mut p, Change::RelinkMedia { media });
    save(&mut p);
    drop(p);
    let old = &f.repo.manifest().media[0];
    let record = f
        .repo
        .root()
        .join("catalog")
        .join(format!("{}.json", old.id));
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    let replacement = format!("media/{}.flac", old.id);
    fs::copy(
        f.repo.root().join(&old.source_ref),
        f.repo.root().join(&replacement),
    )
    .unwrap();
    value["media"]["sourceRef"] = replacement.into();
    fs::write(record, serde_json::to_vec(&value).unwrap()).unwrap();
    let changed = Arc::new(CollaborationRepository::open(f.repo.root()).unwrap());
    assert!(
        LocalProject::open_shared(changed, Some(f.actor.clone()), &f.local).is_err(),
        "Private relinks must not erase immutable public catalog authority"
    );
}

#[test]
fn deterministic_uuid_insertion_before_old_media_preserves_labels_and_redo() {
    let mut f = Fixture::empty();
    let a = f.prepare();
    let b = f.prepare();
    let (first, later) = if a.media().id > b.media().id {
        (a, b)
    } else {
        (b, a)
    };
    f.repo
        .append_media(&f.actor, &first, &AtomicBool::new(false))
        .unwrap();
    f.repo = f.latest();
    let id = first.media().id.clone();
    let mut p = f.open();
    note(&mut p, &id, "kept");
    save(&mut p);
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    f.repo
        .append_media(&f.actor, &later, &AtomicBool::new(false))
        .unwrap();
    adopt(&mut p, f.latest());
    assert_eq!(p.snapshot().unwrap().document.media[0].id, later.media().id);
    let d = p.snapshot().unwrap().document;
    p.redo(&d.project_id, d.revision).unwrap();
    assert_eq!(media_note(&p, &id), "kept");
    assert_eq!(media_note(&p, &later.media().id), "");
    save(&mut p);
    drop(p);
    let p = LocalProject::open_shared(f.latest(), Some(f.actor.clone()), &f.local).unwrap();
    assert_eq!(media_note(&p, &id), "kept");
}

#[test]
fn unchanged_catalog_adoption_is_idempotent_and_stale_barriers_still_fail() {
    let f = Fixture::new();
    let mut p = f.open();
    let before = p.snapshot().unwrap();
    let envelope = p.workspace().unwrap().envelope().clone();
    adopt(&mut p, f.latest());
    assert_eq!(p.snapshot().unwrap(), before);
    assert_eq!(p.workspace().unwrap().envelope(), &envelope);
    let added = f.append();
    adopt(&mut p, f.latest());
    let after = p.snapshot().unwrap();
    assert!(after.document.media.iter().any(|m| m.id == added));
    assert!(p
        .adopt_shared_catalog(
            &before.document.project_id,
            before.document.revision,
            f.latest()
        )
        .is_err());
    assert_eq!(p.snapshot().unwrap(), after);
}

#[test]
fn hidden_preferences_and_view_only_cache_are_validated_on_reopen() {
    let f = Fixture::new();
    let p = LocalProject::open_shared_view_only(f.repo.clone(), &f.local).unwrap();
    let root = p.storage_root().to_owned();
    let bytes = fs::read(root.join("workspace.json")).unwrap();
    drop(p);
    let valid: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let id = f.repo.manifest().media[0].id.clone();
    let mut unknown = valid.clone();
    unknown["hiddenMediaIds"] = serde_json::json!([uuid::Uuid::new_v4().to_string()]);
    let mut duplicate = valid.clone();
    duplicate["hiddenMediaIds"] = serde_json::json!([id, id]);
    let mut excessive = valid.clone();
    excessive["hiddenMediaIds"] = serde_json::json!(vec![id; 4097]);
    let mut forged = valid;
    forged["document"]["media"][0]["note"] = "forbidden".into();
    forged["confirmed"]["mediaLabels"][0]["note"] = "forbidden".into();
    for bad in [unknown, duplicate, excessive, forged] {
        for name in ["workspace.json", "workspace.recovery.json"] {
            fs::write(root.join(name), serde_json::to_vec(&bad).unwrap()).unwrap();
        }
        assert!(LocalProject::open_shared_view_only(f.repo.clone(), &f.local).is_err());
    }
}
#[test]
fn folder_only_commits_preserve_private_draft_history_and_catalog_revision() {
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new();
    let mut p = f.open();
    let media_id = f.repo.manifest().media[0].id.clone();
    note(&mut p, &media_id, "saved");
    save(&mut p);
    note(&mut p, &media_id, "live draft");
    let before = p.snapshot().unwrap();
    let catalog = f.repo.catalog_revision().cloned();
    let folder = uuid::Uuid::new_v4().to_string();
    let created = f
        .repo
        .apply_organization(
            &f.actor,
            f.repo.organization().revision,
            OrganizationOperation::CreateFolder {
                id: folder.clone(),
                parent_id: None,
                name: "Shared folder".into(),
            },
        )
        .unwrap();
    f.repo
        .apply_organization(
            &f.actor,
            created.revision,
            OrganizationOperation::MoveMedia {
                media_id: media_id.clone(),
                folder_id: Some(folder),
            },
        )
        .unwrap();
    assert_eq!(p.snapshot().unwrap(), before);
    assert_eq!(
        f.repo.reload_catalog().unwrap().catalog_revision(),
        catalog.as_ref()
    );
    let d = p.snapshot().unwrap().document;
    p.undo(&d.project_id, d.revision).unwrap();
    assert_eq!(media_note(&p, &media_id), "saved");
}

#[test]
fn batch_visibility_is_atomic_and_retains_existing_preferences() {
    let mut f = Fixture::new();
    let first = f.repo.manifest().media[0].id.clone();
    let second = f.append();
    f.repo = f.latest();
    let mut p = f.open();
    let before = p.snapshot().unwrap().document;
    p.workspace_mut()
        .unwrap()
        .set_media_hidden_batch(vec![first.clone(), second.clone()], true)
        .unwrap();
    assert_eq!(p.workspace().unwrap().hidden_media_ids().len(), 2);
    assert!(p
        .workspace_mut()
        .unwrap()
        .set_media_hidden_batch(vec![first.clone(), uuid::Uuid::new_v4().to_string()], false)
        .is_err());
    assert_eq!(p.workspace().unwrap().hidden_media_ids().len(), 2);
    p.workspace_mut()
        .unwrap()
        .set_media_hidden_batch(vec![first, second], false)
        .unwrap();
    assert!(p.workspace().unwrap().hidden_media_ids().is_empty());
    assert_eq!(p.snapshot().unwrap().document, before);
}
