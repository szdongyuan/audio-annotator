use annotator_core::{
    error::ErrorCode,
    model::*,
    project::{FaultPoint, FileStore, RecoverySource},
};
use std::{fs, path::PathBuf};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("annotator-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn document(revision: u64) -> ProjectDocument {
    let mut d =
        ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v2.json"))
            .unwrap();
    d.revision = revision;
    d.playback_mix
        .get_mut(&d.media[0].id)
        .unwrap()
        .solo_channels = vec![1];
    d.playback_mix
        .get_mut(&d.media[0].id)
        .unwrap()
        .muted_channels = vec![0];
    d
}

#[test]
fn save_reopen_preserves_mix_and_os_lock_releases() {
    let dir = Temp::new();
    let mut store = FileStore::create(&dir.0, &document(0)).unwrap();
    assert_eq!(
        FileStore::open(&dir.0).err().unwrap().code,
        ErrorCode::ProjectLocked
    );
    store.save(&document(1)).unwrap();
    assert_eq!(store.persisted_revision(), 1);
    drop(store);
    let (store, loaded) = FileStore::open(&dir.0).unwrap();
    assert_eq!(loaded.primary.unwrap(), document(1));
    assert!(loaded.candidates.is_empty());
    assert_eq!(store.persisted_revision(), 1);
}

#[test]
fn corruption_offers_verified_backup_without_overwriting_main() {
    let dir = Temp::new();
    let mut store = FileStore::create(&dir.0, &document(0)).unwrap();
    store.save(&document(1)).unwrap();
    drop(store);
    fs::write(dir.0.join("project.json"), b"broken").unwrap();
    let (_, loaded) = FileStore::open(&dir.0).unwrap();
    assert!(loaded.primary.is_none());
    assert!(loaded
        .candidates
        .iter()
        .any(|c| c.source == RecoverySource::Backup && c.document == document(0)));
    assert_eq!(fs::read(dir.0.join("project.json")).unwrap(), b"broken");
}

