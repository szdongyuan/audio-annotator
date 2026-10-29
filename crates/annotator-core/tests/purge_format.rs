use annotator_core::collaboration::{
    profiles::Profile, recycle::RecycleOperation, CollaborationRepository, LayerPayload,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::atomic::AtomicBool};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
struct Fixture {
    root: PathBuf,
    profile: Profile,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("purge-format-{}", id()));
        fs::create_dir(&root).unwrap();
        let profile = Profile::new("Alice").unwrap();
        let (repo, actor) =
            CollaborationRepository::create_default(&root, "Formats", &profile).unwrap();
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let cancel = AtomicBool::new(false);
        let prepared = repo
            .prepare_media(&source, &root.join("pcm"), &cancel)
            .unwrap();
        repo.append_media(&actor, &prepared, &cancel).unwrap();
        let repo = repo.reload_catalog().unwrap();
        repo.publish(
            &actor,
            None,
            &LayerPayload::from_document(&repo.manifest().base_document().unwrap()).unwrap(),
        )
        .unwrap();
        repo.apply_recycle_controlled(
            &actor,
            0,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![prepared.media().id.clone()],
                trash: true,
            },
            &cancel,
            || Ok(()),
        )
        .unwrap();
        Self { root, profile }
    }
    fn v6(&self) -> (String, Value) {
        let bytes = fs::read(self.root.join("collaboration.json")).unwrap();
        let mut entry: Value = serde_json::from_slice(&bytes).unwrap();
        let generation = id();
        let dir = self.root.join("state").join(&generation);
        fs::create_dir_all(&dir).unwrap();
        for name in ["catalog", "annotations"] {
            fs::create_dir(dir.join(name)).unwrap();
            for e in fs::read_dir(self.root.join(name)).unwrap() {
                let e = e.unwrap();
                if e.file_type().unwrap().is_dir() {
                    fs::create_dir(dir.join(name).join(e.file_name())).unwrap();
                    for layer in fs::read_dir(e.path()).unwrap() {
                        let layer = layer.unwrap();
                        if layer.file_name() != ".writer.lock" {
                            fs::copy(
                                layer.path(),
                                dir.join(name).join(e.file_name()).join(layer.file_name()),
                            )
                            .unwrap();
                        }
                    }
                } else if e.file_name() != ".commit.lock" {
                    fs::copy(e.path(), dir.join(name).join(e.file_name())).unwrap();
                }
            }
        }
        for name in ["organization.json", "recycle.json"] {
            fs::copy(self.root.join(name), dir.join(name)).unwrap();
        }
        fs::write(dir.join("source-entry.json"), &bytes).unwrap();
        let descriptor = json!({"kind":"audio-annotator-metadata-generation","formatVersion":1,"projectId":entry["projectId"],"generationId":generation,"sourceEntryHash":hash(&bytes),"sourceGeneration":entry.get("metadataGeneration").cloned().unwrap_or(Value::Null),"checkpointMap":[],"receipts":[],"retired":[]});
        let descriptor = serde_json::to_vec(&descriptor).unwrap();
        fs::write(dir.join("generation.json"), &descriptor).unwrap();
        entry["formatVersion"] = json!(6);
        entry["metadataGeneration"] = json!(generation);
        entry["generationHash"] = json!(hash(&descriptor));
        fs::write(
            self.root.join("collaboration.json"),
            serde_json::to_vec(&entry).unwrap(),
        )
        .unwrap();
        (generation, entry)
    }
}
#[test]
fn format5_open_save_and_preview_preserve_entry_bytes() {
    let f = Fixture::new();
    let before = fs::read(f.root.join("collaboration.json")).unwrap();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(repo.manifest().format_version, 5);
    let actor = repo.adopt(&f.profile).unwrap();
    let payload = repo.read_author(&f.profile.author_id).unwrap().unwrap();
    repo.publish(&actor, Some(&payload.checkpoint()), &payload.payload)
        .unwrap();
    repo.purge_authority(&actor).unwrap();
    assert_eq!(fs::read(f.root.join("collaboration.json")).unwrap(), before);
}
#[test]
fn format6_routes_all_metadata_and_keeps_stable_writer_lease() {
    let f = Fixture::new();
    let (generation, _) = f.v6();
    for name in ["organization.json", "recycle.json"] {
        fs::write(f.root.join(name), b"old root data").unwrap();
    }
    fs::write(
        f.root
            .join("annotations")
            .join(&f.profile.author_id)
            .join("00000000000000000001.json"),
        b"old root history",
    )
    .unwrap();
    let repo = CollaborationRepository::open(&f.root)
        .expect("format6 entry must select a validated generation");
    assert_eq!(repo.manifest().media.len(), 1);
    assert_eq!(repo.read_organization().unwrap().media.len(), 1);
    assert_eq!(repo.read_recycle().unwrap().trashed.len(), 1);
    let actor = repo.adopt(&f.profile).unwrap();
    assert!(repo.adopt(&f.profile).is_err());
    let layer = repo.read_author(&f.profile.author_id).unwrap().unwrap();
    repo.publish(&actor, Some(&layer.checkpoint()), &layer.payload)
        .unwrap();
    repo.purge_authority(&actor).unwrap();
    assert!(f
        .root
        .join(format!(
            "state/{generation}/annotations/{}/00000000000000000002.json",
            f.profile.author_id
        ))
        .exists());
    assert!(f
        .root
        .join(format!("annotations/{}/.writer.lock", f.profile.author_id))
        .exists());
    assert!(!f
        .root
        .join(format!(
            "state/{generation}/annotations/{}/.writer.lock",
            f.profile.author_id
        ))
        .exists());
}
#[test]
fn format6_rejects_invalid_entry_and_generation_authority() {
    let f = Fixture::new();
    let (generation, entry) = f.v6();
    for (field, value) in [
        ("metadataGeneration", json!("../escape")),
        ("metadataGeneration", json!("C:/outside")),
        ("generationHash", json!("a".repeat(64))),
        ("formatVersion", json!(7)),
    ] {
        let mut bad = entry.clone();
        bad[field] = value;
        fs::write(
            f.root.join("collaboration.json"),
            serde_json::to_vec(&bad).unwrap(),
        )
        .unwrap();
        assert!(CollaborationRepository::open(&f.root).is_err(), "{field}");
    }
    for field in ["metadataGeneration", "generationHash", "projectId"] {
        let mut bad = entry.clone();
        bad.as_object_mut().unwrap().remove(field);
        fs::write(
            f.root.join("collaboration.json"),
            serde_json::to_vec(&bad).unwrap(),
        )
        .unwrap();
        assert!(
            CollaborationRepository::open(&f.root).is_err(),
            "missing {field}"
        );
    }
    let raw = serde_json::to_string(&entry).unwrap();
    let duplicate = raw.replacen(
        '{',
        "{\"metadataGeneration\":\"00000000-0000-4000-8000-000000000001\",",
        1,
    );
    fs::write(f.root.join("collaboration.json"), duplicate).unwrap();
    assert!(CollaborationRepository::open(&f.root).is_err());
    fs::write(f.root.join("collaboration.json"), raw).unwrap();
    fs::write(
        f.root.join(format!("state/{generation}/generation.json")),
        b"{}",
    )
    .unwrap();
    assert!(CollaborationRepository::open(&f.root).is_err());
}
#[test]
fn format6_ordinary_writes_stay_in_selected_generation() {
    use annotator_core::collaboration::{organization::OrganizationOperation, PrivateWorkspace};
    use std::sync::Arc;
    let f = Fixture::new();
    let (generation, _) = f.v6();
    let root_org = fs::read(f.root.join("organization.json")).unwrap();
    let root_recycle = fs::read(f.root.join("recycle.json")).unwrap();
    let repo = Arc::new(CollaborationRepository::open(&f.root).unwrap());
    let actor = Arc::new(repo.adopt(&f.profile).unwrap());
    repo.apply_organization(
        &actor,
        repo.organization().revision,
        OrganizationOperation::CreateFolder {
            id: id(),
            parent_id: None,
            name: "Generation folder".into(),
        },
    )
    .unwrap();
    repo.apply_recycle_controlled(
        &actor,
        1,
        RecycleOperation {
            operation_id: id(),
            media_ids: vec![repo.manifest().media[0].id.clone()],
            trash: false,
        },
        &AtomicBool::new(false),
        || Ok(()),
    )
    .unwrap();
    let local = f.root.with_extension("local");
    fs::create_dir(&local).unwrap();
    {
        let mut workspace =
            PrivateWorkspace::open(repo.clone(), Some(actor.clone()), &local).unwrap();
        let doc = workspace.envelope().document.clone();
        workspace.save(&doc).unwrap();
    }
    {
        PrivateWorkspace::open_view_only(repo.clone(), &local).unwrap();
    }
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let cancel = AtomicBool::new(false);
    let prepared = repo
        .prepare_media(&source, &f.root.join("pcm2"), &cancel)
        .unwrap();
    let added = prepared.media().id.clone();
    let next = repo
        .append_media_batch_interleaved(&actor, &[&prepared], &cancel, None, || Ok(()))
        .unwrap();
    assert_eq!(next.manifest().media.len(), 2);
    let reopened = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(reopened.manifest().media.len(), 2);
    assert_eq!(reopened.organization().folders.len(), 1);
    assert!(reopened.read_recycle().unwrap().trashed.is_empty());
    assert!(f
        .root
        .join(format!("state/{generation}/catalog/{added}.json"))
        .exists());
    assert!(!f.root.join(format!("catalog/{added}.json")).exists());
    assert_eq!(
        fs::read(f.root.join("organization.json")).unwrap(),
        root_org
    );
    assert_eq!(fs::read(f.root.join("recycle.json")).unwrap(), root_recycle);
    fs::remove_dir_all(local).unwrap();
}
#[test]
fn credential_codecs_reject_incomplete_unknown_duplicate_or_invalid_fields() {
    use annotator_core::collaboration::purge::{
        generation::GenerationDescriptor, journal::PurgeJournal,
    };
    let project = id();
    let generation = id();
    let operation = id();
    let media = id();
    let author = id();
    let digest = "a".repeat(64);
    let receipt = json!({"operationId":operation,"legacyPreparationId":null,"cleanupManifestHash":"a".repeat(64),"actorId":author,"requestHash":digest,"sourceEntryHash":digest,"generationId":generation,"requestedIds":[media],"removedIds":[media],"retained":[]});
    let journal = json!({"kind":"audio-annotator-purge-journal","formatVersion":1,"projectId":project,"status":"preparing","receipt":receipt});
    PurgeJournal::parse(&serde_json::to_vec(&journal).unwrap()).unwrap();
    for key in ["kind", "formatVersion", "projectId", "status", "receipt"] {
        let mut bad = journal.clone();
        bad.as_object_mut().unwrap().remove(key);
        assert!(
            PurgeJournal::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "missing {key}"
        );
    }
    for key in [
        "operationId",
        "legacyPreparationId",
        "cleanupManifestHash",
        "actorId",
        "requestHash",
        "sourceEntryHash",
        "generationId",
        "requestedIds",
        "removedIds",
        "retained",
    ] {
        let mut bad = journal.clone();
        bad["receipt"].as_object_mut().unwrap().remove(key);
        assert!(
            PurgeJournal::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "missing receipt {key}"
        );
    }
    for (key, value) in [
        ("status", json!("future")),
        ("formatVersion", json!(2)),
        ("extra", json!(true)),
    ] {
        let mut bad = journal.clone();
        bad[key] = value;
        assert!(PurgeJournal::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    for (key, value) in [
        ("legacyPreparationId", json!("../attempt")),
        ("cleanupManifestHash", json!("invalid")),
        (
            "retained",
            json!([{"mediaId":media,"reason":"not-in-recycle"}]),
        ),
        ("retained", json!([{"mediaId":id(),"reason":"future"}])),
        ("actorId", json!("../author")),
        ("requestHash", json!("invalid")),
        ("removedIds", json!([id()])),
        ("requestedIds", json!([media, media])),
        ("extra", json!(true)),
    ] {
        let mut bad = journal.clone();
        bad["receipt"][key] = value;
        assert!(PurgeJournal::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    let duplicate = serde_json::to_string(&journal)
        .unwrap()
        .replace("\"status\":", "\"status\":\"complete\",\"status\":");
    assert!(PurgeJournal::parse(duplicate.as_bytes()).is_err());
    let mapping = json!({"authorId":author,"source":{"revision":1,"hash":digest},"target":{"revision":1,"hash":digest}});
    let descriptor = json!({"kind":"audio-annotator-metadata-generation","formatVersion":1,"projectId":project,"generationId":generation,"sourceEntryHash":digest,"sourceGeneration":null,"checkpointMap":[mapping],"receipts":[receipt],"retired":[{"mediaId":media,"operationId":operation}]});
    GenerationDescriptor::parse(&serde_json::to_vec(&descriptor).unwrap()).unwrap();
    for key in [
        "sourceGeneration",
        "sourceEntryHash",
        "checkpointMap",
        "receipts",
        "retired",
    ] {
        let mut bad = descriptor.clone();
        bad.as_object_mut().unwrap().remove(key);
        assert!(
            GenerationDescriptor::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "missing {key}"
        );
    }
    for key in ["checkpointMap", "receipts", "retired"] {
        let mut bad = descriptor.clone();
        let item = bad[key][0].clone();
        bad[key].as_array_mut().unwrap().push(item);
        assert!(
            GenerationDescriptor::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
            "duplicate {key}"
        );
    }
    let mut bad = descriptor.clone();
    bad["checkpointMap"][0]["source"]["revision"] = json!(9007199254740992u64);
    assert!(GenerationDescriptor::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    let mut bad = descriptor.clone();
    let mut other = mapping.clone();
    other["source"]["revision"] = json!(2);
    bad["checkpointMap"].as_array_mut().unwrap().push(other);
    assert!(
        GenerationDescriptor::parse(&serde_json::to_vec(&bad).unwrap()).is_err(),
        "two source checkpoints cannot claim the same rewritten checkpoint"
    );
}
#[test]
fn format6_does_not_create_a_second_lease_for_an_existing_format5_writer() {
    let f = Fixture::new();
    let before = CollaborationRepository::open(&f.root).unwrap();
    let actor = before.adopt(&f.profile).unwrap();
    let (generation, _) = f.v6();
    let after = CollaborationRepository::open(&f.root).unwrap();
    assert!(after.adopt(&f.profile).is_err());
    let head = after.read_author(&f.profile.author_id).unwrap().unwrap();
    after
        .publish(&actor, Some(&head.checkpoint()), &head.payload)
        .unwrap();
    assert!(!f
        .root
        .join(format!(
            "state/{generation}/annotations/{}/.writer.lock",
            f.profile.author_id
        ))
        .exists());
}
#[cfg(windows)]
#[test]
fn format6_rejects_generation_junction() {
    let f = Fixture::new();
    let (generation, _) = f.v6();
    let dir = f.root.join("state").join(generation);
    let moved = f.root.join("elsewhere");
    fs::rename(&dir, &moved).unwrap();
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(&dir)
        .arg(&moved)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(CollaborationRepository::open(&f.root).is_err());
    fs::remove_dir(dir).unwrap();
}
#[test]
fn format6_revalidates_generation_digest_before_reading_authority() {
    let f = Fixture::new();
    let (generation, _) = f.v6();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    fs::write(
        f.root.join(format!("state/{generation}/generation.json")),
        b"changed authority",
    )
    .unwrap();
    assert!(
        repo.read_author(&f.profile.author_id).is_err(),
        "entry alone cannot authorize a modified generation descriptor"
    );
}
#[test]
fn format6_missing_recycle_is_an_error_even_if_old_root_recycle_exists() {
    let f = Fixture::new();
    let (generation, _) = f.v6();
    fs::remove_file(f.root.join(format!("state/{generation}/recycle.json"))).unwrap();
    let result = CollaborationRepository::open(&f.root).and_then(|r| r.read_recycle());
    assert!(
        result.is_err(),
        "a format6 generation requires its own complete recycle state"
    );
}
#[test]
fn format6_source_proof_must_match_digest_project_and_generation() {
    let f = Fixture::new();
    let (generation, entry) = f.v6();
    let dir = f.root.join("state").join(&generation);
    let descriptor: Value =
        serde_json::from_slice(&fs::read(dir.join("generation.json")).unwrap()).unwrap();
    let source: Value =
        serde_json::from_slice(&fs::read(dir.join("source-entry.json")).unwrap()).unwrap();
    for (field, value) in [
        ("projectId", json!(id())),
        ("name", json!("Foreign project")),
        ("formatVersion", json!(7)),
        ("metadataGeneration", json!(generation)),
    ] {
        let mut bad_source = source.clone();
        bad_source[field] = value;
        let bytes = serde_json::to_vec(&bad_source).unwrap();
        fs::write(dir.join("source-entry.json"), &bytes).unwrap();
        let mut bad_descriptor = descriptor.clone();
        bad_descriptor["sourceEntryHash"] = json!(hash(&bytes));
        let bytes = serde_json::to_vec(&bad_descriptor).unwrap();
        fs::write(dir.join("generation.json"), &bytes).unwrap();
        let mut bad_entry = entry.clone();
        bad_entry["generationHash"] = json!(hash(&bytes));
        fs::write(
            f.root.join("collaboration.json"),
            serde_json::to_vec(&bad_entry).unwrap(),
        )
        .unwrap();
        assert!(
            CollaborationRepository::open(&f.root).is_err(),
            "source {field} must be verified even if descriptor has a valid digest"
        );
    }
}
#[test]
fn format6_source_entry_proof_survives_retirement_of_old_generation() {
    let f = Fixture::new();
    let (source_generation, _) = f.v6();
    let (generation, _) = f.v6();
    assert_ne!(source_generation, generation);
    fs::remove_dir_all(f.root.join("state").join(&source_generation)).unwrap();
    let repo = CollaborationRepository::open(&f.root).unwrap();
    assert_eq!(repo.manifest().media.len(), 1);
}
#[test]
fn credential_resource_limits_apply_before_adopting_unbounded_records() {
    use annotator_core::collaboration::purge::{
        generation::GenerationDescriptor, journal::PurgeJournal,
    };
    use annotator_core::error::ErrorCode;
    let huge = vec![b' '; 16 * 1024 * 1024 + 1];
    assert_eq!(
        PurgeJournal::parse(&huge).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(
        GenerationDescriptor::parse(&huge).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    let requested: Vec<_> = (0..10_001)
        .map(|n| format!("00000000-0000-4000-8000-{n:012}"))
        .collect();
    let journal = json!({"kind":"audio-annotator-purge-journal","formatVersion":1,"projectId":id(),"status":"preparing","receipt":{"operationId":id(),"legacyPreparationId":null,"cleanupManifestHash":"a".repeat(64),"actorId":id(),"requestHash":"a".repeat(64),"sourceEntryHash":"a".repeat(64),"generationId":id(),"removedIds":[requested[0]],"requestedIds":requested,"retained":[]}});
    assert_eq!(
        PurgeJournal::parse(&serde_json::to_vec(&journal).unwrap())
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
}
