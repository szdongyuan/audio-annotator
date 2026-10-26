use annotator_core::media::{decode::decode, identity::fingerprint};
use annotator_core::{
    error::ErrorCode,
    exchange::{export_annotations, export_bundle, import_exchange, Limits},
    model::ProjectDocument,
};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
fn root() -> PathBuf {
    let base = std::env::var_os("ANNOTATOR_EXCHANGE_TEST_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let p = base.join(format!("exchange-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&p).unwrap();
    p
}
fn document() -> ProjectDocument {
    ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v3.json")).unwrap()
}
#[test]
fn json_preserves_all_semantics_without_source_paths_and_imports_missing_media() {
    let r = root();
    let mut d = document();
    d.media[0].source_ref = "C:/private/source.wav".into();
    classify(&mut d);
    let p = r.join("notes.annotations.json");
    let cancel = AtomicBool::new(false);
    export_annotations(&d, &p, &cancel, Limits::default(), |_, _| {}).unwrap();
    let raw = fs::read_to_string(&p).unwrap();
    assert!(!raw.contains("C:/private"));
    assert!(!raw.contains("sourceRef"));
    let imported = import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {}).unwrap();
    assert_ne!(imported.document.project_id, d.project_id);
    assert!(imported.path.join("project.json").exists());
    d.project_id = imported.document.project_id.clone();
    d.media[0].source_ref = imported.document.media[0].source_ref.clone();
    assert_eq!(d, imported.document);
    assert!(!imported.path.join(&d.media[0].source_ref).exists());
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn bundle_preserves_original_bytes_and_fails_missing_sources_atomically() {
    let r = root();
    let d = document();
    let cancel = AtomicBool::new(false);
    let p = r.join("project.audioproj.zip");
    assert_eq!(
        export_bundle(&d, &r, &p, &cancel, Limits::default(), |_, _| {})
            .unwrap_err()
            .code,
        ErrorCode::MissingMedia
    );
    assert!(!p.exists());
    assert_eq!(fs::read_dir(&r).unwrap().count(), 0);
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn rejects_unknown_versions_fields_dangling_references_and_bounds() {
    let r = root();
    let p = r.join("bad.annotations.json");
    let cancel = AtomicBool::new(false);
    export_annotations(&document(), &p, &cancel, Limits::default(), |_, _| {}).unwrap();
    let raw: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    for (pointer, value, expected) in [
        (
            "/formatVersion",
            serde_json::json!(5),
            ErrorCode::UnsupportedVersion,
        ),
        (
            "/annotations/0/region/highHz",
            serde_json::json!(999999),
            ErrorCode::InvalidInput,
        ),
        (
            "/annotations/0/categoryIds",
            serde_json::json!(["00000000-0000-4000-8000-000000000099"]),
            ErrorCode::InvalidInput,
        ),
    ] {
        let mut bad = raw.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        fs::write(&p, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert_eq!(
            import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {})
                .unwrap_err()
                .code,
            expected
        );
    }
    let mut bad = raw;
    bad["secret"] = serde_json::json!(true);
    fs::write(&p, serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {}).is_err());
    assert_eq!(fs::read_dir(&r).unwrap().count(), 1);
    fs::remove_dir_all(r).unwrap();
}
fn real_document(r: &Path) -> ProjectDocument {
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/stereo24.wav");
    let decoded = decode(
        &source,
        &r.join("cache"),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    let mut d = document();
    let old = d.media[0].clone();
    let mut m = decoded.descriptor.clone();
    m.id = old.id;
    m.note = old.note;
    m.channel_notes = old.channel_notes;
    // Fixture is 0.1 seconds; retain all semantic fields with valid regions.
    d.annotations[0].region.start_seconds = 0.02;
    d.annotations[0].region.end_seconds = 0.08;
    d.edits[0].region.end_seconds = 0.1;
    d.media[0] = m;
    d.validate().unwrap();
    d
}
#[test]
fn zip_roundtrip_matches_every_semantic_field_and_original_bytes() {
    let r = root();
    let mut d = real_document(&r);
    classify(&mut d);
    let p = r.join("full.audioproj.zip");
    let cancel = AtomicBool::new(false);
    let hash = fingerprint(Path::new(&d.media[0].source_ref), &cancel, |_| {}).unwrap();
    export_bundle(&d, &r, &p, &cancel, Limits::default(), |_, _| {}).unwrap();
    let imported = import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {}).unwrap();
    assert_ne!(d.project_id, imported.document.project_id);
    d.project_id = imported.document.project_id.clone();
    let source = d.media[0].source_ref.clone();
    d.media[0].source_ref = imported.document.media[0].source_ref.clone();
    assert_eq!(d, imported.document);
    assert_eq!(
        fingerprint(&imported.path.join(&d.media[0].source_ref), &cancel, |_| {}).unwrap(),
        hash
    );
    assert_eq!(
        fingerprint(Path::new(&source), &cancel, |_| {}).unwrap(),
        hash
    );
    assert_eq!(fs::read_dir(&imported.path).unwrap().count(), 2);
    fs::remove_dir_all(r).unwrap();
}
fn archive(p: &Path, entries: &[(&str, &[u8])]) {
    let mut z = zip::ZipWriter::new(fs::File::create(p).unwrap());
    for (name, data) in entries {
        if name.ends_with('/') {
            z.add_directory(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            continue;
        }
        z.start_file(
            *name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        z.write_all(data).unwrap();
    }
    z.finish().unwrap();
}
#[test]
fn hostile_paths_case_collisions_links_and_limits_leave_only_input_files() {
    let r = root();
    let p = r.join("bad.zip");
    let cancel = AtomicBool::new(false);
    for name in [
        "../escape",
        "C:/escape",
        "//server/share",
        "a\\b",
        "CON.txt",
        "media/AUX",
        "media/a:stream",
        "media/a.",
        "media/a ",
        "/absolute",
    ] {
        archive(&p, &[(name, b"test")]);
        assert!(
            import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {}).is_err(),
            "{name}"
        );
        assert_eq!(fs::read_dir(&r).unwrap().count(), 1);
    }
    archive(&p, &[("media/a", b"a"), ("media/A", b"b")]);
    assert_eq!(
        import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {})
            .unwrap_err()
            .code,
        ErrorCode::InvalidArchive
    );
    let mut z = zip::ZipWriter::new(fs::File::create(&p).unwrap());
    z.add_symlink(
        "media/link",
        "../../escape",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    z.finish().unwrap();
    assert_eq!(
        import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {})
            .unwrap_err()
            .code,
        ErrorCode::InvalidArchive
    );
    archive(&p, &[("a", b"a"), ("b", b"b")]);
    assert_eq!(
        import_exchange(
            &p,
            &r,
            &cancel,
            Limits {
                entries: 1,
                ..Limits::default()
            },
            |_, _| {}
        )
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
    fs::write(&p, vec![b' '; 1025]).unwrap();
    assert_eq!(
        import_exchange(
            &p,
            &r,
            &cancel,
            Limits {
                manifest_bytes: 1024,
                ..Limits::default()
            },
            |_, _| {}
        )
        .unwrap_err()
        .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(fs::read_dir(&r).unwrap().count(), 1);
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn limits_use_actual_stream_counts_and_cancel_cleans_owned_staging_only() {
    let r = root();
    let d = real_document(&r);
    let p = r.join("full.zip");
    let cancel = AtomicBool::new(false);
    export_bundle(&d, &r, &p, &cancel, Limits::default(), |_, _| {}).unwrap();
    let before = fs::read_dir(&r).unwrap().count();
    for limits in [
        Limits {
            total_bytes: 4000,
            ..Limits::default()
        },
        Limits {
            media_bytes: 1,
            ..Limits::default()
        },
        Limits {
            manifest_bytes: 100,
            ..Limits::default()
        },
    ] {
        assert_eq!(
            import_exchange(&p, &r, &cancel, limits, |_, _| {})
                .unwrap_err()
                .code,
            ErrorCode::ResourceLimit
        );
        assert_eq!(fs::read_dir(&r).unwrap().count(), before);
    }
    assert_eq!(
        import_exchange(&p, &r, &cancel, Limits::default(), |phase, _| {
            if phase == "校验并提取媒体" {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err()
        .code,
        ErrorCode::Cancelled
    );
    assert_eq!(fs::read_dir(&r).unwrap().count(), before);
    assert!(r.join("cache").exists());
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn export_refuses_changed_missing_and_existing_targets_and_cancel_never_publishes() {
    let r = root();
    let mut d = real_document(&r);
    classify(&mut d);
    let source = r.join("source.wav");
    fs::copy(&d.media[0].source_ref, &source).unwrap();
    d.media[0].source_ref = source.to_string_lossy().into();
    let p = r.join("full.zip");
    let cancel = AtomicBool::new(false);
    let mut changed = fs::read(&source).unwrap();
    changed[50] ^= 1;
    fs::write(&source, &changed).unwrap();
    assert_eq!(
        export_bundle(&d, &r, &p, &cancel, Limits::default(), |_, _| {})
            .unwrap_err()
            .code,
        ErrorCode::IdentityMismatch
    );
    assert!(!p.exists());
    fs::write(&p, b"existing").unwrap();
    assert!(export_annotations(&d, &p, &cancel, Limits::default(), |_, _| {}).is_err());
    assert_eq!(fs::read(&p).unwrap(), b"existing");
    let other = r.join("cancel.json");
    assert_eq!(
        export_annotations(&d, &other, &cancel, Limits::default(), |_, _| cancel
            .store(true, Ordering::Relaxed))
        .unwrap_err()
        .code,
        ErrorCode::Cancelled
    );
    assert!(!other.exists());
    assert!(!fs::read_dir(&r).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".exchange-")));
    fs::remove_dir_all(r).unwrap();
}

#[test]
fn zip_rejects_fingerprint_metadata_unknown_fields_and_unlisted_files() {
    let r = root();
    let d = real_document(&r);
    let source = fs::read(&d.media[0].source_ref).unwrap();
    let p = r.join("invalid.zip");
    let captured = annotator_core::exchange::Manifest::capture(&d, true).unwrap();
    let media_path = captured.media[0].media_path.clone().unwrap();
    let cancel = AtomicBool::new(false);
    let value =
        serde_json::to_value(annotator_core::exchange::Manifest::capture(&d, true).unwrap())
            .unwrap();
    for mutation in ["hash", "metadata", "unknown", "extra"] {
        let mut bad = value.clone();
        match mutation {
            "hash" => bad["media"][0]["sha256"] = serde_json::json!("b".repeat(64)),
            "metadata" => bad["media"][0]["frameCount"] = serde_json::json!(9600),
            "unknown" => bad["media"][0]["secret"] = serde_json::json!(true),
            _ => (),
        }
        let manifest = serde_json::to_vec(&bad).unwrap();
        let mut entries = vec![
            ("audio/", b"".as_slice()),
            ("manifest.json", manifest.as_slice()),
            (media_path.as_str(), source.as_slice()),
        ];
        if mutation == "extra" {
            entries.push(("recovery.json", b"not included"));
        }
        archive(&p, &entries);
        let error = import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {}).unwrap_err();
        assert_eq!(
            error.code,
            if mutation == "hash" || mutation == "metadata" {
                ErrorCode::IdentityMismatch
            } else {
                ErrorCode::InvalidArchive
            }
        );
        assert!(!fs::read_dir(&r).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".exchange-")));
    }
    fs::remove_dir_all(r).unwrap();
}

#[test]
fn source_mutation_during_copy_never_publishes_partial_package() {
    let r = root();
    let mut d = real_document(&r);
    classify(&mut d);
    let source = r.join("source.wav");
    fs::copy(&d.media[0].source_ref, &source).unwrap();
    d.media[0].source_ref = source.to_string_lossy().into();
    let p = r.join("full.zip");
    let error = export_bundle(
        &d,
        &r,
        &p,
        &AtomicBool::new(false),
        Limits::default(),
        |phase, _| {
            if phase == "复制原始媒体" {
                let file = fs::OpenOptions::new().write(true).open(&source).unwrap();
                file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(3))
                    .unwrap();
            }
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::IdentityMismatch);
    assert!(!p.exists());
    assert!(!fs::read_dir(&r).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".exchange-")));
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn bundle_two_formats_reimports_without_validation_cache() {
    let r = root();
    let mut d = real_document(&r);
    classify(&mut d);
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/six.flac");
    let decoded = decode(&file, &r.join("cache"), &AtomicBool::new(false), |_, _| {}).unwrap();
    let m = decoded.descriptor.clone();
    drop(decoded);
    d.analysis.insert(m.id.clone(), Default::default());
    d.playback_mix.insert(m.id.clone(), Default::default());
    d.media.push(m);
    let p = r.join("two.zip");
    export_bundle(
        &d,
        &r,
        &p,
        &AtomicBool::new(false),
        Limits::default(),
        |_, _| {},
    )
    .unwrap();
    let result = import_exchange(
        &p,
        &r,
        &AtomicBool::new(false),
        Limits::default(),
        |_, _| {},
    )
    .unwrap();
    assert_eq!(result.document.media.len(), 2);
    assert!(!result.path.join(".validation").exists());
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn zip64_index_is_validated_without_large_test_files() {
    let r = root();
    let d = real_document(&r);
    let p = r.join("zip64.zip");
    let cancel = AtomicBool::new(false);
    export_bundle(&d, &r, &p, &cancel, Limits::default(), |_, _| {}).unwrap();
    let mut bytes = fs::read(&p).unwrap();
    let at = bytes.len() - 22;
    let mut end = bytes.split_off(at);
    let count = u16::from_le_bytes(end[10..12].try_into().unwrap()) as u64;
    let size = u32::from_le_bytes(end[12..16].try_into().unwrap()) as u64;
    let offset = u32::from_le_bytes(end[16..20].try_into().unwrap()) as u64;
    bytes.extend_from_slice(b"PK\x06\x06");
    bytes.extend_from_slice(&44_u64.to_le_bytes());
    bytes.extend_from_slice(&45_u16.to_le_bytes());
    bytes.extend_from_slice(&45_u16.to_le_bytes());
    bytes.extend_from_slice(&[0; 8]);
    bytes.extend_from_slice(&count.to_le_bytes());
    bytes.extend_from_slice(&count.to_le_bytes());
    bytes.extend_from_slice(&size.to_le_bytes());
    bytes.extend_from_slice(&offset.to_le_bytes());
    bytes.extend_from_slice(b"PK\x06\x07");
    bytes.extend_from_slice(&[0; 4]);
    bytes.extend_from_slice(&(at as u64).to_le_bytes());
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    end[8..20].fill(255);
    bytes.extend_from_slice(&end);
    fs::write(&p, &bytes).unwrap();
    assert!(import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {}).is_ok());
    bytes[at + 4..at + 12].copy_from_slice(&u64::MAX.to_le_bytes());
    fs::write(&p, bytes).unwrap();
    assert_eq!(
        import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {})
            .unwrap_err()
            .code,
        ErrorCode::InvalidArchive
    );
    fs::remove_dir_all(r).unwrap();
}