#[test]
fn every_failed_boundary_keeps_primary_and_exposes_newer_recovery() {
    for point in [
        FaultPoint::RecoveryWrite,
        FaultPoint::RecoverySync,
        FaultPoint::RecoveryReplace,
        FaultPoint::BackupWrite,
        FaultPoint::BackupSync,
        FaultPoint::BackupReplace,
        FaultPoint::MainWrite,
        FaultPoint::MainSync,
        FaultPoint::MainReplace,
    ] {
        let dir = Temp::new();
        let mut store = FileStore::create(&dir.0, &document(0)).unwrap();
        store.inject_fault(Some(point));
        assert!(store.save(&document(1)).is_err(), "{point:?}");
        assert_eq!(store.persisted_revision(), 0);
        assert_eq!(
            ProjectDocument::from_json(&fs::read_to_string(dir.0.join("project.json")).unwrap())
                .unwrap(),
            document(0)
        );
        drop(store);
        let (_, loaded) = FileStore::open(&dir.0).unwrap();
        let published_recovery = !matches!(
            point,
            FaultPoint::RecoveryWrite | FaultPoint::RecoverySync | FaultPoint::RecoveryReplace
        );
        assert_eq!(
            loaded
                .candidates
                .iter()
                .any(|c| c.source == RecoverySource::Recovery && c.document == document(1)),
            published_recovery
        );
        assert!(!fs::read_dir(&dir.0).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }
}

#[test]
fn invalid_checksum_and_foreign_recovery_are_never_offered() {
    let dir = Temp::new();
    let mut store = FileStore::create(&dir.0, &document(0)).unwrap();
    store.inject_fault(Some(FaultPoint::MainReplace));
    assert!(store.save(&document(2)).is_err());
    drop(store);
    let p = dir.0.join("recovery.json");
    let mut envelope: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    envelope["checksum"] = "invalid".into();
    fs::write(&p, serde_json::to_vec(&envelope).unwrap()).unwrap();
    let (_, loaded) = FileStore::open(&dir.0).unwrap();
    assert!(!loaded
        .candidates
        .iter()
        .any(|c| c.source == RecoverySource::Recovery));
}

#[test]
fn valid_checksum_from_another_project_is_not_a_recovery_candidate() {
    let dir = Temp::new();
    let foreign = Temp::new();
    drop(FileStore::create(&dir.0, &document(0)).unwrap());
    let mut other = document(5);
    other.project_id = uuid::Uuid::new_v4().to_string();
    drop(FileStore::create(&foreign.0, &other).unwrap());
    fs::copy(foreign.0.join("recovery.json"), dir.0.join("recovery.json")).unwrap();
    let (_, loaded) = FileStore::open(&dir.0).unwrap();
    assert!(loaded.candidates.is_empty());
}

#[test]
fn explicit_recovery_publishes_selected_revision_and_reopens() {
    use annotator_core::project::LocalProject;
    let dir = Temp::new();
    let mut store = FileStore::create(&dir.0, &document(0)).unwrap();
    store.inject_fault(Some(FaultPoint::MainReplace));
    assert!(store.save(&document(2)).is_err());
    drop(store);
    let mut p = LocalProject::open(&dir.0).unwrap();
    p.resolve_recovery(Some(RecoverySource::Recovery)).unwrap();
    assert_eq!(p.persisted_revision(), 2);
    drop(p);
    let p = LocalProject::open(&dir.0).unwrap();
    assert_eq!(p.snapshot().unwrap().document, document(2));
    assert!(p.recovery().is_none());
}

#[test]
fn large_but_supported_envelope_remains_readable() {
    let dir = Temp::new();
    let mut doc = document(0);
    doc.media[0].note = "\"".repeat(7 * 1024 * 1024);
    drop(FileStore::create(&dir.0, &doc).unwrap());
    let (_, loaded) = FileStore::open(&dir.0).unwrap();
    assert_eq!(loaded.primary.unwrap(), doc);
}

#[test]
fn create_never_overwrites_an_existing_project() {
    let dir = Temp::new();
    drop(FileStore::create(&dir.0, &document(0)).unwrap());
    assert!(FileStore::create(&dir.0, &document(1)).is_err());
    assert_eq!(
        ProjectDocument::from_json(&fs::read_to_string(dir.0.join("project.json")).unwrap())
            .unwrap(),
        document(0)
    );
}

#[test]
fn local_session_save_failure_keeps_memory_and_close_requires_saved_revision() {
    use annotator_core::project::LocalProject;
    let dir = Temp::new();
    let mut p = LocalProject::create(&dir.0, "本地项目".into()).unwrap();
    let id = p.snapshot().unwrap().document.project_id;
    p.session_mut()
        .unwrap()
        .apply_change(
            &id,
            0,
            Change::AddCategory {
                category: Category {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: "异常".into(),
                    color: "#aabbcc".into(),
                },
            },
        )
        .unwrap();
    p.store_mut().inject_fault(Some(FaultPoint::MainReplace));
    assert!(p.save(&id, 1).is_err());
    assert_eq!(p.snapshot().unwrap().document.categories.len(), 1);
    assert!(p.prepare_close(&id, 1, false).is_err());
    p.store_mut().inject_fault(None);
    p.save(&id, 1).unwrap();
    assert!(p.prepare_close(&id, 0, false).is_err());
    p.prepare_close(&id, 1, false).unwrap();
}

#[test]
fn recovery_requires_a_choice_and_keep_primary_survives_reopen() {
    use annotator_core::project::LocalProject;
    let dir = Temp::new();
    let mut store = FileStore::create(&dir.0, &document(0)).unwrap();
    store.inject_fault(Some(FaultPoint::MainReplace));
    assert!(store.save(&document(1)).is_err());
    drop(store);
    let mut p = LocalProject::open(&dir.0).unwrap();
    assert!(p.snapshot().is_err());
    p.resolve_recovery(None).unwrap();
    assert_eq!(p.snapshot().unwrap().document.revision, 0);
    drop(p);
    assert!(LocalProject::open(&dir.0).unwrap().recovery().is_none());
}

#[test]
fn oversized_encoding_is_rejected_before_any_existing_file_changes() {
    let dir = Temp::new();
    let mut store = FileStore::create(&dir.0, &document(0)).unwrap();
    let main_before = fs::read(dir.0.join("project.json")).unwrap();
    let recovery_before = fs::read(dir.0.join("recovery.json")).unwrap();
    let mut large = document(1);
    // Escaping makes the envelope larger than the underlying document.
    large.media[0].note = "\"".repeat(9 * 1024 * 1024);
    assert!(large.validate().is_ok());
    assert_eq!(
        store.save(&large).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(fs::read(dir.0.join("project.json")).unwrap(), main_before);
    assert_eq!(
        fs::read(dir.0.join("recovery.json")).unwrap(),
        recovery_before
    );
    assert_eq!(store.persisted_revision(), 0);
}

#[test]
fn save_as_preserves_history_and_rebases_relative_media_in_undo() {
    use annotator_core::project::LocalProject;
    let source = Temp::new();
    let target = Temp::new();
    drop(FileStore::create(&source.0, &document(0)).unwrap());
    let mut project = LocalProject::open(&source.0).unwrap();
    let original = project.snapshot().unwrap().document;
    project
        .session_mut()
        .unwrap()
        .apply_change(
            &original.project_id,
            0,
            Change::UpdateMediaNote {
                media_id: original.media[0].id.clone(),
                note: "new".into(),
                merge_key: None,
            },
        )
        .unwrap();
    project.save_as(&target.0, &original.project_id, 1).unwrap();
    assert!(project.snapshot().unwrap().can_undo);
    let restored = project
        .session_mut()
        .unwrap()
        .undo(&original.project_id, 1)
        .unwrap();
    assert_eq!(restored.document.media[0].note, original.media[0].note);
    assert_eq!(
        restored.document.media[0].source_ref,
        source
            .0
            .canonicalize()
            .unwrap()
            .join(&original.media[0].source_ref)
            .to_string_lossy()
    );
}

#[test]
fn explicit_discard_closes_despite_persistent_recovery_write_failures() {
    use annotator_core::project::LocalProject;
    for point in [
        FaultPoint::RecoveryWrite,
        FaultPoint::RecoverySync,
        FaultPoint::RecoveryReplace,
    ] {
        let dir = Temp::new();
        drop(FileStore::create(&dir.0, &document(0)).unwrap());
        let primary_before = fs::read(dir.0.join("project.json")).unwrap();
        let mut p = LocalProject::open(&dir.0).unwrap();
        let d = p.snapshot().unwrap().document;
        p.session_mut()
            .unwrap()
            .apply_change(
                &d.project_id,
                0,
                Change::UpdateMediaNote {
                    media_id: d.media[0].id.clone(),
                    note: "explicitly discarded".into(),
                    merge_key: None,
                },
            )
            .unwrap();
        // Leave a newer valid recovery, then keep storage broken through discard.
        p.store_mut().inject_fault(Some(FaultPoint::MainReplace));
        assert!(p.save(&d.project_id, 1).is_err());
        p.store_mut().inject_fault(Some(point));
        assert!(p.save(&d.project_id, 1).is_err());
        assert!(p.prepare_close(&d.project_id, 1, false).is_err());
        p.prepare_close(&d.project_id, 1, true).unwrap();
        assert_eq!(
            fs::read(dir.0.join("project.json")).unwrap(),
            primary_before
        );
        drop(p);
        let p = LocalProject::open(&dir.0).unwrap();
        assert!(
            p.snapshot().is_err(),
            "leftover recovery must never silently resurrect discarded edits"
        );
        assert!(p
            .recovery()
            .unwrap()
            .candidates
            .iter()
            .any(|c| c.document.revision == 1));
    }
}

#[test]
fn explicit_discard_does_not_require_a_valid_primary() {
    use annotator_core::project::LocalProject;
    let dir = Temp::new();
    drop(FileStore::create(&dir.0, &document(0)).unwrap());
    let mut p = LocalProject::open(&dir.0).unwrap();
    let d = p.snapshot().unwrap().document;
    p.session_mut()
        .unwrap()
        .apply_change(
            &d.project_id,
            0,
            Change::UpdateMediaNote {
                media_id: d.media[0].id.clone(),
                note: "discard this memory".into(),
                merge_key: None,
            },
        )
        .unwrap();
    fs::write(dir.0.join("project.json"), b"corrupted outside session").unwrap();
    p.store_mut().inject_fault(Some(FaultPoint::RecoveryWrite));
    assert!(p.save(&d.project_id, 1).is_err());
    assert!(p.prepare_close(&d.project_id, 1, false).is_err());
    p.prepare_close(&d.project_id, 1, true).unwrap();
    assert_eq!(
        fs::read(dir.0.join("project.json")).unwrap(),
        b"corrupted outside session"
    );
    drop(p);
    let p = LocalProject::open(&dir.0).unwrap();
    assert!(p.snapshot().is_err());
    assert!(p.recovery().is_some());
}

#[test]
fn unsupported_primary_is_rejected_without_changing_project_or_recovery_bytes() {
    for version in [1, 3] {
        let dir = Temp::new();
        drop(FileStore::create(&dir.0, &document(0)).unwrap());
        let recovery = fs::read(dir.0.join("recovery.json")).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/document-v1.json")).unwrap();
        value["formatVersion"] = serde_json::json!(version);
        let raw = value.to_string();
        fs::write(dir.0.join("project.json"), &raw).unwrap();
        assert_eq!(
            FileStore::open(&dir.0).err().unwrap().code,
            ErrorCode::UnsupportedVersion
        );
        assert_eq!(fs::read_to_string(dir.0.join("project.json")).unwrap(), raw);
        assert_eq!(fs::read(dir.0.join("recovery.json")).unwrap(), recovery);
    }
}

#[test]
fn classifications_and_compare_preferences_survive_save_and_reopen() {
    use annotator_core::{
        model::{Change, CompareLayout},
        project::LocalProject,
    };
    let dir = Temp::new();
    drop(FileStore::create(&dir.0, &document(0)).unwrap());
    let mut p = LocalProject::open(&dir.0).unwrap();
    let d = p.snapshot().unwrap().document;
    let category = Some(d.categories[0].id.clone());
    p.session_mut()
        .unwrap()
        .apply_change(
            &d.project_id,
            0,
            Change::SetMediaCategory {
                media_id: d.media[0].id.clone(),
                category_id: category.clone(),
            },
        )
        .unwrap();
    p.session_mut()
        .unwrap()
        .apply_change(
            &d.project_id,
            1,
            Change::SetChannelCategory {
                media_id: d.media[0].id.clone(),
                channel_index: 0,
                category_id: category,
            },
        )
        .unwrap();
    let mut view = d.view_state.clone();
    view.compare_layout = CompareLayout::Vertical;
    view.compare_split = 0.25;
    p.session_mut()
        .unwrap()
        .apply_change(
            &d.project_id,
            2,
            Change::UpdateViewState { view_state: view },
        )
        .unwrap();
    let expected = p.snapshot().unwrap().document;
    p.save(&d.project_id, 3).unwrap();
    drop(p);
    let p = LocalProject::open(&dir.0).unwrap();
    assert_eq!(p.snapshot().unwrap().document, expected);
}
