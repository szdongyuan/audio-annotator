use annotator_core::{
    collaboration::{
        profiles::Profile,
        purge::{classify_media, Eligibility},
        recycle::RecycleOperation,
        AuthorSession, CollaborationRepository, LayerPayload,
    },
    model::{Annotation, Category, EditOperation, Region, SpectralEdit},
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
struct Fixture {
    repo: CollaborationRepository,
    alice: AuthorSession,
    bob: AuthorSession,
    temp: Temp,
}
impl Fixture {
    fn new() -> Self {
        let temp = Temp(std::env::temp_dir().join(format!("purge-policy-{}", id())));
        fs::create_dir(&temp.0).unwrap();
        let (repo, alice) = CollaborationRepository::create_default(
            &temp.0,
            "Purge permissions",
            &Profile::new("Same name").unwrap(),
        )
        .unwrap();
        let bob = repo.adopt(&Profile::new("Same name").unwrap()).unwrap();
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
        let cancel = AtomicBool::new(false);
        for _ in 0..2 {
            let prepared = repo
                .prepare_media(&source, &temp.0.join("pcm"), &cancel)
                .unwrap();
            repo.append_media(&alice, &prepared, &cancel).unwrap();
        }
        let repo = repo.reload_catalog().unwrap();
        repo.apply_recycle_controlled(
            &bob,
            0,
            RecycleOperation {
                operation_id: id(),
                media_ids: repo.manifest().media.iter().map(|m| m.id.clone()).collect(),
                trash: true,
            },
            &cancel,
            || Ok(()),
        )
        .unwrap();
        Self {
            repo,
            alice,
            bob,
            temp,
        }
    }
    fn media(&self) -> &str {
        &self.repo.manifest().media[0].id
    }
    fn payload(&self, kind: &str) -> LayerPayload {
        let mut doc = self.repo.manifest().base_document().unwrap();
        let category = Category {
            id: id(),
            name: "Bird".into(),
            color: "#eaa64e".into(),
        };
        let region = Region {
            media_id: self.media().into(),
            channel_index: 0,
            start_seconds: 0.0,
            end_seconds: 10.0 / doc.media[0].sample_rate as f64,
            low_hz: 0.0,
            high_hz: doc.media[0].sample_rate as f64 / 2.0,
        };
        doc.categories.push(category.clone());
        match kind {
            "file" => doc.media[0].category_ids.push(category.id),
            "channel" => doc.media[0].channel_category_ids[0].push(category.id),
            "region" | "region-note" => doc.annotations.push(Annotation {
                id: id(),
                region,
                category_ids: vec![],
                note: if kind == "region-note" {
                    "Note".into()
                } else {
                    String::new()
                },
                created_at: doc.created_at.clone(),
                updated_at: doc.updated_at.clone(),
            }),
            "notes" => {
                doc.media[0].note = "File note".into();
                doc.media[0].channel_notes[0] = "Channel note".into();
            }
            "private" => doc.edits.push(SpectralEdit {
                id: id(),
                region,
                enabled: true,
                processing_version: 2,
                operation: EditOperation::Mask,
            }),
            "categories" | "empty" => (),
            _ => panic!("Unknown fixture kind"),
        }
        let mut payload = LayerPayload::from_document(&doc).unwrap();
        if kind == "empty" {
            payload.media_labels.clear();
        }
        payload
    }
    fn bob_head(&self, revision: u64) -> PathBuf {
        self.temp.0.join(format!(
            "annotations/{}/{revision:020}.json",
            self.bob.identity().author_id
        ))
    }
}

#[test]
fn annotation_ownership_matrix_uses_author_and_media_ids() {
    let f = Fixture::new();
    let actor = &f.alice.identity().author_id;
    let foreign = &f.bob.identity().author_id;
    assert_ne!(actor, foreign);
    assert_eq!(
        f.alice.identity().display_name,
        f.bob.identity().display_name
    );
    let other = &f.repo.manifest().media[1];
    let target = &f.repo.manifest().media[0];
    assert_eq!(target.display_name, other.display_name);
    assert_eq!(target.sha256, other.sha256);
    assert_ne!(target.id, other.id);
    assert_eq!(
        classify_media(actor, f.media(), true, &[]),
        Eligibility::Allowed
    );
    for kind in ["file", "channel", "region", "region-note"] {
        let payload = f.payload(kind);
        assert_eq!(
            classify_media(actor, f.media(), true, &[(actor.clone(), payload.clone())]),
            Eligibility::Allowed,
            "own {kind}"
        );
        let layers = vec![(foreign.clone(), payload.clone())];
        assert_eq!(
            classify_media(actor, f.media(), true, &layers),
            Eligibility::OtherAuthorAnnotation,
            "foreign {kind}"
        );
        assert_eq!(
            classify_media(actor, &other.id, true, &layers),
            Eligibility::Allowed,
            "same content, different ID: {kind}"
        );
        assert_eq!(
            classify_media(actor, f.media(), false, &layers),
            Eligibility::NotInRecycle
        );
        assert_eq!(
            classify_media(
                actor,
                f.media(),
                true,
                &[(actor.clone(), payload.clone()), (foreign.clone(), payload)]
            ),
            Eligibility::OtherAuthorAnnotation,
            "both {kind}"
        );
    }
    for kind in ["notes", "categories", "private", "empty"] {
        assert_eq!(
            classify_media(
                actor,
                f.media(),
                true,
                &[(foreign.clone(), f.payload(kind))]
            ),
            Eligibility::Allowed,
            "foreign {kind}"
        );
    }
}

#[test]
fn authority_reads_unshown_authors_and_ignores_recycle_actor_and_duplicate_content() {
    let f = Fixture::new();
    let before = fs::read(f.temp.0.join("collaboration.json")).unwrap();
    // No caller-supplied authors list: Bob's published layer must be included.
    f.repo.publish(&f.bob, None, &f.payload("channel")).unwrap();
    let authority = f.repo.purge_authority(&f.alice).unwrap();
    assert_eq!(authority.actor_id(), f.alice.identity().author_id);
    assert_eq!(authority.project_id(), f.repo.manifest().project_id);
    assert_eq!(authority.snapshot().authors.len(), 2);
    assert_eq!(
        authority.classify(f.media()),
        Eligibility::OtherAuthorAnnotation
    );
    assert_eq!(
        authority.classify(&f.repo.manifest().media[1].id),
        Eligibility::Allowed
    );
    assert_eq!(authority.classify(&id()), Eligibility::NotInRecycle);
    // Bob's own annotations permit removal even though the two authors share a name.
    assert_eq!(
        f.repo.purge_authority(&f.bob).unwrap().classify(f.media()),
        Eligibility::Allowed
    );
    assert_eq!(
        before,
        fs::read(f.temp.0.join("collaboration.json")).unwrap()
    );
}

#[test]
fn registered_authors_without_published_layers_are_unannotated_and_latest_layer_wins() {
    let f = Fixture::new();
    let empty = f.repo.purge_authority(&f.alice).unwrap();
    assert!(empty.snapshot().authors.iter().all(|a| a.layer.is_none()));
    assert_eq!(empty.classify(f.media()), Eligibility::Allowed);
    let first = f.repo.publish(&f.bob, None, &f.payload("region")).unwrap();
    let annotated = f.repo.purge_authority(&f.alice).unwrap();
    assert_eq!(
        annotated.classify(f.media()),
        Eligibility::OtherAuthorAnnotation
    );
    f.repo
        .publish(&f.bob, Some(&first), &f.payload("notes"))
        .unwrap();
    let withdrawn = f.repo.purge_authority(&f.alice).unwrap();
    assert_eq!(withdrawn.classify(f.media()), Eligibility::Allowed);
    assert_ne!(empty.state_digest(), annotated.state_digest());
    assert_ne!(annotated.state_digest(), withdrawn.state_digest());
}

#[test]
fn authority_rejects_corrupt_unshown_author_instead_of_ignoring_snapshot_error() {
    let f = Fixture::new();
    f.repo.publish(&f.bob, None, &f.payload("file")).unwrap();
    fs::write(f.bob_head(1), b"corrupt layer").unwrap();
    let display = f.repo.snapshot().unwrap();
    assert!(display
        .authors
        .iter()
        .any(|a| a.identity.author_id == f.bob.identity().author_id && a.error.is_some()));
    assert!(f.repo.purge_authority(&f.alice).is_err());
}

#[test]
fn authority_rejects_missing_or_corrupt_unshown_author_registration() {
    for corrupt in [false, true] {
        let f = Fixture::new();
        f.repo.publish(&f.bob, None, &f.payload("region")).unwrap();
        let record = f
            .temp
            .0
            .join(format!("authors/{}.json", f.bob.identity().author_id));
        if corrupt {
            fs::write(record, b"corrupt registry").unwrap();
        } else {
            fs::remove_file(record).unwrap();
        }
        assert!(
            f.repo.purge_authority(&f.alice).is_err(),
            "corrupt={corrupt}"
        );
    }
}

#[test]
fn authority_rejects_layer_digest_parent_revision_gaps_and_io_errors() {
    for fault in ["digest", "parent", "gap", "io", "limit"] {
        let f = Fixture::new();
        let first = f.repo.publish(&f.bob, None, &f.payload("file")).unwrap();
        let second = f
            .repo
            .publish(&f.bob, Some(&first), &f.payload("channel"))
            .unwrap();
        f.repo
            .publish(&f.bob, Some(&second), &f.payload("region"))
            .unwrap();
        match fault {
            "gap" => fs::remove_file(f.bob_head(2)).unwrap(),
            "io" => {
                fs::remove_file(f.bob_head(3)).unwrap();
                fs::create_dir(f.bob_head(3)).unwrap();
            }
            "limit" => fs::OpenOptions::new()
                .write(true)
                .open(f.bob_head(3))
                .unwrap()
                .set_len(annotator_core::collaboration::MAX_LAYER_BYTES as u64 + 1)
                .unwrap(),
            "digest" | "parent" => {
                let mut layer: annotator_core::collaboration::AuthorLayer =
                    serde_json::from_slice(&fs::read(f.bob_head(3)).unwrap()).unwrap();
                if fault == "digest" {
                    layer.payload.annotations.clear();
                } else {
                    layer.parent.as_mut().unwrap().hash = "a".repeat(64);
                    layer.hash = layer.computed_hash().unwrap();
                }
                fs::write(f.bob_head(3), serde_json::to_vec(&layer).unwrap()).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(f.repo.purge_authority(&f.alice).is_err(), "{fault}");
    }
}

#[cfg(windows)]
#[test]
fn authority_fails_closed_when_unshown_author_layer_cannot_be_read() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    f.repo.publish(&f.bob, None, &f.payload("file")).unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(f.bob_head(1))
        .unwrap();
    assert!(f.repo.purge_authority(&f.alice).is_err());
    drop(locked);
    assert_eq!(
        f.repo
            .purge_authority(&f.alice)
            .unwrap()
            .classify(f.media()),
        Eligibility::OtherAuthorAnnotation
    );
}

#[test]
fn authority_uses_current_catalog_and_binds_catalog_organization_and_recycle_state() {
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new();
    let before = f.repo.purge_authority(&f.alice).unwrap();
    let cancel = AtomicBool::new(false);
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let prepared = f
        .repo
        .prepare_media(&source, &f.temp.0.join("pcm"), &cancel)
        .unwrap();
    f.repo.append_media(&f.alice, &prepared, &cancel).unwrap();
    let current = f.repo.reload_catalog().unwrap();
    let mut doc = current.manifest().base_document().unwrap();
    doc.categories = f.payload("categories").categories;
    doc.media
        .iter_mut()
        .find(|m| m.id == prepared.media().id)
        .unwrap()
        .category_ids
        .push(doc.categories[0].id.clone());
    f.repo
        .apply_recycle_controlled(
            &f.bob,
            1,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![prepared.media().id.clone()],
                trash: true,
            },
            &cancel,
            || Ok(()),
        )
        .unwrap();
    current
        .publish(&f.bob, None, &LayerPayload::from_document(&doc).unwrap())
        .unwrap();
    assert_eq!(
        f.repo.manifest().media.len(),
        2,
        "the client has not adopted this media"
    );
    let captured = f.repo.purge_authority(&f.alice).unwrap();
    assert_eq!(
        captured.classify(&prepared.media().id),
        Eligibility::OtherAuthorAnnotation
    );
    assert_ne!(before.state_digest(), captured.state_digest());
    current
        .apply_organization(
            &f.alice,
            current.organization().revision,
            OrganizationOperation::CreateFolder {
                id: id(),
                parent_id: None,
                name: "Keep folder".into(),
            },
        )
        .unwrap();
    let organized = f.repo.purge_authority(&f.alice).unwrap();
    assert_ne!(captured.state_digest(), organized.state_digest());
    current
        .apply_recycle_controlled(
            &f.alice,
            2,
            RecycleOperation {
                operation_id: id(),
                media_ids: vec![prepared.media().id.clone()],
                trash: false,
            },
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let restored = f.repo.purge_authority(&f.alice).unwrap();
    assert_ne!(organized.state_digest(), restored.state_digest());
    assert_eq!(
        restored.classify(&prepared.media().id),
        Eligibility::NotInRecycle
    );
}