fn classify(d: &mut ProjectDocument) {
    d.media[0].category_ids = vec![d.categories[0].id.clone()];
    d.media[0].channel_category_ids[1] = vec![d.categories[0].id.clone()];
    d.view_state.compare_layout = annotator_core::model::CompareLayout::Vertical;
    d.view_state.compare_split = 0.7;
}
#[test]
fn portable_v4_rejects_missing_nullable_fields_unknown_fields_and_local_paths() {
    use annotator_core::exchange::Manifest;
    let current = serde_json::to_value(Manifest::capture(&document(), false).unwrap()).unwrap();
    {
        let original = current;
        for (pointer, key) in [
            ("/media/0", "channelLayout"),
            ("/media/0", "mediaPath"),
            ("/annotations/0", "categoryIds"),
            ("/viewState", "activeMediaId"),
        ] {
            let mut bad = original.clone();
            bad.pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(Manifest::parse(&serde_json::to_vec(&bad).unwrap(), false).is_err());
        }
        for key in ["sourceRef", "typo"] {
            let mut bad = original.clone();
            bad["media"][0][key] = serde_json::json!("C:/private.wav");
            assert!(Manifest::parse(&serde_json::to_vec(&bad).unwrap(), false).is_err());
        }
    }
    let original = serde_json::to_value(Manifest::capture(&document(), false).unwrap()).unwrap();
    for (pointer, key) in [
        ("/media/0", "categoryIds"),
        ("/media/0", "channelCategoryIds"),
        ("/viewState", "compareLayout"),
        ("/viewState", "compareSplit"),
    ] {
        let mut bad = original.clone();
        bad.pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(Manifest::parse(&serde_json::to_vec(&bad).unwrap(), false).is_err());
    }
}

