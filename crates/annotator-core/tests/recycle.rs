use annotator_core::{
    collaboration::{
        profiles::Profile, recycle::RecycleOperation, CollaborationRepository, LayerPayload,
    },
    error::AppError,
};
use std::{fs, sync::atomic::AtomicBool};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
#[test]
fn shared_recycle_preserves_catalog_audio_and_layers_and_retries_safely() {
    let root = std::env::temp_dir().join(format!("recycle-test-{}", id()));
    fs::create_dir(&root).unwrap();
    let (repo, alice) =
        CollaborationRepository::create_default(&root, "Recycle", &Profile::new("Alice").unwrap())
            .unwrap();
    let bob = repo.adopt(&Profile::new("Bob").unwrap()).unwrap();
    let cancel = AtomicBool::new(false);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let prepared = repo
        .prepare_media(&source, &root.join("pcm"), &cancel)
        .unwrap();
    repo.append_media(&alice, &prepared, &cancel).unwrap();
    let repo = repo.reload_catalog().unwrap();
    let mut doc = repo.manifest().base_document().unwrap();
    doc.media[0].note = "Alice note".into();
    repo.publish(&alice, None, &LayerPayload::from_document(&doc).unwrap())
        .unwrap();
    doc.media[0].note = "Bob note".into();
    repo.publish(&bob, None, &LayerPayload::from_document(&doc).unwrap())
        .unwrap();
    let before = repo.snapshot().unwrap();
    let audio_path = root.join(&repo.manifest().media[0].source_ref);
    let audio = fs::read(&audio_path).unwrap();
    let layout = fs::read(root.join("organization.json")).unwrap();
    let catalog = fs::read(root.join("collaboration.json")).unwrap();
    let operation = RecycleOperation {
        operation_id: id(),
        media_ids: vec![prepared.media().id.clone()],
        trash: true,
    };
    assert_eq!(repo.read_recycle().unwrap().revision, 0);
    assert!(repo
        .apply_recycle_controlled(&alice, 0, operation.clone(), &cancel, || Err::<(), _>(
            AppError::invalid("owner replaced")
        ))
        .is_err());
    assert_eq!(repo.read_recycle().unwrap().revision, 0);
    repo.apply_recycle_controlled(&alice, 0, operation.clone(), &cancel, || Ok(()))
        .unwrap();
    let mut exported = doc.clone();
    repo.read_recycle().unwrap().filter_export(&mut exported);
    exported.validate().unwrap();
    assert!(exported.media.is_empty());
    assert_eq!(doc.media.len(), 1);
    let other = CollaborationRepository::open(&root).unwrap();
    assert_eq!(other.read_recycle().unwrap().trashed.len(), 1);
    let restore = RecycleOperation {
        operation_id: id(),
        trash: false,
        ..operation.clone()
    };
    assert!(other
        .apply_recycle_controlled(&bob, 0, restore.clone(), &cancel, || Ok(()))
        .is_err());
    other
        .apply_recycle_controlled(&bob, 1, restore, &cancel, || Ok(()))
        .unwrap();
    assert!(repo
        .apply_recycle_controlled(&alice, 0, operation, &cancel, || Ok(()))
        .unwrap()
        .trashed
        .is_empty());
    assert_eq!(audio, fs::read(audio_path).unwrap());
    assert_eq!(layout, fs::read(root.join("organization.json")).unwrap());
    assert_eq!(catalog, fs::read(root.join("collaboration.json")).unwrap());
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(repo.snapshot().unwrap()).unwrap()
    );
    fs::write(root.join("recycle.json"), b"broken").unwrap();
    assert!(repo.read_recycle().is_err());
    assert_eq!(fs::read(root.join("recycle.json")).unwrap(), b"broken");
    drop((prepared, alice, bob, repo, other));
    fs::remove_dir_all(root).unwrap();
}
