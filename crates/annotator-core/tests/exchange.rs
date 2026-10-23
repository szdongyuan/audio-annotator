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
    ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v2.json")).unwrap()
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
            serde_json::json!(3),
            ErrorCode::UnsupportedVersion,
        ),
        (
            "/annotations/0/region/highHz",
            serde_json::json!(999999),
            ErrorCode::InvalidInput,
        ),
        (
            "/annotations/0/categoryId",
            serde_json::json!("00000000-0000-4000-8000-000000000099"),
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
    let media_path = format!("media/{}", d.media[0].id);
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
    d.media[0].category_id = Some(d.categories[0].id.clone());
    d.media[0].channel_category_ids[1] = Some(d.categories[0].id.clone());
    d.view_state.compare_layout = annotator_core::model::CompareLayout::Vertical;
    d.view_state.compare_split = 0.7;
}
#[test]
fn portable_v2_rejects_missing_nullable_fields_unknown_fields_and_local_paths() {
    use annotator_core::exchange::Manifest;
    let current = serde_json::to_value(Manifest::capture(&document(), false).unwrap()).unwrap();
    {
        let original = current;
        for (pointer, key) in [
            ("/media/0", "channelLayout"),
            ("/media/0", "mediaPath"),
            ("/annotations/0", "categoryId"),
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
        ("/media/0", "categoryId"),
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
    for version in [1, 3] {
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