#[test]
fn portable_v1_and_future_versions_are_explicitly_unsupported() {
    use annotator_core::exchange::Manifest;
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/document-v1.json")).unwrap();
    for media in value["media"].as_array_mut().unwrap() {
        media.as_object_mut().unwrap().remove("sourceRef");
        media["mediaPath"] = serde_json::Value::Null;
    }
    let r = root();
    let cancel = AtomicBool::new(false);
    for version in [1, 2, 3, 5] {
        value["formatVersion"] = serde_json::json!(version);
        let bytes = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            Manifest::parse(&bytes, false).unwrap_err().code,
            ErrorCode::UnsupportedVersion
        );
        for bundle in [false, true] {
            let source = r.join(if bundle {
                "unsupported.zip"
            } else {
                "unsupported.json"
            });
            if bundle {
                archive(&source, &[("manifest.json", &bytes)]);
            } else {
                fs::write(&source, &bytes).unwrap();
            }
            let original = fs::read(&source).unwrap();
            assert_eq!(
                import_exchange(&source, &r, &cancel, Limits::default(), |_, _| {})
                    .unwrap_err()
                    .code,
                ErrorCode::UnsupportedVersion
            );
            assert_eq!(fs::read(&source).unwrap(), original);
            fs::remove_file(source).unwrap();
            assert_eq!(fs::read_dir(&r).unwrap().count(), 0);
        }
    }
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn directory_path_plan_is_windows_safe_deterministic_and_preserves_extensions() {
    use annotator_core::{
        collaboration::organization::{Folder, MediaMembership, Organization},
        exchange::ExportPathPlan,
    };
    let d = document();
    let mut org = Organization::empty(d.project_id.clone());
    let folder_id = "00000000-0000-4000-8000-000000000001".to_owned();
    org.folders.push(Folder {
        id: folder_id.clone(),
        parent_id: None,
        name: "CON.wav".into(),
    });
    org.folders.push(Folder {
        id: "00000000-0000-4000-8000-000000000002".into(),
        parent_id: None,
        name: "空目录".into(),
    });
    org.media.push(MediaMembership {
        media_id: d.media[0].id.clone(),
        folder_id: None,
        original_filename: "con.wav".into(),
    });
    let plan = ExportPathPlan::build(&d, &org, true, true).unwrap();
    assert!(plan.directories.contains(&"audio/空目录/".to_owned()));
    let path = &plan.media_paths[&d.media[0].id];
    assert!(path.starts_with("audio/_con-"), "{path}");
    assert!(path.ends_with(".wav"));
    assert!(path.contains(&d.media[0].id));
    let mut reversed = org.clone();
    reversed.folders.reverse();
    let reordered = ExportPathPlan::build(&d, &reversed, true, true).unwrap();
    assert_eq!(plan.media_paths, reordered.media_paths);
    assert_eq!(plan.directories, reordered.directories);
    org.media[0].original_filename = format!("{}.flac", "音".repeat(150));
    let long = ExportPathPlan::build(&d, &org, true, true).unwrap();
    let basename = long.media_paths[&d.media[0].id].rsplit('/').next().unwrap();
    assert!(basename.encode_utf16().count() <= 120);
    assert!(basename.ends_with(&format!("-{}.flac", d.media[0].id)));
    for device in ["COM¹.wav", "LPT².mp3", "LPT³", "AUX", "NUL.txt", "COM9"] {
        org.media[0].original_filename = device.into();
        assert!(ExportPathPlan::build(&d, &org, true, false)
            .unwrap()
            .media_paths[&d.media[0].id]
            .starts_with("audio/_"));
    }
}

