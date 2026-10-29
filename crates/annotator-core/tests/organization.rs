use annotator_core::collaboration::{organization::*, *};
use std::{fs, sync::atomic::AtomicBool};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
#[test]
fn validates_tree_membership_names_and_bounds() {
    let mut o = Organization::empty(id());
    let a = id();
    let b = id();
    o.folders.push(Folder {
        id: a.clone(),
        parent_id: None,
        name: "结果".into(),
    });
    o.folders.push(Folder {
        id: b.clone(),
        parent_id: Some(a.clone()),
        name: "故障".into(),
    });
    o.media.push(MediaMembership {
        media_id: id(),
        folder_id: Some(b.clone()),
        original_filename: "原始.WAV".into(),
    });
    o.validate().unwrap();
    let valid = o.clone();
    o.folders[0].parent_id = Some(b);
    assert!(o.validate().is_err());
    o = valid.clone();
    o.folders[1].name = "..".into();
    assert!(o.validate().is_err());
    o = valid.clone();
    o.media[0].folder_id = Some(id());
    assert!(o.validate().is_err());
    o = valid.clone();
    o.media.push(o.media[0].clone());
    assert!(o.validate().is_err());
    o = valid.clone();
    o.folders[0].id = o.folders[0].id.to_uppercase();
    assert!(o.validate().is_err());
    o = valid.clone();
    o.media[0].original_filename = "a/b.wav".into();
    assert!(o.validate().is_err());
    let mut o = Organization::empty(id());
    o.folders.push(Folder {
        id: id(),
        parent_id: None,
        name: "Same".into(),
    });
    o.folders.push(Folder {
        id: id(),
        parent_id: None,
        name: "same".into(),
    });
    assert!(o.validate().is_err());
    let mut o = Organization::empty(id());
    let mut parent = None;
    for _ in 0..17 {
        let next = id();
        o.folders.push(Folder {
            id: next.clone(),
            parent_id: parent,
            name: "a".into(),
        });
        parent = Some(next);
    }
    assert!(o.validate().is_err());
}
#[test]
fn manual_operations_enforce_empty_removal_and_increment_layout() {
    let mut o = Organization::empty(id());
    let a = id();
    let b = id();
    let m = id();
    o = o
        .apply(OrganizationOperation::CreateFolder {
            id: a.clone(),
            parent_id: None,
            name: "A".into(),
        })
        .unwrap();
    o = o
        .apply(OrganizationOperation::CreateFolder {
            id: b.clone(),
            parent_id: Some(a.clone()),
            name: "B".into(),
        })
        .unwrap();
    let removed = o
        .apply(OrganizationOperation::RemoveFolder { id: a.clone() })
        .unwrap();
    assert!(removed.folders.is_empty());
    o.media.push(MediaMembership {
        media_id: m.clone(),
        folder_id: Some(b.clone()),
        original_filename: "test.wav".into(),
    });
    assert!(o
        .apply(OrganizationOperation::RemoveFolder { id: b.clone() })
        .is_err());
    o = o
        .apply(OrganizationOperation::MoveMedia {
            media_id: m,
            folder_id: None,
        })
        .unwrap();
    o = o
        .apply(OrganizationOperation::MoveFolder {
            id: b.clone(),
            parent_id: None,
        })
        .unwrap();
    o = o
        .apply(OrganizationOperation::RenameFolder {
            id: b.clone(),
            name: "New".into(),
        })
        .unwrap();
    o = o
        .apply(OrganizationOperation::RemoveFolder { id: a })
        .unwrap();
    assert_eq!(o.revision, 6);
    assert_eq!(o.layout_revision, 6);
    assert!(o
        .apply(OrganizationOperation::RemoveFolder { id: id() })
        .is_err());
}
#[test]
fn removal_empty_tree_is_bounded_recursive_and_preserves_unrelated_memberships() {
    let mut head = Organization::empty(id());
    let survivor = id();
    head.folders.push(Folder {
        id: survivor.clone(),
        parent_id: None,
        name: "survivor".into(),
    });
    head.media.push(MediaMembership {
        media_id: id(),
        folder_id: Some(survivor.clone()),
        original_filename: "original.wav".into(),
    });
    let mut parent = None;
    let root = id();
    for depth in 0..16 {
        let folder = if depth == 0 { root.clone() } else { id() };
        head.folders.push(Folder {
            id: folder.clone(),
            parent_id: parent,
            name: format!("level {depth}"),
        });
        parent = Some(folder);
    }
    let removed = head
        .apply(OrganizationOperation::RemoveFolder { id: root.clone() })
        .unwrap();
    assert_eq!(removed.folders.len(), 1);
    assert_eq!(removed.folders[0].id, survivor);
    assert_eq!(removed.media, head.media);
    assert_eq!((removed.revision, removed.layout_revision), (1, 1));
    // Without native recycle authority even a descendant unknown to the catalog blocks removal.
    head.media.push(MediaMembership {
        media_id: id(),
        folder_id: parent,
        original_filename: "unadopted.wav".into(),
    });
    assert!(head
        .apply(OrganizationOperation::RemoveFolder { id: root })
        .is_err());
}

