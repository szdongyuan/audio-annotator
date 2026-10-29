use annotator_core::{
    collaboration::{
        profiles::Profile, purge::transaction::PurgeSelection, recycle::RecycleOperation, *,
    },
    error::ErrorCode,
    project::LocalProject,
};
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[test]
fn direct_shared_save_as_converges_retirement_before_target_side_effects() {
    let root = std::env::temp_dir().join(format!("purge-exchange-{}", id()));
    for name in ["shared", "target", "local"] {
        fs::create_dir_all(root.join(name)).unwrap();
    }
    let (repo, actor) = CollaborationRepository::create_default(
        &root.join("shared"),
        "Copy",
        &Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let cancel = AtomicBool::new(false);
    let audio =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    for _ in 0..2 {
        let p = repo
            .prepare_media(&audio, &root.join("pcm"), &cancel)
            .unwrap();
        repo.append_media(&actor, &p, &cancel).unwrap();
    }
    let repo = Arc::new(repo.reload_catalog().unwrap());
    let actor = Arc::new(actor);
    let mut project =
        LocalProject::open_shared(repo.clone(), Some(actor.clone()), &root.join("local")).unwrap();
    let initial = project.snapshot().unwrap().document;
    project
        .apply_change(
            &initial.project_id,
            initial.revision,
            annotator_core::model::Change::UpdateMediaNote {
                media_id: initial.media[0].id.clone(),
                note: "Retired note".into(),
                merge_key: None,
            },
        )
        .unwrap();
    let old = project.snapshot().unwrap().document;
    let original_bytes = fs::read(&audio).unwrap();
    let external_zip = root.join("existing.zip");
    annotator_core::exchange::export_bundle(
        &old,
        repo.root(),
        &external_zip,
        &cancel,
        annotator_core::exchange::Limits::default(),
        |_, _| {},
    )
    .unwrap();
    let zip_bytes = fs::read(&external_zip).unwrap();
    let independent = annotator_core::exchange::import_exchange(
        &external_zip,
        &root,
        &cancel,
        annotator_core::exchange::Limits::default(),
        |_, _| {},
    )
    .unwrap();
    let independent_json = fs::read(independent.path.join("project.json")).unwrap();
    let retired = old.media[0].id.clone();
    repo.apply_recycle_controlled(
        &actor,
        0,
        RecycleOperation {
            operation_id: id(),
            media_ids: vec![retired.clone()],
            trash: true,
        },
        &cancel,
        || Ok(()),
    )
    .unwrap();
    let preview = repo
        .preview_purge(&actor, "test", &id(), PurgeSelection::All)
        .unwrap();
    repo.commit_purge(&actor, "test", &preview, &cancel)
        .unwrap();
    // Logical commit alone leaves pending physical cleanup, including the old audio.
    assert!(root.join("shared").join(&old.media[0].source_ref).exists());
    let result = project.save_as(&root.join("target"), &old.project_id, old.revision);
    assert!(result.is_err(), "stale Save As accepted a retired UUID");
    assert_eq!(result.unwrap_err().code, ErrorCode::RevisionConflict);
    assert_eq!(fs::read_dir(root.join("target")).unwrap().count(), 0);
    let current = project.snapshot().unwrap().document;
    assert_eq!(current.media.len(), 1);
    assert!(!serde_json::to_string(&current).unwrap().contains(&retired));
    // Stale exchange layers, relinks and copy descriptors cannot reinstall the
    // source UUID. Ordinary external import still creates an independent ID.
    let fresh = CollaborationRepository::open(repo.root()).unwrap();
    assert!(fresh
        .publish(&actor, None, &LayerPayload::from_document(&old).unwrap())
        .is_err());
    let mut relink = old.media[0].clone();
    relink.source_ref = audio.to_string_lossy().into();
    assert!(project
        .apply_change(
            &current.project_id,
            current.revision,
            annotator_core::model::Change::RelinkMedia { media: relink }
        )
        .is_err());
    let stale_copy = fresh
        .prepare_media_copy(&audio, &root.join("pcm"), &cancel, &old.media[0], |_, _| {})
        .unwrap();
    assert!(fresh.append_media(&actor, &stale_copy, &cancel).is_err());
    let imported = fresh
        .prepare_media(&audio, &root.join("pcm"), &cancel)
        .unwrap();
    assert_ne!(imported.media().id, retired);
    fresh.append_media(&actor, &imported, &cancel).unwrap();
    project
        .save_as(&root.join("target"), &current.project_id, current.revision)
        .unwrap();
    let copied = project.snapshot().unwrap().document;
    assert_eq!(copied.media[0].id, old.media[1].id);
    assert_eq!(
        fs::read(&copied.media[0].source_ref).unwrap(),
        fs::read(&audio).unwrap()
    );
    assert_eq!(fs::read(&audio).unwrap(), original_bytes);
    assert_eq!(fs::read(&external_zip).unwrap(), zip_bytes);
    assert_eq!(
        fs::read(independent.path.join("project.json")).unwrap(),
        independent_json
    );
    assert_eq!(independent.document.media.len(), 2);
    drop((project, repo, actor, imported, fresh, stale_copy));
    fs::remove_dir_all(root).unwrap();
}