#[test]
fn physical_limits_apply_only_to_emitted_paths_and_logical_metadata_roundtrips() {
    use annotator_core::{
        collaboration::organization::{Folder, MediaMembership, Organization},
        exchange::{export_annotations_with_plan, export_bundle_with_plan, ExportPathPlan},
    };
    let r = root();
    let d = real_document(&r);
    let cancel = AtomicBool::new(false);
    let mut org = Organization::empty(d.project_id.clone());
    let mut parent = None;
    for i in 0..4 {
        let id = format!("00000000-0000-4000-8000-{:012}", i + 1);
        org.folders.push(Folder {
            id: id.clone(),
            parent_id: parent,
            name: "长目录".repeat(30),
        });
        parent = Some(id);
    }
    org.media.push(MediaMembership {
        media_id: d.media[0].id.clone(),
        folder_id: parent,
        original_filename: "原始音频.wav".into(),
    });
    assert!(ExportPathPlan::build(&d, &org, true, true)
        .unwrap_err()
        .message
        .contains("平铺"));
    let json = ExportPathPlan::build(&d, &org, false, true).unwrap();
    let json_path = r.join("logical.json");
    export_annotations_with_plan(&d, &json, &json_path, &cancel, Limits::default(), |_, _| {})
        .unwrap();
    let flat = ExportPathPlan::build(&d, &org, true, false).unwrap();
    let zip_path = r.join("flat.zip");
    export_bundle_with_plan(
        &d,
        &flat,
        &r,
        &zip_path,
        &cancel,
        Limits::default(),
        |_, _| {},
    )
    .unwrap();
    let imported = import_exchange(&zip_path, &r, &cancel, Limits::default(), |_, _| {}).unwrap();
    let mut expected = org.clone();
    expected.project_id = imported.document.project_id.clone();
    assert_eq!(imported.organization, expected);
    assert_eq!(imported.document.media[0].source_ref, "audio/原始音频.wav");
    let mut archive = zip::ZipArchive::new(fs::File::open(zip_path).unwrap()).unwrap();
    assert_eq!(archive.len(), 3);
    assert!(archive.by_name("audio/").unwrap().is_dir());
    org.folders.truncate(1);
    org.media[0].folder_id = Some(org.folders[0].id.clone());
    org.folders[0].name = "中文目录".into();
    org.folders.push(Folder {
        id: "00000000-0000-4000-8000-000000000099".into(),
        parent_id: None,
        name: "空目录".into(),
    });
    let preserved = ExportPathPlan::build(&d, &org, true, true).unwrap();
    let p = r.join("preserved.zip");
    export_bundle_with_plan(
        &d,
        &preserved,
        &r,
        &p,
        &cancel,
        Limits::default(),
        |_, _| {},
    )
    .unwrap();
    let restored = import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {}).unwrap();
    assert_eq!(restored.organization.folders, org.folders);
    assert_eq!(restored.organization.media, org.media);
    assert_eq!(
        fs::read(restored.path.join(&restored.document.media[0].source_ref)).unwrap(),
        fs::read(&d.media[0].source_ref).unwrap()
    );
    fs::remove_dir_all(r).unwrap();
}
#[test]
fn preview_reports_changed_empty_folder_paths_and_secondary_collision_namespace() {
    use annotator_core::{
        collaboration::organization::{Folder, MediaMembership, Organization},
        exchange::ExportPathPlan,
    };
    let d = document();
    let mut org = Organization::empty(d.project_id.clone());
    let id = d.media[0].id.clone();
    org.folders.push(Folder {
        id: id.clone(),
        parent_id: None,
        name: "CON.wav".into(),
    });
    org.folders.push(Folder {
        id: "00000000-0000-4000-8000-000000000008".into(),
        parent_id: None,
        name: format!("_CON.wav-{id}"),
    });
    org.folders.push(Folder {
        id: "00000000-0000-4000-8000-000000000009".into(),
        parent_id: None,
        name: "bad<>name. ".trim_end().into(),
    });
    org.media.push(MediaMembership {
        media_id: id,
        folder_id: None,
        original_filename: "con.wav".into(),
    });
    let plan = ExportPathPlan::build(&d, &org, true, true).unwrap();
    assert!(plan.changes.iter().any(|c| c.kind == "folder"
        && c.original_path == "audio/CON.wav/"
        && c.planned_path.starts_with("audio/_CON.wav-")));
    assert!(plan
        .changes
        .iter()
        .any(|c| c.kind == "folder" && c.original_path == "audio/bad<>name./"));
    let names: std::collections::HashSet<_> = plan
        .directories
        .iter()
        .map(|s| s.trim_end_matches('/').to_lowercase())
        .chain(plan.media_paths.values().map(|s| s.to_lowercase()))
        .collect();
    assert_eq!(names.len(), plan.directories.len() + plan.media_paths.len());
}
#[test]
fn exchange4_raw_preflight_rejects_duplicate_and_wrong_directory_records_before_extraction() {
    let r = root();
    let cancel = AtomicBool::new(false);
    let p = r.join("raw.zip");
    archive(&p, &[("a", b""), ("b", b"")]);
    let mut bytes = fs::read(&p).unwrap();
    let central: Vec<_> = bytes
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"PK\x01\x02")
        .map(|(i, _)| i)
        .collect();
    bytes[central[1] + 46] = b'a';
    fs::write(&p, &bytes).unwrap();
    assert_eq!(
        import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {})
            .unwrap_err()
            .code,
        ErrorCode::InvalidArchive
    );
    for name in ["audio/", "audio/file.wav"] {
        archive(&p, &[(name, b"")]);
        let original = fs::read(&p).unwrap();
        let at = original
            .windows(4)
            .position(|w| w == b"PK\x01\x02")
            .unwrap();
        let mut bad = original;
        let mode: u32 = if name.ends_with('/') {
            0o100644 << 16
        } else {
            (0o040755 << 16) | 0x10
        };
        bad[at + 38..at + 42].copy_from_slice(&mode.to_le_bytes());
        fs::write(&p, bad).unwrap();
        assert_eq!(
            import_exchange(&p, &r, &cancel, Limits::default(), |_, _| {})
                .unwrap_err()
                .code,
            ErrorCode::InvalidArchive
        );
    }
    let limits = Limits::default();
    assert_eq!(limits.entries, 20002);
    assert_eq!(limits.manifest_bytes, 32 * 1024 * 1024);
    let mut z = zip::ZipWriter::new(fs::File::create(&p).unwrap());
    for i in 0..20003 {
        z.add_directory(
            format!("audio/d{i}/"),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    }
    z.finish().unwrap();
    assert_eq!(
        import_exchange(&p, &r, &cancel, limits, |_, _| {})
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(fs::read_dir(&r).unwrap().count(), 1);
    fs::remove_dir_all(r).unwrap();
}

#[test]
fn manifest_rejects_unbounded_logical_head_even_when_flat_paths_are_short() {
    use annotator_core::{
        collaboration::organization::{Folder, MediaMembership, Organization},
        exchange::ExportPathPlan,
    };
    let mut d = document();
    let template = d.media[0].clone();
    d.media.clear();
    let mut org = Organization::empty(d.project_id.clone());
    for i in 1..=10000 {
        let id = if i == 1 {
            template.id.clone()
        } else {
            format!("10000000-0000-4000-8000-{i:012}")
        };
        let mut media = template.clone();
        media.id = id.clone();
        d.analysis.insert(id.clone(), Default::default());
        d.playback_mix.insert(id.clone(), Default::default());
        d.media.push(media);
        org.folders.push(Folder {
            id: id.clone(),
            parent_id: if i == 1 {
                None
            } else {
                Some(template.id.clone())
            },
            name: format!("{i}{}", "𠀀".repeat(123)),
        });
        org.media.push(MediaMembership {
            media_id: id,
            folder_id: Some(template.id.clone()),
            original_filename: "𠀀".repeat(255),
        });
    }
    org.validate().unwrap();
    d.validate().unwrap();
    assert!(serde_json::to_vec(&org).unwrap().len() > 16 * 1024 * 1024);
    assert!(
        matches!(ExportPathPlan::build(&d,&org,false,true),Err(e) if e.code==ErrorCode::ResourceLimit)
    );
}
#[test]
fn manifest4_rejects_duplicate_json_fields_and_exact_membership_mismatches() {
    use annotator_core::exchange::Manifest;
    let manifest = Manifest::capture(&document(), false).unwrap();
    let bytes = serde_json::to_string(&manifest).unwrap();
    let duplicate = bytes.replacen(
        "\"formatVersion\":4",
        "\"formatVersion\":4,\"formatVersion\":4",
        1,
    );
    assert!(Manifest::parse(duplicate.as_bytes(), false).is_err());
    for field in ["organization", "preserveFolders"] {
        let mut value = serde_json::to_value(&manifest).unwrap();
        value.as_object_mut().unwrap().remove(field);
        assert!(Manifest::parse(&serde_json::to_vec(&value).unwrap(), false).is_err());
    }
    let mut value = serde_json::to_value(&manifest).unwrap();
    value["organization"]["media"] = serde_json::json!([]);
    assert!(Manifest::parse(&serde_json::to_vec(&value).unwrap(), false).is_err());
    value = serde_json::to_value(&manifest).unwrap();
    value["organization"]["projectId"] = serde_json::json!("00000000-0000-4000-8000-000000000099");
    assert!(Manifest::parse(&serde_json::to_vec(&value).unwrap(), false).is_err());
}

#[test]
fn multilabel_exchange4_boundary_and_unicode_tree_roundtrip() {
    use annotator_core::{
        collaboration::organization::{Folder, MediaMembership, Organization},
        exchange::{
            export_annotations_with_plan, export_bundle_with_plan, ExportPathPlan, Manifest,
        },
    };
    let r = root();
    let mut d = real_document(&r);
    let second = annotator_core::model::Category {
        id: "00000000-0000-4000-8000-000000000077".into(),
        name: "第二标签".into(),
        color: "#123456".into(),
    };
    let ids = vec![second.id.clone(), d.categories[0].id.clone()];
    d.categories.push(second);
    d.media[0].category_ids = ids.clone();
    d.media[0].channel_category_ids[0] = ids.clone();
    d.annotations[0].category_ids = ids;
    let source_before = fs::read(&d.media[0].source_ref).unwrap();
    let mut org = Organization::empty(d.project_id.clone());
    let folder = "00000000-0000-4000-8000-000000000078".to_owned();
    org.folders.push(Folder {
        id: folder.clone(),
        parent_id: None,
        name: "中文目录 🎵".into(),
    });
    org.media.push(MediaMembership {
        media_id: d.media[0].id.clone(),
        folder_id: Some(folder),
        original_filename: "原始音频.wav".into(),
    });
    let cancel = AtomicBool::new(false);
    for bundle in [false, true] {
        let plan = ExportPathPlan::build(&d, &org, bundle, true).unwrap();
        let mut manifest = Manifest::capture_with_plan(&d, &plan).unwrap();
        assert_eq!(manifest.format_version, 4);
        manifest.format_version = 3;
        assert_eq!(
            manifest.document(false).unwrap_err().code,
            ErrorCode::UnsupportedVersion
        );
        let path = r.join(if bundle {
            "多标签.zip"
        } else {
            "多标签.json"
        });
        if bundle {
            export_bundle_with_plan(&d, &plan, &r, &path, &cancel, Limits::default(), |_, _| {})
                .unwrap();
        } else {
            export_annotations_with_plan(&d, &plan, &path, &cancel, Limits::default(), |_, _| {})
                .unwrap();
        }
        let export_before = fs::read(&path).unwrap();
        let imported = import_exchange(&path, &r, &cancel, Limits::default(), |_, _| {}).unwrap();
        assert_eq!(imported.organization.folders, org.folders);
        assert_eq!(imported.organization.media, org.media);
        let copy = &imported.document;
        assert_eq!(copy.media[0].category_ids, d.media[0].category_ids);
        assert_eq!(
            copy.media[0].channel_category_ids,
            d.media[0].channel_category_ids
        );
        assert_eq!(copy.annotations, d.annotations);
        assert_eq!(copy.edits, d.edits);
        assert_ne!(copy.project_id, d.project_id);
        assert_eq!(fs::read(&path).unwrap(), export_before);
        if bundle {
            assert_eq!(
                fs::read(imported.path.join(&copy.media[0].source_ref)).unwrap(),
                source_before
            );
        }
    }
    assert_eq!(fs::read(&d.media[0].source_ref).unwrap(), source_before);
    fs::remove_dir_all(r).unwrap();
}