fn removal_fixture(
    nested: bool,
) -> (
    std::path::PathBuf,
    CollaborationRepository,
    AuthorSession,
    String,
    Option<String>,
) {
    let root = std::env::temp_dir().join(format!("removal-{}", id()));
    fs::create_dir(&root).unwrap();
    let (repo, actor) = CollaborationRepository::create_default(
        &root,
        "Removal",
        &profiles::Profile::new("Alice").unwrap(),
    )
    .unwrap();
    let cancel = AtomicBool::new(false);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    for name in ["原名.wav", "second.wav"] {
        let mut segments = if nested {
            vec!["survivor".into()]
        } else {
            vec![]
        };
        segments.extend(["remove".into(), "leaf".into()]);
        let plan = repo
            .seal_media_placement(0, None, segments, name.into())
            .unwrap();
        let prepared = repo
            .prepare_media(&source, &root.join(format!("pcm-{name}")), &cancel)
            .unwrap()
            .with_placement(plan)
            .unwrap();
        repo.append_media(&actor, &prepared, &cancel).unwrap();
    }
    let repo = repo.reload_catalog().unwrap();
    let mut doc = repo.manifest().base_document().unwrap();
    doc.media[0].note = "retained Alice note".into();
    repo.publish(&actor, None, &LayerPayload::from_document(&doc).unwrap())
        .unwrap();
    let bob = repo.adopt(&profiles::Profile::new("Bob").unwrap()).unwrap();
    doc.media[0].note = "retained Bob note".into();
    repo.publish(&bob, None, &LayerPayload::from_document(&doc).unwrap())
        .unwrap();
    let folder = repo
        .organization()
        .folders
        .iter()
        .find(|f| f.name == "remove")
        .unwrap();
    let removed = folder.id.clone();
    let parent = folder.parent_id.clone();
    (root, repo, actor, removed, parent)
}
fn removal_files(
    root: &std::path::Path,
) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
    fn visit(
        root: &std::path::Path,
        path: &std::path::Path,
        files: &mut std::collections::BTreeMap<std::path::PathBuf, Vec<u8>>,
    ) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), files);
            } else if entry.file_name() != "organization.json"
                && !entry.file_name().to_string_lossy().ends_with(".lock")
            {
                files.insert(
                    entry.path().strip_prefix(root).unwrap().to_owned(),
                    fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    let mut files = std::collections::BTreeMap::new();
    visit(root, root, &mut files);
    files
}
#[test]
fn removal_empty_subtree_needs_no_recycle_authority() {
    let (root, repo, actor, removed, _) = removal_fixture(true);
    let mut head = repo.read_organization().unwrap();
    for membership in &mut head.media {
        membership.folder_id = None;
    }
    fs::write(
        root.join("organization.json"),
        serde_json::to_vec(&head).unwrap(),
    )
    .unwrap();
    fs::write(root.join("recycle.json"), b"unavailable recycle metadata").unwrap();
    let next = repo
        .apply_organization(
            &actor,
            head.revision,
            OrganizationOperation::RemoveFolder { id: removed },
        )
        .unwrap();
    assert_eq!(next.folders.len(), 1);
    assert_eq!(next.media, head.media);
    assert_eq!(
        fs::read(root.join("recycle.json")).unwrap(),
        b"unavailable recycle metadata"
    );
    drop((repo, actor));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn removal_recycled_subtree_preserves_all_files_and_restores_to_surviving_parent_or_root() {
    use recycle::RecycleOperation;
    let cancel = AtomicBool::new(false);
    for nested in [true, false] {
        let (root, repo, actor, removed, parent) = removal_fixture(nested);
        let original = repo.read_organization().unwrap();
        let ids: Vec<_> = original.media.iter().map(|m| m.media_id.clone()).collect();
        repo.apply_recycle_controlled(
            &actor,
            0,
            RecycleOperation {
                operation_id: id(),
                media_ids: ids.clone(),
                trash: true,
            },
            &cancel,
            || Ok(()),
        )
        .unwrap();
        let files = removal_files(&root);
        let next = repo
            .apply_organization(
                &actor,
                original.revision,
                OrganizationOperation::RemoveFolder { id: removed },
            )
            .unwrap();
        assert_eq!(next.folders.len(), usize::from(nested));
        assert_eq!(
            (next.revision, next.layout_revision),
            (original.revision + 1, original.layout_revision + 1)
        );
        for (before, after) in original.media.iter().zip(&next.media) {
            assert_eq!(after.media_id, before.media_id);
            assert_eq!(after.original_filename, before.original_filename);
            assert_eq!(after.folder_id, parent);
        }
        assert_eq!(
            removal_files(&root),
            files,
            "only organization metadata may change"
        );
        assert_eq!(repo.reload_catalog().unwrap().manifest().media.len(), 2);
        repo.apply_recycle_controlled(
            &actor,
            1,
            RecycleOperation {
                operation_id: id(),
                media_ids: ids,
                trash: false,
            },
            &cancel,
            || Ok(()),
        )
        .unwrap();
        assert!(repo.read_recycle().unwrap().trashed.is_empty());
        assert!(repo
            .read_organization()
            .unwrap()
            .media
            .iter()
            .all(|m| m.folder_id == parent));
        drop((repo, actor));
        fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn removal_rechecks_live_restored_unknown_and_unavailable_memberships_without_writing() {
    use recycle::RecycleOperation;
    let cancel = AtomicBool::new(false);
    let (root, repo, actor, removed, _) = removal_fixture(true);
    let original = repo.read_organization().unwrap();
    let ids: Vec<_> = original.media.iter().map(|m| m.media_id.clone()).collect();
    let operation = OrganizationOperation::RemoveFolder { id: removed };
    let unchanged = || assert_eq!(repo.read_organization().unwrap(), original);
    repo.apply_recycle_controlled(
        &actor,
        0,
        RecycleOperation {
            operation_id: id(),
            media_ids: vec![ids[0].clone()],
            trash: true,
        },
        &cancel,
        || Ok(()),
    )
    .unwrap();
    assert!(
        repo.apply_organization(&actor, original.revision, operation.clone())
            .is_err(),
        "mixed live/recycled descendants block even when not adopted by an editor"
    );
    unchanged();
    repo.apply_recycle_controlled(
        &actor,
        1,
        RecycleOperation {
            operation_id: id(),
            media_ids: vec![ids[1].clone()],
            trash: true,
        },
        &cancel,
        || Ok(()),
    )
    .unwrap();
    // This repository was captured before trash/restore. The fresh under-lock read must win.
    repo.apply_recycle_controlled(
        &actor,
        2,
        RecycleOperation {
            operation_id: id(),
            media_ids: vec![ids[0].clone()],
            trash: false,
        },
        &cancel,
        || Ok(()),
    )
    .unwrap();
    assert!(repo
        .apply_organization(&actor, original.revision, operation.clone())
        .is_err());
    unchanged();
    repo.apply_recycle_controlled(
        &actor,
        3,
        RecycleOperation {
            operation_id: id(),
            media_ids: ids,
            trash: true,
        },
        &cancel,
        || Ok(()),
    )
    .unwrap();
    for mode in ["guard", "cancel", "stale", "corrupt", "missing"] {
        let recycle = fs::read(root.join("recycle.json")).unwrap();
        let bytes = fs::read(root.join("organization.json")).unwrap();
        if mode == "corrupt" {
            fs::write(root.join("recycle.json"), b"broken").unwrap();
        }
        if mode == "missing" {
            fs::remove_file(root.join("recycle.json")).unwrap();
        }
        let result = repo.apply_organization_controlled(
            &actor,
            original.revision + u64::from(mode == "stale"),
            operation.clone(),
            &AtomicBool::new(mode == "cancel"),
            || {
                if mode == "guard" {
                    Err(annotator_core::error::AppError::invalid("owner replaced"))
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err(), "{mode} must fail closed");
        assert_eq!(fs::read(root.join("organization.json")).unwrap(), bytes);
        fs::write(root.join("recycle.json"), recycle).unwrap();
    }
    let mut unknown = original.clone();
    unknown.media.push(MediaMembership {
        media_id: id(),
        folder_id: original.media[0].folder_id.clone(),
        original_filename: "unknown.wav".into(),
    });
    fs::write(
        root.join("organization.json"),
        serde_json::to_vec(&unknown).unwrap(),
    )
    .unwrap();
    assert!(repo
        .apply_organization(&actor, original.revision, operation)
        .is_err());
    assert_eq!(repo.read_organization().unwrap(), unknown);
    drop((actor, repo));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn repository_cas_required_head_and_safe_root_filename() {
    let root = std::env::temp_dir().join(format!("organization-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    assert_eq!(r.manifest().format_version, 5);
    let old = r.organization().clone();
    let folder = id();
    let next = r
        .apply_organization(
            &a,
            old.revision,
            OrganizationOperation::CreateFolder {
                id: folder.clone(),
                parent_id: None,
                name: "new".into(),
            },
        )
        .unwrap();
    assert_eq!(next.revision, 1);
    let bytes = fs::read(root.join("organization.json")).unwrap();
    assert!(r
        .apply_organization(
            &a,
            old.revision,
            OrganizationOperation::RenameFolder {
                id: folder,
                name: "stale".into()
            }
        )
        .is_err());
    assert_eq!(fs::read(root.join("organization.json")).unwrap(), bytes);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let p = r
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let current = r.read_organization().unwrap();
    assert_eq!(current.media[0].original_filename, "mono16.wav");
    assert_eq!(current.layout_revision, 1);
    assert_eq!(current.revision, 2);
    fs::remove_file(root.join("organization.json")).unwrap();
    assert!(CollaborationRepository::open(&root).is_err());
    drop((p, a, r));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn captured_head_hides_orphans_and_corruption_fails_closed() {
    let root = std::env::temp_dir().join(format!("head-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let p = r
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let head = fs::read(root.join("organization.json")).unwrap();
    let q = r
        .prepare_media(&source, &root.join("pcm2"), &AtomicBool::new(false))
        .unwrap();
    r.append_media(&a, &q, &AtomicBool::new(false)).unwrap();
    fs::write(root.join("organization.json"), &head).unwrap();
    let captured = CollaborationRepository::open(&root).unwrap();
    assert_eq!(captured.manifest().media.len(), 1);
    let mut changed = false;
    let capture = CollaborationRepository::open_catalog_interleaved(&root, |_| {
        if !changed {
            changed = true;
            let mut next: organization::Organization = serde_json::from_slice(&head).unwrap();
            next.media.clear();
            fs::write(
                root.join("organization.json"),
                serde_json::to_vec(&next).unwrap(),
            )
            .unwrap();
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(capture.manifest().media.len(), 1);
    fs::write(root.join("organization.json"), &head).unwrap();
    fs::write(
        root.join("catalog").join(format!("{}.json", p.media().id)),
        b"broken",
    )
    .unwrap();
    assert!(CollaborationRepository::open(&root).is_err());
    drop((q, p, a, r, captured, capture));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn publication_boundaries_keep_head_bytes_and_committed_retry_keeps_moved_placement() {
    use annotator_core::collaboration::atomic::PublishFault;
    let root = std::env::temp_dir().join(format!("boundaries-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = root.join("原始.wav");
    fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/audio/mono16.wav"),
        &source,
    )
    .unwrap();
    let p = r
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    let before = fs::read(root.join("organization.json")).unwrap();
    for fault in [
        PublishFault::BeforeRecord,
        PublishFault::AfterRecord,
        PublishFault::PartialWrite,
        PublishFault::Sync,
        PublishFault::Rename,
        PublishFault::CancelAfterWrite,
    ] {
        assert!(r
            .append_media_controlled(&a, &p, &AtomicBool::new(false), Some(fault))
            .is_err());
        assert_eq!(fs::read(root.join("organization.json")).unwrap(), before);
        assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    }
    assert!(r
        .append_media_controlled(
            &a,
            &p,
            &AtomicBool::new(false),
            Some(PublishFault::AfterPublish)
        )
        .is_err());
    let published = r.reload_catalog().unwrap();
    let revision = published.catalog_revision().cloned();
    let folder = id();
    let created = r
        .apply_organization(
            &a,
            published.organization().revision,
            OrganizationOperation::CreateFolder {
                id: folder.clone(),
                parent_id: None,
                name: "moved".into(),
            },
        )
        .unwrap();
    let moved = r
        .apply_organization(
            &a,
            created.revision,
            OrganizationOperation::MoveMedia {
                media_id: p.media().id.clone(),
                folder_id: Some(folder.clone()),
            },
        )
        .unwrap();
    fs::remove_file(&source).unwrap();
    let (_, retry) = r
        .append_media_with_catalog(&a, &p, &AtomicBool::new(true))
        .unwrap();
    assert_eq!(retry.organization(), &moved);
    assert_eq!(retry.organization().media[0].folder_id, Some(folder));
    assert_eq!(retry.catalog_revision(), revision.as_ref());
    drop((published, retry, p, a, r));
    fs::remove_dir_all(root).unwrap();
}
#[cfg(windows)]
#[test]
fn real_windows_head_replacement_denial_preserves_old_visibility_and_private_files() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = std::env::temp_dir().join(format!("denied-head-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let p = r
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    let before = fs::read(root.join("organization.json")).unwrap();
    let catalog_before = r.catalog_revision().cloned();
    let blocker = fs::OpenOptions::new()
        .read(true)
        .share_mode(1 | 2)
        .open(root.join("organization.json"))
        .unwrap();
    assert!(r
        .apply_organization(
            &a,
            0,
            OrganizationOperation::CreateFolder {
                id: id(),
                parent_id: None,
                name: "blocked".into()
            }
        )
        .is_err());
    assert!(r.append_media(&a, &p, &AtomicBool::new(false)).is_err());
    assert_eq!(fs::read(root.join("organization.json")).unwrap(), before);
    let current = r.reload_catalog().unwrap();
    assert!(current.manifest().media.is_empty());
    assert_eq!(current.catalog_revision(), catalog_before.as_ref());
    drop(blocker);
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    drop((current, p, a, r));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn missing_corrupt_unsafe_and_retired_heads_fail_without_rewriting() {
    let root = std::env::temp_dir().join(format!("invalid-head-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let path = root.join("organization.json");
    let original = fs::read(&path).unwrap();
    for bytes in [
        b"{".to_vec(),
        String::from_utf8(original.clone())
            .unwrap()
            .replace("\"formatVersion\":1", "\"formatVersion\":2")
            .into_bytes(),
        String::from_utf8(original.clone())
            .unwrap()
            .replace(&r.manifest().project_id, &id())
            .into_bytes(),
    ] {
        fs::write(&path, &bytes).unwrap();
        assert!(CollaborationRepository::open(&root).is_err());
        assert!(r
            .apply_organization(
                &a,
                0,
                OrganizationOperation::CreateFolder {
                    id: id(),
                    parent_id: None,
                    name: "x".into()
                }
            )
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    fs::write(&path, original).unwrap();
    let manifest_path = root.join("collaboration.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["catalogVersion"], 2);
    for version in [1, 2, 3, 4] {
        let mut old = manifest.clone();
        old["formatVersion"] = version.into();
        let bytes = serde_json::to_vec(&old).unwrap();
        fs::write(&manifest_path, &bytes).unwrap();
        assert!(CollaborationRepository::open(&root).is_err());
        assert_eq!(fs::read(&manifest_path).unwrap(), bytes);
    }
    drop((a, r));
    fs::remove_dir_all(root).unwrap();
}
fn wait(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !path.exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[test]
#[ignore = "isolated subprocess worker"]
fn organization_worker() {
    let root = std::path::PathBuf::from(std::env::var_os("ORGANIZATION_ROOT").unwrap());
    let name = std::env::var("ORGANIZATION_ROLE").unwrap();
    let r = CollaborationRepository::open(&root).unwrap();
    let profile = profiles::Profile::new(&name).unwrap();
    let a = r.adopt(&profile).unwrap();
    let revision = r.organization().revision;
    fs::write(root.join(format!("ready-{name}")), b"").unwrap();
    wait(&root.join("go"));
    let result = r.apply_organization(
        &a,
        revision,
        OrganizationOperation::CreateFolder {
            id: id(),
            parent_id: None,
            name: name.clone(),
        },
    );
    fs::write(
        root.join(format!("result-{name}")),
        match result {
            Ok(_) => b"committed".as_slice(),
            Err(error) => {
                assert_eq!(
                    error.code,
                    annotator_core::error::ErrorCode::RevisionConflict
                );
                b"conflict".as_slice()
            }
        },
    )
    .unwrap();
}
#[test]
fn cross_process_stale_mutations_do_not_lose_updates() {
    let root = std::env::temp_dir().join(format!("cas-head-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let mut children = vec![];
    for name in ["one", "two"] {
        children.push(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "organization_worker", "--ignored", "--nocapture"])
                .env("ORGANIZATION_ROOT", &root)
                .env("ORGANIZATION_ROLE", name)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    wait(&root.join("ready-one"));
    wait(&root.join("ready-two"));
    fs::write(root.join("go"), b"").unwrap();
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let results = [
        fs::read(root.join("result-one")).unwrap(),
        fs::read(root.join("result-two")).unwrap(),
    ];
    assert_eq!(
        results
            .iter()
            .filter(|r| r.as_slice() == b"committed")
            .count(),
        1
    );
    let current = r.read_organization().unwrap();
    assert_eq!(current.revision, 1);
    assert_eq!(current.folders.len(), 1);
    r.apply_organization(
        &a,
        current.revision,
        OrganizationOperation::CreateFolder {
            id: id(),
            parent_id: None,
            name: "third".into(),
        },
    )
    .unwrap();
    assert_eq!(r.read_organization().unwrap().folders.len(), 2);
    drop((a, r));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn directory_entries_cannot_impersonate_ignored_control_files() {
    let root = std::env::temp_dir().join(format!("unsafe-catalog-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    for name in [".foreign.tmp", ".commit.lock"] {
        let path = root.join("catalog").join(name);
        if path.is_file() {
            fs::remove_file(&path).unwrap();
        }
        fs::create_dir(&path).unwrap();
        let result = CollaborationRepository::open(&root);
        fs::remove_dir(path).unwrap();
        assert!(result.is_err(), "directory {name} must fail closed");
    }
    drop((a, r));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn sealed_native_placements_merge_additive_paths_and_refuse_changed_layout() {
    let root = std::env::temp_dir().join(format!("sealed-placement-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let plan = r
        .seal_media_placement(
            0,
            None,
            vec!["来源".into(), "分类".into()],
            "真实原名.WAV".into(),
        )
        .unwrap();
    let p = r
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap()
        .with_placement(plan)
        .unwrap();
    let plan = r
        .seal_media_placement(
            0,
            None,
            vec!["来源".into(), "分类".into()],
            "second.wav".into(),
        )
        .unwrap();
    let q = r
        .prepare_media(&source, &root.join("pcm2"), &AtomicBool::new(false))
        .unwrap()
        .with_placement(plan)
        .unwrap();
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    r.append_media(&a, &q, &AtomicBool::new(false)).unwrap();
    let head = r.read_organization().unwrap();
    assert_eq!(head.folders.len(), 2);
    assert_eq!(head.layout_revision, 0);
    assert_eq!(head.revision, 2);
    assert_eq!(head.media[0].folder_id, head.media[1].folder_id);
    assert_eq!(head.media[0].original_filename, "真实原名.WAV");
    let pending = r
        .prepare_media(&source, &root.join("pcm3"), &AtomicBool::new(false))
        .unwrap();
    let changed = r
        .apply_organization(
            &a,
            head.revision,
            OrganizationOperation::RenameFolder {
                id: head.folders[0].id.clone(),
                name: "renamed".into(),
            },
        )
        .unwrap();
    let bytes = fs::read(root.join("organization.json")).unwrap();
    assert_eq!(
        r.seal_media_placement(0, None, vec![], "original.wav".into())
            .unwrap_err()
            .code,
        annotator_core::error::ErrorCode::RevisionConflict
    );
    assert!(r
        .append_media(&a, &pending, &AtomicBool::new(false))
        .is_err());
    assert_eq!(fs::read(root.join("organization.json")).unwrap(), bytes);
    assert_eq!(changed.layout_revision, 1);
    assert!(r
        .seal_media_placement(1, None, vec!["..".into()], "name.wav".into())
        .is_err());
    assert!(r
        .seal_media_placement(1, Some(id()), vec![], "name.wav".into())
        .is_err());
    drop((pending, p, q, a, r));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn legacy_copy_uses_native_basename_and_verified_extension_only_when_missing() {
    let root = std::env::temp_dir().join(format!("copy-name-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (r, a) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = root.join("extensionless");
    fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/audio/mono16.wav"),
        &source,
    )
    .unwrap();
    let p = r
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    let mut expected = p.decoded().descriptor.clone();
    expected.display_name = "source/原始音频.wav".into();
    let copied = r
        .prepare_media_copy(
            &source,
            &root.join("pcm2"),
            &AtomicBool::new(false),
            &expected,
            |_, _| {},
        )
        .unwrap();
    r.append_media(&a, &copied, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        r.read_organization().unwrap().media[0].original_filename,
        "原始音频.wav"
    );
    expected.id = id();
    expected.display_name = "source/没有扩展名".into();
    let copied2 = r
        .prepare_media_copy(
            &source,
            &root.join("pcm3"),
            &AtomicBool::new(false),
            &expected,
            |_, _| {},
        )
        .unwrap();
    r.append_media(&a, &copied2, &AtomicBool::new(false))
        .unwrap();
    assert!(r
        .read_organization()
        .unwrap()
        .media
        .iter()
        .any(|m| m.original_filename == "没有扩展名.wav"));
    drop((copied2, copied, p, a, r));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn organization_limits_nullable_wire_fields_and_root_rules_are_strict() {
    let mut head = Organization::empty(id());
    for index in 1..=10_000 {
        head.folders.push(Folder {
            id: uuid::Uuid::from_u128(index).to_string(),
            parent_id: None,
            name: format!("Folder {index}"),
        });
    }
    head.validate().unwrap();
    head.folders.push(Folder {
        id: id(),
        parent_id: None,
        name: "overflow".into(),
    });
    assert!(head.validate().is_err());
    head.folders.clear();
    for index in 1..=10_000 {
        head.media.push(MediaMembership {
            media_id: uuid::Uuid::from_u128(index).to_string(),
            folder_id: None,
            original_filename: "a.wav".into(),
        });
    }
    head.validate().unwrap();
    head.media.push(MediaMembership {
        media_id: id(),
        folder_id: None,
        original_filename: "overflow.wav".into(),
    });
    assert!(head.validate().is_err());
    head.media.clear();
    let mut encoded = serde_json::to_value(&head).unwrap();
    encoded["folders"] = serde_json::json!([{"id":id(),"name":"missing parent"}]);
    assert!(Organization::parse(&serde_json::to_vec(&encoded).unwrap(), &head.project_id).is_err());
    encoded["folders"] = serde_json::json!([]);
    encoded["media"] =
        serde_json::json!([{"mediaId":id(),"originalFilename":"missing folder.wav"}]);
    assert!(Organization::parse(&serde_json::to_vec(&encoded).unwrap(), &head.project_id).is_err());
    for name in [
        "",
        " ",
        " leading",
        "trailing ",
        "bad\u{0085}control",
        "a/b",
        "a\\b",
    ] {
        assert!(head
            .apply(OrganizationOperation::CreateFolder {
                id: id(),
                parent_id: None,
                name: name.into()
            })
            .is_err());
    }
    assert!(head
        .apply(OrganizationOperation::RenameFolder {
            id: uuid::Uuid::nil().to_string(),
            name: "root".into()
        })
        .is_err());
    assert!(head
        .apply(OrganizationOperation::CreateFolder {
            id: id(),
            parent_id: Some(id()),
            name: "missing".into()
        })
        .is_err());
    head.revision = 9_007_199_254_740_991;
    head.layout_revision = head.revision;
    assert!(head
        .apply(OrganizationOperation::CreateFolder {
            id: id(),
            parent_id: None,
            name: "over revision".into()
        })
        .is_err());
    assert!(
        Organization::parse(&vec![b' '; MAX_ORGANIZATION_BYTES + 1], &head.project_id).is_err()
    );
}
fn assert_direct_basename_is_preserved(name: &str) {
    let root = std::env::temp_dir().join(format!("native-name-{}", id()));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (repo, actor) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = root.join(name);
    fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/audio/mono16.wav"),
        &source,
    )
    .unwrap();
    let prepared = repo
        .prepare_media(&source, &root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    repo.append_media(&actor, &prepared, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        repo.read_organization().unwrap().media[0].original_filename,
        name
    );
    drop((prepared, actor, repo));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn direct_extensionless_source_name_is_preserved_verbatim() {
    assert_direct_basename_is_preserved("recording");
}
#[test]
fn direct_255_scalar_source_name_is_preserved_verbatim() {
    assert_direct_basename_is_preserved(&"r".repeat(255));
}
#[test]
fn invalid_legacy_basename_falls_back_before_extension_synthesis() {
    let root = std::env::temp_dir().join(format!("legacy-invalid-name-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (repo, actor) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let baseline = repo
        .prepare_media(&source, &root.join("baseline"), &AtomicBool::new(false))
        .unwrap();
    let mut descriptor = baseline.decoded().descriptor.clone();
    for last_component in [
        "".into(),
        ".".into(),
        "..".into(),
        "bad\u{0085}name".into(),
        "r".repeat(256),
        "r".repeat(255),
    ] {
        descriptor.id = id();
        descriptor.display_name = format!("source/{last_component}");
        let prepared = repo
            .prepare_media_copy(
                &source,
                &root.join("copy"),
                &AtomicBool::new(false),
                &descriptor,
                |_, _| {},
            )
            .unwrap();
        repo.append_media(&actor, &prepared, &AtomicBool::new(false))
            .unwrap();
        let head = repo.read_organization().unwrap();
        let membership = head
            .media
            .iter()
            .find(|m| m.media_id == descriptor.id)
            .unwrap();
        assert_eq!(
            membership.original_filename,
            format!("{}.wav", descriptor.id),
            "legacy component {last_component:?}"
        );
    }
    drop((baseline, actor, repo));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn placement_validation_errors_create_no_media_staging_and_preserve_foreign_files() {
    let root = std::env::temp_dir().join(format!("placement-no-leak-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("Test").unwrap();
    let (repo, actor) = CollaborationRepository::create_default(&root, "Test", &profile).unwrap();
    let source = root.join("source.wav");
    let invalid_source = root.join("bad\u{0085}name.wav");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    fs::copy(&fixture, &source).unwrap();
    fs::copy(&fixture, &invalid_source).unwrap();
    let foreign = root.join("media/.foreign.tmp");
    fs::write(&foreign, b"foreign staging sentinel").unwrap();
    let head_path = root.join("organization.json");
    let head_bytes = fs::read(&head_path).unwrap();
    for mode in ["missing", "corrupt", "filename"] {
        fs::write(&head_path, &head_bytes).unwrap();
        if mode == "missing" {
            fs::remove_file(&head_path).unwrap();
        }
        if mode == "corrupt" {
            fs::write(&head_path, b"{broken").unwrap();
        }
        let before = fs::read_dir(root.join("media"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        let result = repo.prepare_media(
            if mode == "filename" {
                &invalid_source
            } else {
                &source
            },
            &root.join("pcm"),
            &AtomicBool::new(false),
        );
        assert!(result.is_err(), "{mode} must refuse preparation");
        let after = fs::read_dir(root.join("media"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            after, before,
            "{mode} must not leak an owned media temporary"
        );
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign staging sentinel");
        if mode == "corrupt" {
            assert_eq!(fs::read(&head_path).unwrap(), b"{broken");
        }
        if mode == "missing" {
            assert!(!head_path.exists());
        }
    }
    drop((actor, repo));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn opaque_layout_capture_seals_multiple_candidates_without_reopening_the_head() {
    let root = std::env::temp_dir().join(format!("layout-capture-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("capture").unwrap();
    let (repo, actor) =
        CollaborationRepository::create_default(&root, "capture", &profile).unwrap();
    let capture = repo.capture_media_placement(None).unwrap();
    assert_eq!(capture.layout_revision(), 0);
    assert!(capture.target_path().is_empty());
    let bytes = fs::read(root.join("organization.json")).unwrap();
    fs::remove_file(root.join("organization.json")).unwrap();
    let one = capture
        .seal(vec!["shared".into()], "one.wav".into())
        .unwrap();
    let two = capture
        .seal(vec!["shared".into()], "two.wav".into())
        .unwrap();
    assert!(capture.seal(vec!["..".into()], "bad.wav".into()).is_err());
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let prepared = repo
        .prepare_media_with_placement(
            &source,
            &root.join("pcm"),
            &AtomicBool::new(false),
            one,
            |_, _| {},
        )
        .unwrap();
    fs::write(root.join("organization.json"), bytes).unwrap();
    let next = repo
        .apply_organization(
            &actor,
            0,
            OrganizationOperation::CreateFolder {
                id: id(),
                parent_id: None,
                name: "manual".into(),
            },
        )
        .unwrap();
    assert_ne!(capture.layout_revision(), next.layout_revision);
    assert!(repo
        .append_media(&actor, &prepared, &AtomicBool::new(false))
        .is_err());
    drop((two, prepared, capture, actor, repo));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn loaded_placement_capture_uses_one_validated_snapshot_and_publication_rechecks_layout() {
    let root = std::env::temp_dir().join(format!("loaded-capture-{}", id()));
    fs::create_dir(&root).unwrap();
    let profile = profiles::Profile::new("capture").unwrap();
    let (repo, actor) =
        CollaborationRepository::create_default(&root, "capture", &profile).unwrap();
    let target = id();
    repo.apply_organization(
        &actor,
        0,
        OrganizationOperation::CreateFolder {
            id: target.clone(),
            parent_id: None,
            name: "old".into(),
        },
    )
    .unwrap();
    let current = repo.reload_catalog().unwrap();
    repo.apply_organization(
        &actor,
        1,
        OrganizationOperation::RenameFolder {
            id: target.clone(),
            name: "new".into(),
        },
    )
    .unwrap();
    let capture = current
        .capture_loaded_media_placement(Some(target.clone()))
        .unwrap();
    assert_eq!(capture.target_path(), ["old"]);
    assert_eq!(capture.layout_revision(), 1);
    let fresh = current
        .reload_catalog()
        .unwrap()
        .capture_loaded_media_placement(Some(target))
        .unwrap();
    assert_eq!(fresh.target_path(), ["new"]);
    assert_eq!(fresh.layout_revision(), 2);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/audio/mono16.wav");
    let prepared = current
        .prepare_media_with_placement(
            &source,
            &root.join("pcm"),
            &AtomicBool::new(false),
            capture.seal(vec![], "one.wav".into()).unwrap(),
            |_, _| {},
        )
        .unwrap();
    assert_eq!(
        current
            .append_media(&actor, &prepared, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        annotator_core::error::ErrorCode::RevisionConflict
    );
    drop((prepared, current, actor, repo));
    fs::remove_dir_all(root).unwrap();
}
