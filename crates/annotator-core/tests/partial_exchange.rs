use annotator_core::{
    collaboration::{profiles::Profile, CollaborationRepository, LayerPayload},
    exchange::*,
    media::{decode::decode, identity::fingerprint},
    model::*,
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("partial-exchange-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn cancel() -> AtomicBool {
    AtomicBool::new(false)
}
fn source(root: &Path) -> ProjectDocument {
    let mut doc = ProjectDocument::create("部分分享".into()).unwrap();
    for name in ["mono16.wav", "six.flac"] {
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/audio")
            .join(name)
            .canonicalize()
            .unwrap();
        doc.media.push(
            decode(&p, &root.join("pcm"), &cancel(), |_, _| {})
                .unwrap()
                .descriptor,
        );
    }
    let c = Category {
        id: uuid::Uuid::new_v4().to_string(),
        name: "NG".into(),
        color: "#ff0000".into(),
    };
    doc.categories.push(c.clone());
    doc.categories.push(Category {
        id: uuid::Uuid::new_v4().to_string(),
        name: "OK".into(),
        color: "#00ff00".into(),
    });
    doc.media[0].note = "整段备注".into();
    doc.media[0].category_ids = vec![c.id.clone()];
    doc.media[0].channel_notes[0] = "通道备注".into();
    doc.annotations.push(Annotation {
        id: uuid::Uuid::new_v4().to_string(),
        region: Region {
            media_id: doc.media[0].id.clone(),
            channel_index: 0,
            start_seconds: 0.0,
            end_seconds: 0.05,
            low_hz: 100.0,
            high_hz: 500.0,
        },
        category_ids: vec![c.id],
        note: "区域备注".into(),
        created_at: doc.created_at.clone(),
        updated_at: doc.created_at.clone(),
    });
    for m in &doc.media {
        doc.analysis.insert(m.id.clone(), Default::default());
        doc.playback_mix.insert(m.id.clone(), Default::default());
    }
    doc.validate().unwrap();
    doc
}
fn portable(doc: &ProjectDocument) -> Vec<PortableAuthor> {
    ["Alice", "Bob"]
        .into_iter()
        .map(|name| PortableAuthor {
            identity: Profile::new(name).unwrap().into(),
            payload: LayerPayload::from_document(doc).unwrap(),
        })
        .collect()
}
fn blank_labels(doc: &mut ProjectDocument) {
    doc.categories.clear();
    doc.annotations.clear();
    for m in &mut doc.media {
        m.note.clear();
        m.channel_notes.iter_mut().for_each(String::clear);
        m.category_ids.clear();
        m.channel_category_ids.iter_mut().for_each(Vec::clear);
    }
}
#[test]
fn selected_audio_zip_is_original_and_contains_no_manifest_or_unselected_media() {
    let root = Temp::new();
    let doc = source(&root.0);
    let selected = select_document(&doc, &[doc.media[0].id.clone()]).unwrap();
    let organization = select_organization(&selected, &root_organization(&doc).unwrap()).unwrap();
    let plan = ExportPathPlan::build(&selected, &organization, true, false).unwrap();
    let target = root.0.join("audio.zip");
    export_selected_controlled(
        &selected,
        &plan,
        &root.0,
        &target,
        &cancel(),
        Limits::default(),
        &[],
        true,
        |_, _| {},
        || Ok(()),
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(&target).unwrap()).unwrap();
    assert!(zip.by_name("manifest.json").is_err());
    assert_eq!(zip.len(), 2);
    use std::io::Read;
    let mut bytes = vec![];
    zip.by_name(&plan.media_paths[&selected.media[0].id])
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, fs::read(&selected.media[0].source_ref).unwrap());
}
#[test]
fn multi_author_subset_roundtrip_merge_is_idempotent_and_preserves_live_authors() {
    let root = Temp::new();
    let doc = source(&root.0);
    let authors = portable(&doc);
    let mut selected = select_document(&doc, &[doc.media[0].id.clone()]).unwrap();
    let organization = select_organization(&selected, &root_organization(&doc).unwrap()).unwrap();
    blank_labels(&mut selected);
    let ids = selected
        .media
        .iter()
        .map(|m| m.id.clone())
        .collect::<HashSet<_>>();
    let authors: Vec<_> = authors
        .into_iter()
        .map(|a| PortableAuthor {
            payload: select_payload(&a.payload, &ids),
            ..a
        })
        .collect();
    let plan = ExportPathPlan::build(&selected, &organization, true, true).unwrap();
    let target = root.0.join("part.audioproj.zip");
    export_selected_controlled(
        &selected,
        &plan,
        &root.0,
        &target,
        &cancel(),
        Limits::default(),
        &authors,
        false,
        |_, _| {},
        || Ok(()),
    )
    .unwrap();
    let imported =
        import_exchange(&target, &root.0, &cancel(), Limits::default(), |_, _| {}).unwrap();
    assert_eq!(imported.document.media.len(), 1);
    assert_eq!(imported.authors.len(), 2);
    assert!(
        imported.authors[0]
            .payload
            .categories
            .iter()
            .any(|c| c.name == "OK"),
        "unused category definitions must remain available for recipients"
    );
    assert_eq!(imported.source_project_id, doc.project_id);
    assert_eq!(
        imported.authors[0].payload.annotations,
        authors[0].payload.annotations
    );
    assert!(imported.document.annotations.is_empty());
    assert!(imported.document.categories.is_empty());
    assert!(imported.document.edits.is_empty());
    fs::create_dir(root.0.join("target")).unwrap();
    let live = Profile {
        author_id: authors[0].identity.author_id.clone(),
        display_name: "Alice".into(),
        created_at: authors[0].identity.created_at.clone(),
    };
    let (repo, actor) =
        CollaborationRepository::create_default(&root.0.join("target"), "接收项目", &live).unwrap();
    let empty = LayerPayload::default();
    let checkpoint = repo.publish(&actor, None, &empty).unwrap();
    let repo = merge_package(
        &repo,
        &actor,
        &imported,
        &root.0.join("cache"),
        &cancel(),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(repo.manifest().media.len(), 1);
    assert_eq!(
        repo.read_author(&live.author_id)
            .unwrap()
            .unwrap()
            .checkpoint(),
        checkpoint
    );
    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.authors.len(), 3);
    let foreign: Vec<_> = snapshot
        .authors
        .iter()
        .filter(|a| a.identity.author_id != live.author_id)
        .collect();
    assert_eq!(foreign.len(), 2);
    assert!(foreign
        .iter()
        .all(|a| a.layer.as_ref().unwrap().payload.annotations.len() == 1));
    let before: HashMap<_, _> = snapshot
        .authors
        .iter()
        .map(|a| {
            (
                a.identity.author_id.clone(),
                a.layer.as_ref().map(|l| l.checkpoint()),
            )
        })
        .collect();
    let repo = merge_package(
        &repo,
        &actor,
        &imported,
        &root.0.join("cache"),
        &cancel(),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(repo.manifest().media.len(), 1);
    for a in repo.snapshot().unwrap().authors {
        assert_eq!(
            before[&a.identity.author_id],
            a.layer.map(|l| l.checkpoint())
        );
    }
    assert_eq!(
        fingerprint(
            &repo.root().join(&repo.manifest().media[0].source_ref),
            &cancel(),
            |_| {}
        )
        .unwrap(),
        doc.media[0].sha256
    );
}
#[test]
fn invalid_selection_and_invalid_author_payload_are_rejected_before_publication() {
    let root = Temp::new();
    let doc = source(&root.0);
    assert!(select_document(&doc, &[]).is_err());
    assert!(select_document(&doc, &[doc.media[0].id.clone(), doc.media[0].id.clone()]).is_err());
    assert!(select_document(&doc, &[uuid::Uuid::new_v4().to_string()]).is_err());
    let mut selected = select_document(&doc, &[doc.media[0].id.clone()]).unwrap();
    blank_labels(&mut selected);
    let plan = ExportPathPlan::build(
        &selected,
        &root_organization(&selected).unwrap(),
        true,
        true,
    )
    .unwrap();
    let mut authors = portable(&doc);
    authors[0].payload.annotations[0].region.media_id = doc.media[1].id.clone();
    let target = root.0.join("invalid.zip");
    assert!(export_selected_controlled(
        &selected,
        &plan,
        &root.0,
        &target,
        &cancel(),
        Limits::default(),
        &authors,
        false,
        |_, _| {},
        || Ok(())
    )
    .is_err());
    assert!(!target.exists());
}

#[test]
fn merge_reuses_existing_audio_with_a_different_uuid_and_remaps_annotation_regions() {
    let root = Temp::new();
    let doc = source(&root.0);
    let selected = select_document(&doc, &[doc.media[0].id.clone()]).unwrap();
    let ids = HashSet::from([doc.media[0].id.clone()]);
    let authors = portable(&doc)
        .into_iter()
        .take(1)
        .map(|a| PortableAuthor {
            payload: select_payload(&a.payload, &ids),
            ..a
        })
        .collect();
    let imported = ImportedProject {
        organization: root_organization(&selected).unwrap(),
        source_project_id: doc.project_id.clone(),
        document: selected,
        path: root.0.clone(),
        authors,
    };
    let target = root.0.join("existing");
    fs::create_dir(&target).unwrap();
    let (repo, actor) = CollaborationRepository::create_default(
        &target,
        "Existing",
        &Profile::new("Receiver").unwrap(),
    )
    .unwrap();
    let prepared = repo
        .prepare_media(
            Path::new(&doc.media[0].source_ref),
            &root.0.join("cache"),
            &cancel(),
        )
        .unwrap();
    let existing_id = prepared.media().id.clone();
    assert_ne!(existing_id, doc.media[0].id);
    repo.append_media(&actor, &prepared, &cancel()).unwrap();
    let repo = merge_package(
        &repo,
        &actor,
        &imported,
        &root.0.join("cache"),
        &cancel(),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(repo.manifest().media.len(), 1);
    assert_eq!(repo.manifest().media[0].id, existing_id);
    let snapshot = repo.snapshot().unwrap();
    let layer = snapshot
        .authors
        .iter()
        .find(|a| a.identity.display_name.ends_with("（导入）"))
        .unwrap()
        .layer
        .as_ref()
        .unwrap();
    assert_eq!(layer.payload.annotations[0].region.media_id, existing_id);
    assert_eq!(layer.payload.media_labels[0].media_id, existing_id);
}
