use annotator_core::media::import_source::*;
use std::{fs, io::Write, path::PathBuf, sync::atomic::AtomicBool};

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("annotator-import-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, path: &str, bytes: &[u8]) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn zip(&self, name: &str, entries: &[(&str, Vec<u8>)]) -> PathBuf {
        let path = self.0.join(name);
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, bytes) in entries {
            writer
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        assert!(self.0.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn manifest(first: &str, second: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"schema":"jingcheng-run-export-record/v2","audio":{"channels":[{"position":1,"path":format!("records/old/audio/{first}")},{"position":2,"path":format!("records/old/audio/{second}")}]}})).unwrap()
}
fn config(kind: SourceKind, paths: Vec<PathBuf>, second: bool) -> Config {
    Config {
        organization: Default::default(),
        kind,
        paths: paths.iter().map(|p| p.to_str().unwrap().into()).collect(),
        rules: Rules {
            mode: Mode::Jingcheng,
            include_second: second,
            ..Rules::default()
        },
    }
}
fn discover(config: &Config) -> ScanResult {
    scan(config, &AtomicBool::new(false), Limits::default(), |_| {}).unwrap()
}

#[test]
#[ignore = "read-only external NAS fixtures require explicit root"]
fn real_archive_metadata_plans_preserve_cleaned_sources_and_safe_fallback_groups() {
    let root = PathBuf::from(
        std::env::var("ANNOTATOR_IMPORT_SOURCE_FIXTURES").expect("explicit fixture root required"),
    );
    let mut classified = false;
    let mut fallback = false;
    for name in [
        "运行记录导出20261021NG近距离.zip",
        "2026-09-15_清洗后192条OK+NG.zip",
    ] {
        let source = root.join(name);
        let mut cfg = config(SourceKind::Zip, vec![source.clone()], true);
        cfg.organization.mode = OrganizationMode::Template;
        cfg.organization.template =
            "{source}/{date}/{result}/{faultType}/{model}/{record}/{route}".into();
        let scan = discover(&cfg);
        assert_eq!(
            scan.candidates().len(),
            if name.starts_with("2026-") { 384 } else { 318 }
        );
        let mut archive = zip::ZipArchive::new(fs::File::open(&source).unwrap()).unwrap();
        for candidate in scan
            .candidates()
            .iter()
            .filter(|c| c.logical_position == Some(1))
        {
            let directory = candidate.relative_path.rsplit_once("/audio/").unwrap().0;
            let entry = archive
                .by_name(&format!("{directory}/manifest.json"))
                .unwrap();
            assert!(entry.size() <= 1024 * 1024);
            let metadata: serde_json::Value = serde_json::from_reader(entry).unwrap();
            let fault = metadata["outcome"]["fault_type"]
                .as_str()
                .unwrap_or("")
                .trim();
            let is_fallback = fault.is_empty();
            if (is_fallback && fallback && !name.starts_with("2026-"))
                || (!is_fallback && classified)
            {
                continue;
            }
            let field = |value: &serde_json::Value, default: &str| {
                let value = value.as_str().unwrap_or("").trim();
                if value.is_empty() {
                    default.to_owned()
                } else {
                    value.replace(['/', '\\'], "_")
                }
            };
            let date = chrono::DateTime::parse_from_rfc3339(
                metadata["run"]["accepted_at"].as_str().unwrap(),
            )
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
            let expected = vec![
                source.file_stem().unwrap().to_str().unwrap().to_owned(),
                date,
                field(&metadata["outcome"]["result"], "未分类"),
                field(&metadata["outcome"]["fault_type"], "未分类"),
                field(&metadata["run"]["model"], "型号未知"),
                directory.rsplit('/').next().unwrap().to_owned(),
                "第一路".into(),
            ];
            assert_eq!(candidate.resulting_folder_path, expected);
            assert_eq!(
                candidate.original_filename,
                candidate.relative_path.rsplit('/').next().unwrap()
            );
            if is_fallback {
                fallback = true;
                assert!(scan.counts.issues > 0);
            } else {
                classified = true;
            }
            if name.starts_with("2026-") {
                assert!(candidate.relative_path.starts_with("2026-09-15/"));
            }
            println!(
                "native metadata plan {}",
                serde_json::json!({"archive":name,"source":candidate.relative_path,"logicalPosition":candidate.logical_position,"folders":candidate.resulting_folder_path,"fallbackFault":is_fallback,"issues":scan.counts.issues})
            );
            if name.starts_with("2026-") || (classified && fallback) {
                break;
            }
        }
    }
    assert!(classified && fallback);
}

#[test]
fn folders_and_zips_resolve_logical_routes_and_relocated_records() {
    let tree = Tree::new();
    let entries = vec![
        ("records/one/manifest.json", manifest("CH2.wav", "CH4.wav")),
        ("records/one/audio/CH2.wav", b"first".to_vec()),
        ("records/one/audio/CH4.wav", b"second".to_vec()),
        ("2026/OK/two/manifest.json", manifest("CH1.wav", "CH3.wav")),
        ("2026/OK/two/audio/CH1.wav", b"first".to_vec()),
        ("2026/OK/two/audio/CH3.wav", b"second".to_vec()),
    ];
    for (name, bytes) in &entries {
        tree.file(name, bytes);
    }
    let archive = tree.zip("中文.zip", &entries);
    for (kind, path) in [
        (SourceKind::Folder, tree.0.clone()),
        (SourceKind::Zip, archive),
    ] {
        let mut cfg = config(kind, vec![path], false);
        let first = discover(&cfg);
        assert_eq!(
            first
                .candidates()
                .iter()
                .map(|c| c.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["2026/OK/two/audio/CH1.wav", "records/one/audio/CH2.wav"]
        );
        assert!(first
            .candidates()
            .iter()
            .all(|c| c.logical_position == Some(1)));
        cfg.rules.include_second = true;
        assert_eq!(discover(&cfg).candidates().len(), 4);
        cfg.rules.mode = Mode::Generic;
        cfg.rules.include = vec!["*/CH2".into()];
        assert_eq!(discover(&cfg).candidates().len(), 1);
    }
}

#[test]
fn malformed_duplicate_missing_and_unsafe_manifest_routes_are_not_guessed() {
    let tree = Tree::new();
    let bad = [b"broken".to_vec(), manifest("CH1.wav", "CH1.wav"), manifest("../CH1.wav", "CH3.wav"),
        br#"{"schema":"jingcheng-run-export-record/v2","audio":{"channels":[{"position":1,"path":"audio/CH1.wav"},{"position":1,"path":"audio/CH3.wav"}]}}"#.to_vec()];
    for (i, bytes) in bad.iter().enumerate() {
        tree.file(&format!("{i}/manifest.json"), bytes);
        tree.file(&format!("{i}/audio/CH1.wav"), b"audio");
    }
    tree.file("missing/audio/CH1.wav", b"audio");
    let mut cfg = config(SourceKind::Folder, vec![tree.0.clone()], true);
    let result = discover(&cfg);
    assert!(result.candidates().is_empty());
    assert!(result.counts.issues >= 5);
    cfg.rules.mode = Mode::Generic;
    assert_eq!(discover(&cfg).candidates().len(), 5);
}

fn generic(kind: SourceKind, paths: Vec<PathBuf>) -> Config {
    let mut cfg = config(kind, paths, true);
    cfg.rules.mode = Mode::Generic;
    cfg
}
#[test]
fn hostile_zip_names_duplicates_and_unsupported_archives_fail_closed() {
    let tree = Tree::new();
    for (i, name) in [
        "../CH1.wav",
        "/CH1.wav",
        "C:/CH1.wav",
        "a\\CH1.wav",
        "a/CON.wav",
        "a/trailing./CH1.wav",
        "a/../CH1.wav",
    ]
    .iter()
    .enumerate()
    {
        let zip = tree.zip(&format!("bad{i}.zip"), &[(name, b"audio".to_vec())]);
        assert!(
            scan(
                &generic(SourceKind::Zip, vec![zip]),
                &AtomicBool::new(false),
                Limits::default(),
                |_| {}
            )
            .is_err(),
            "{name}"
        );
    }
    let zip = tree.zip(
        "duplicate.zip",
        &[("a/CH1.wav", vec![0]), ("A/ch1.WAV", vec![1])],
    );
    assert!(scan(
        &generic(SourceKind::Zip, vec![zip]),
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
    tree.file("fake.zip", b"not a zip");
    assert!(scan(
        &generic(SourceKind::Zip, vec![tree.0.join("fake.zip")]),
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
}

#[test]
fn counts_bounds_cancellation_and_pagination_are_explicit() {
    let tree = Tree::new();
    tree.file("a.wav", b"12345");
    tree.file("b.wav", b"12345");
    let cfg = generic(SourceKind::Folder, vec![tree.0.clone()]);
    for limits in [
        Limits {
            entries: 1,
            ..Limits::default()
        },
        Limits {
            candidates: 1,
            ..Limits::default()
        },
        Limits {
            audio_bytes: 4,
            ..Limits::default()
        },
        Limits {
            selected_bytes: 9,
            ..Limits::default()
        },
    ] {
        assert_eq!(
            scan(&cfg, &AtomicBool::new(false), limits, |_| {})
                .unwrap_err()
                .code,
            annotator_core::error::ErrorCode::ResourceLimit
        );
    }
    assert_eq!(
        scan(&cfg, &AtomicBool::new(true), Limits::default(), |_| {})
            .unwrap_err()
            .code,
        annotator_core::error::ErrorCode::Cancelled
    );
    let result = discover(&cfg);
    assert_eq!(result.page(0, 1).unwrap().len(), 1);
    assert!(result.page(0, 257).is_err());
    assert!(result.page(3, 1).is_err());
    tree.file("record/manifest.json", &manifest("CH1.wav", "CH3.wav"));
    let cfg = config(SourceKind::Folder, vec![tree.0.clone()], true);
    assert_eq!(
        scan(
            &cfg,
            &AtomicBool::new(false),
            Limits {
                manifest_bytes: 10,
                ..Limits::default()
            },
            |_| {}
        )
        .unwrap_err()
        .code,
        annotator_core::error::ErrorCode::ResourceLimit
    );
}

#[test]
fn lazy_staging_keeps_original_bytes_until_lease_drop_and_detects_changes() {
    let tree = Tree::new();
    let staging = Tree::new();
    let bytes = vec![42_u8; 150_000];
    tree.file("a.wav", &bytes);
    let zip = tree.zip("a.zip", &[("nested/a.wav", bytes.clone())]);
    for (kind, path) in [
        (SourceKind::Folder, tree.0.clone()),
        (SourceKind::Zip, zip.clone()),
    ] {
        let result = discover(&generic(kind, vec![path]));
        assert_eq!(fs::read_dir(&staging.0).unwrap().count(), 0);
        let lease = result
            .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
            .unwrap();
        assert_eq!(fs::read(lease.path()).unwrap(), bytes);
        let staged_path = lease.path().to_path_buf();
        drop(result);
        assert!(staged_path.exists());
        drop(lease);
        assert!(!staged_path.exists());
        assert_eq!(fs::read_dir(&staging.0).unwrap().count(), 0);
    }
    let result = discover(&generic(SourceKind::Zip, vec![zip.clone()]));
    fs::write(&zip, b"changed").unwrap();
    assert_eq!(
        result
            .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
            .unwrap_err()
            .code,
        annotator_core::error::ErrorCode::IdentityMismatch
    );
    let result = discover(&generic(SourceKind::Folder, vec![tree.0.clone()]));
    tree.file("a.wav", b"changed");
    assert!(result
        .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
        .is_err());
    assert_eq!(fs::read_dir(&staging.0).unwrap().count(), 0);
}

#[test]
fn corrupt_crc_stream_cancel_and_changed_manifest_clean_only_owned_staging() {
    use std::sync::atomic::Ordering;
    let tree = Tree::new();
    let staging = Tree::new();
    staging.file("unrelated.txt", b"keep");
    let zip = tree.zip("corrupt.zip", &[("a.wav", vec![42; 150_000])]);
    let mut bytes = fs::read(&zip).unwrap();
    bytes[40] ^= 1;
    fs::write(&zip, bytes).unwrap();
    let result = discover(&generic(SourceKind::Zip, vec![zip]));
    assert!(result
        .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
        .is_err());
    tree.file("a.wav", &vec![42; 150_000]);
    let result = discover(&generic(SourceKind::Folder, vec![tree.0.clone()]));
    let cancel = AtomicBool::new(false);
    assert_eq!(
        result
            .stage(0, &staging.0, &cancel, |_| cancel
                .store(true, Ordering::Relaxed))
            .unwrap_err()
            .code,
        annotator_core::error::ErrorCode::Cancelled
    );
    tree.file("record/manifest.json", &manifest("CH1.wav", "CH3.wav"));
    tree.file("record/audio/CH1.wav", b"first");
    tree.file("record/audio/CH3.wav", b"second");
    let result = discover(&config(SourceKind::Folder, vec![tree.0.clone()], true));
    tree.file("record/manifest.json", b"changed");
    assert!(result
        .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
        .is_err());
    assert_eq!(fs::read_dir(&staging.0).unwrap().count(), 1);
    assert_eq!(fs::read(staging.0.join("unrelated.txt")).unwrap(), b"keep");
}

#[test]
fn zip_encryption_symlink_compression_and_declared_size_are_checked() {
    let tree = Tree::new();
    for (name, at, value) in [("encrypted", 8, 1u16), ("unsupported", 10, 99u16)] {
        let zip = tree.zip(&format!("{name}.zip"), &[("a.wav", vec![0])]);
        let mut bytes = fs::read(&zip).unwrap();
        let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
        bytes[central + at..central + at + 2].copy_from_slice(&value.to_le_bytes());
        fs::write(&zip, bytes).unwrap();
        assert!(scan(
            &generic(SourceKind::Zip, vec![zip]),
            &AtomicBool::new(false),
            Limits::default(),
            |_| {}
        )
        .is_err());
    }
    let zip = tree.zip("symlink.zip", &[("a.wav", vec![0])]);
    let mut bytes = fs::read(&zip).unwrap();
    let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
    bytes[central + 38..central + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
    fs::write(&zip, bytes).unwrap();
    assert!(scan(
        &generic(SourceKind::Zip, vec![zip]),
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
    let zip = tree.zip("size.zip", &[("a.wav", vec![0])]);
    let mut bytes = fs::read(&zip).unwrap();
    let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
    bytes[central + 24..central + 28].copy_from_slice(&(1024u32 * 1024 * 1024 + 1).to_le_bytes());
    fs::write(&zip, bytes).unwrap();
    assert_eq!(
        scan(
            &generic(SourceKind::Zip, vec![zip]),
            &AtomicBool::new(false),
            Limits::default(),
            |_| {}
        )
        .unwrap_err()
        .code,
        annotator_core::error::ErrorCode::ResourceLimit
    );
}

#[test]
fn unrelated_folder_manifest_change_does_not_invalidate_selected_record() {
    let tree = Tree::new();
    let staging = Tree::new();
    for record in ["a", "b"] {
        tree.file(
            &format!("{record}/manifest.json"),
            &manifest("CH1.wav", "CH3.wav"),
        );
        tree.file(&format!("{record}/audio/CH1.wav"), b"first");
        tree.file(&format!("{record}/audio/CH3.wav"), b"second");
    }
    let result = discover(&config(SourceKind::Folder, vec![tree.0.clone()], true));
    tree.file("b/manifest.json", b"changed unrelated record");
    assert!(result
        .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
        .is_ok());
}

#[test]
fn zip_non_utf8_marked_unicode_encoding_is_explicitly_rejected() {
    let tree = Tree::new();
    let zip = tree.zip("encoding.zip", &[("中文/a.wav", vec![0])]);
    let mut bytes = fs::read(&zip).unwrap();
    let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
    bytes[central + 9] &= !8;
    fs::write(&zip, bytes).unwrap();
    assert!(scan(
        &generic(SourceKind::Zip, vec![zip]),
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
}

/// Construct a valid Info-ZIP Unicode Path override, including the raw-name CRC.
fn unicode_path_archive(tree: &Tree, entries: &[(&str, &str)]) -> PathBuf {
    let raw_entries: Vec<_> = entries
        .iter()
        .map(|(raw, _)| (*raw, b"audio".to_vec()))
        .collect();
    let path = tree.zip("unicode-path.zip", &raw_entries);
    let mut bytes = fs::read(&path).unwrap();
    let mut at = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
    let mut inserted = 0u32;
    for (raw, effective) in entries {
        let mut crc = !0u32;
        for byte in raw.bytes() {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320u32 & 0u32.wrapping_sub(crc & 1));
            }
        }
        let mut extra = 0x7075u16.to_le_bytes().to_vec();
        extra.extend_from_slice(&(5u16 + effective.len() as u16).to_le_bytes());
        extra.push(1);
        extra.extend_from_slice(&(!crc).to_le_bytes());
        extra.extend_from_slice(effective.as_bytes());
        let name_len = u16::from_le_bytes(bytes[at + 28..at + 30].try_into().unwrap()) as usize;
        let old_extra_len =
            u16::from_le_bytes(bytes[at + 30..at + 32].try_into().unwrap()) as usize;
        let comment_len = u16::from_le_bytes(bytes[at + 32..at + 34].try_into().unwrap()) as usize;
        assert_eq!(&bytes[at + 46..at + 46 + name_len], raw.as_bytes());
        bytes[at + 30..at + 32]
            .copy_from_slice(&((old_extra_len + extra.len()) as u16).to_le_bytes());
        let insert_at = at + 46 + name_len + old_extra_len;
        let extra_len = extra.len();
        bytes.splice(insert_at..insert_at, extra);
        inserted += extra_len as u32;
        at = insert_at + extra_len + comment_len;
    }
    assert_eq!(&bytes[at..at + 4], b"PK\x05\x06");
    let old_size = u32::from_le_bytes(bytes[at + 12..at + 16].try_into().unwrap());
    bytes[at + 12..at + 16].copy_from_slice(&(old_size + inserted).to_le_bytes());
    fs::write(&path, bytes).unwrap();
    // Prove the fixture exercises zip's valid override, not a corrupt-extra error.
    let mut archive = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
    for (index, (_, effective)) in entries.iter().enumerate() {
        assert_eq!(archive.by_index(index).unwrap().name(), *effective);
    }
    path
}

#[test]
fn unicode_path_overrides_cannot_bypass_safe_path_validation() {
    let tree = Tree::new();
    let mut accepted = vec![];
    for (label, effective) in [
        ("traversal", "../outside.wav"),
        ("directory traversal", "../outside/"),
        ("oversized", &format!("{}.wav", "a".repeat(4097))),
    ] {
        let archive = unicode_path_archive(&tree, &[("safe.wav", effective)]);
        if scan(
            &generic(SourceKind::Zip, vec![archive]),
            &AtomicBool::new(false),
            Limits::default(),
            |_| {},
        )
        .is_ok()
        {
            accepted.push(label);
        }
    }
    assert!(
        accepted.is_empty(),
        "unsafe effective names accepted: {accepted:?}"
    );
}

#[test]
fn unicode_path_overrides_cannot_hide_directory_file_collisions() {
    let tree = Tree::new();
    let archive =
        unicode_path_archive(&tree, &[("safe-dir/", "COLLIDE/"), ("safe.wav", "collide")]);
    assert!(scan(
        &generic(SourceKind::Zip, vec![archive]),
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
}

#[test]
fn valid_unicode_path_override_is_preserved_through_staging() {
    let tree = Tree::new();
    let staging = Tree::new();
    let archive = unicode_path_archive(&tree, &[("safe.wav", "中文/CH1.wav")]);
    let result = discover(&generic(SourceKind::Zip, vec![archive]));
    assert_eq!(result.candidates()[0].relative_path, "中文/CH1.wav");
    let lease = result
        .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
        .unwrap();
    assert_eq!(fs::read(lease.path()).unwrap(), b"audio");
}

#[test]
fn streamed_actual_size_scan_cancellation_and_retained_issues_are_bounded() {
    use std::sync::atomic::Ordering;
    let tree = Tree::new();
    let staging = Tree::new();
    let zip = tree.zip("actual.zip", &[("a.wav", vec![42; 150_000])]);
    let mut bytes = fs::read(&zip).unwrap();
    let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
    bytes[central + 24..central + 28].copy_from_slice(&1u32.to_le_bytes());
    fs::write(&zip, bytes).unwrap();
    let result = discover(&generic(SourceKind::Zip, vec![zip]));
    assert!(result
        .stage(0, &staging.0, &AtomicBool::new(false), |_| {})
        .is_err());
    assert_eq!(fs::read_dir(&staging.0).unwrap().count(), 0);
    for i in 0..300 {
        tree.file(&format!("{i}/audio/a.wav"), b"unmapped");
    }
    let cfg = config(SourceKind::Folder, vec![tree.0.clone()], true);
    let result = discover(&cfg);
    assert_eq!(result.counts.issues, 300);
    assert_eq!(result.issues.len(), 256);
    let cancel = AtomicBool::new(false);
    assert_eq!(
        scan(&cfg, &cancel, Limits::default(), |_| cancel
            .store(true, Ordering::Relaxed))
        .unwrap_err()
        .code,
        annotator_core::error::ErrorCode::Cancelled
    );
    let zip = tree.zip(
        "manifest-cap.zip",
        &[("manifest.json", manifest("CH1.wav", "CH3.wav"))],
    );
    assert_eq!(
        scan(
            &config(SourceKind::Zip, vec![zip], true),
            &AtomicBool::new(false),
            Limits {
                manifest_bytes: 10,
                ..Limits::default()
            },
            |_| {}
        )
        .unwrap_err()
        .code,
        annotator_core::error::ErrorCode::ResourceLimit
    );
}

#[cfg(windows)]
#[test]
fn folder_junctions_and_source_ancestor_junctions_are_not_followed() {
    let tree = Tree::new();
    tree.file("outside/secret.wav", b"keep");
    fs::create_dir(tree.0.join("scan")).unwrap();
    let link = tree.0.join("scan/link");
    let output=std::process::Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:IMPORT_LINK -Target $env:IMPORT_TARGET | Out-Null"])
        .env("IMPORT_LINK",&link).env("IMPORT_TARGET",tree.0.join("outside")).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = discover(&generic(SourceKind::Folder, vec![tree.0.join("scan")]));
    assert!(result.candidates().is_empty());
    assert_eq!(result.counts.issues, 1);
    assert!(scan(
        &generic(SourceKind::Folder, vec![link.clone()]),
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
    assert!(scan(
        &generic(SourceKind::Zip, vec![link.join("secret.wav")]),
        &AtomicBool::new(false),
        Limits::default(),
        |_| {}
    )
    .is_err());
    assert!(link.starts_with(&tree.0));
    fs::remove_dir(&link).unwrap();
    assert_eq!(
        fs::read(tree.0.join("outside/secret.wav")).unwrap(),
        b"keep"
    );
}

#[test]
#[ignore = "read-only opt-in NAS fixtures; set ANNOTATOR_IMPORT_SOURCE_FIXTURES"]
fn nine_real_archives_have_exact_logical_route_counts_and_decodable_original_bytes() {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let root = PathBuf::from(
        std::env::var("ANNOTATOR_IMPORT_SOURCE_FIXTURES").expect("explicit fixture root required"),
    );
    let names = [
        ("运行记录导出20261021NG近距离.zip", 318),
        ("2026-09-15_清洗后192条OK+NG.zip", 384),
        ("2026-09-16_清洗后451条OK+NG.zip", 902),
        ("运行记录导出20260909NG.zip", 32),
        ("运行记录导出20260909OK.zip", 242),
        ("运行记录导出20260915NG部分OK.zip", 384),
        ("运行记录导出20260918OK.zip", 260),
        ("运行记录导出20260920OK.zip", 412),
        ("运行记录导出20261007NG带分类.zip", 360),
    ];
    let paths: Vec<_> = names.iter().map(|(name, _)| root.join(name)).collect();
    let mut cfg = config(SourceKind::Zip, paths.clone(), true);
    let both = discover(&cfg);
    assert_eq!(both.candidates().len(), 3294);
    for (source, (name, expected)) in names.iter().enumerate() {
        assert_eq!(
            both.candidates()
                .iter()
                .filter(|c| c.source_index == source)
                .count(),
            *expected,
            "{name}"
        );
    }
    cfg.rules.include_second = false;
    let first = discover(&cfg);
    assert_eq!(first.candidates().len(), 1647);
    assert!(first
        .candidates()
        .iter()
        .all(|c| c.logical_position == Some(1)));
    let local = Tree::new();
    let cancel = AtomicBool::new(false);
    for position in [1, 2] {
        let candidate = both
            .candidates()
            .iter()
            .find(|c| c.logical_position == Some(position))
            .unwrap();
        let lease = both
            .stage(candidate.index, &local.0, &cancel, |_| {})
            .unwrap();
        let mut archive =
            zip::ZipArchive::new(fs::File::open(&paths[candidate.source_index]).unwrap()).unwrap();
        let mut original = archive.by_name(&candidate.relative_path).unwrap();
        let mut hash = Sha256::new();
        let mut buffer = [0; 65536];
        loop {
            let n = original.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        assert_eq!(lease.sha256, format!("{:x}", hash.finalize()));
        let decoded = annotator_core::media::decode::decode(
            lease.path(),
            &local.0.join(format!("cache{position}")),
            &cancel,
            |_, _| {},
        )
        .unwrap();
        assert_eq!(decoded.descriptor.byte_length, candidate.byte_length);
        println!(
            "position {position}: {} bytes, {} Hz, {} channels",
            candidate.byte_length, decoded.descriptor.sample_rate, decoded.descriptor.channel_count
        );
        drop(decoded);
        drop(lease);
    }
    println!(
        "nine archives: both={}, first={}, scan entries={}, issues={}",
        both.candidates().len(),
        first.candidates().len(),
        both.counts.checked,
        both.counts.issues
    );
}

#[test]
fn organization_paths_templates_and_metadata_are_native_and_bounded() {
    let tree = Tree::new();
    tree.file("2026/NG/record/audio/CH2.wav", b"audio");
    tree.file("2026/NG/record/manifest.json", &serde_json::to_vec(&serde_json::json!({"schema":"jingcheng-run-export-record/v2", "audio":{"channels":[{"position":1,"path":"audio/CH2.wav"}]}, "run":{"accepted_at":"2026-09-15T12:23:01+08:00","model":" M/1 "},"outcome":{"result":"NG","fault_type":" bad\\noise "}})).unwrap());
    let mut cfg = config(SourceKind::Folder, vec![tree.0.clone()], true);
    cfg.organization.mode = OrganizationMode::Template;
    cfg.organization.template =
        "{source}/{date}/{result}/{faultType}/{model}/{record}/{route}/{relativeDir}".into();
    cfg.organization.strip_components = vec!["AUDIO".into()];
    let result = discover(&cfg);
    let c = &result.candidates()[0];
    assert_eq!(c.original_filename, "CH2.wav");
    assert_eq!(
        &c.resulting_folder_path[1..],
        [
            "2026-09-15",
            "NG",
            "bad_noise",
            "M_1",
            "record",
            "第一路",
            "2026",
            "NG",
            "record"
        ]
    );
    cfg.organization.mode = OrganizationMode::Flat;
    assert!(discover(&cfg).candidates()[0]
        .resulting_folder_path
        .is_empty());
    cfg.organization.mode = OrganizationMode::SourcePath;
    cfg.organization.wrap_source = true;
    assert_eq!(
        discover(&cfg).candidates()[0].resulting_folder_path.len(),
        4
    );
    cfg.rules.mode = Mode::Generic;
    cfg.organization.mode = OrganizationMode::Template;
    assert!(cfg.validate().is_err());
    cfg.organization.template = "{source}/bad{relativeDir}".into();
    assert!(cfg.validate().is_err());
    cfg.organization.template = "{source}/../x".into();
    assert!(cfg.validate().is_err());
}
#[test]
fn optional_metadata_fallback_retains_audio_and_reports_missing_fields() {
    let tree = Tree::new();
    tree.file("r/audio/CH2.wav", b"audio");
    tree.file("r/audio/CH4.wav", b"audio");
    tree.file("r/manifest.json", &manifest("CH2.wav", "CH4.wav"));
    let mut cfg = config(SourceKind::Folder, vec![tree.0.clone()], true);
    cfg.organization.mode = OrganizationMode::Template;
    cfg.organization.template = "{date}/{result}/{faultType}/{model}/{record}/{route}".into();
    let result = discover(&cfg);
    assert_eq!(result.candidates().len(), 2);
    assert_eq!(
        result.candidates()[0].resulting_folder_path,
        ["日期未知", "未分类", "未分类", "型号未知", "r", "第一路"]
    );
    assert!(result.counts.issues >= 4);
    assert!(!result.folder_summary().is_empty());
    cfg.organization.template = "x/".repeat(17);
    cfg.organization.template.pop();
    assert!(cfg.validate().is_err());
}

#[test]
fn all_result_tree_includes_paths_beyond_the_first_fifty_media() {
    let tree = Tree::new();
    for i in 0..61 {
        tree.file(&format!("record{i:03}/audio/original.wav"), b"audio");
    }
    let mut cfg = generic(SourceKind::Folder, vec![tree.0.clone()]);
    cfg.organization.mode = OrganizationMode::SourcePath;
    cfg.organization.strip_components = vec!["audio".into()];
    let result = discover(&cfg);
    assert_eq!(result.page(0, 50).unwrap().len(), 50);
    assert!(result.page(0, 51).is_err());
    assert_eq!(result.folder_summary().len(), 61);
    assert!(result
        .folder_summary()
        .iter()
        .any(|n| n.name == "record060"));
    assert!(result.folder_summary().iter().all(|n| n.media_count == 1));
    let mut result = discover(&cfg);
    result.bind_target_path(&["目标".into()]).unwrap();
    assert_eq!(result.folder_summary()[0].media_count, 61);
    cfg.organization.template = "x".repeat(129);
    cfg.organization.mode = OrganizationMode::Template;
    assert!(cfg.validate().is_err());
    cfg.organization.template = "x".into();
    cfg.organization.mode = OrganizationMode::SourcePath;
    let mut result = discover(&cfg);
    result.bind_target_path(&vec!["深".into(); 16]).unwrap();
    assert_eq!(result.counts.candidates, 0);
    assert_eq!(result.counts.skipped, 61);
    assert!(result.folder_summary().is_empty());
}

#[test]
fn generic_rejects_manifest_tokens_before_any_source_io_even_in_dormant_template() {
    let mut cfg = generic(
        SourceKind::Folder,
        vec![std::env::temp_dir().join("missing-source")],
    );
    for token in [
        "{record}",
        "{date}",
        "{result}",
        "{faultType}",
        "{model}",
        "{route}",
    ] {
        cfg.organization.template = token.into();
        assert!(cfg.validate().is_err(), "{token}");
    }
}

#[test]
fn template_rejects_absolute_windows_paths_before_source_io() {
    let mut cfg = generic(
        SourceKind::Folder,
        vec![std::env::temp_dir().join("missing-source")],
    );
    cfg.organization.mode = OrganizationMode::Template;
    cfg.organization.template = "C:/record".into();
    assert!(cfg.validate().is_err());
}

#[test]
fn oversized_optional_metadata_is_excluded_only_when_the_layout_uses_it() {
    let tree = Tree::new();
    tree.file("r/audio/CH2.wav", b"audio");
    tree.file("r/audio/CH4.wav", b"audio");
    let mut value: serde_json::Value =
        serde_json::from_slice(&manifest("CH2.wav", "CH4.wav")).unwrap();
    value["run"] = serde_json::json!({"model":"m".repeat(200_000)});
    tree.file("r/manifest.json", &serde_json::to_vec(&value).unwrap());
    let mut cfg = config(SourceKind::Folder, vec![tree.0.clone()], true);
    assert_eq!(discover(&cfg).counts.candidates, 2);
    cfg.organization.mode = OrganizationMode::Template;
    cfg.organization.template = "{model}".into();
    let result = discover(&cfg);
    assert_eq!(result.counts.candidates, 0);
    assert_eq!(result.counts.skipped, 3); // The manifest was also excluded by the audio extension rule.
    assert_eq!(result.counts.issues, 2);
}

#[test]
fn reused_zip_session_reads_distinct_entries_and_rejects_changed_source() {
    let t = Tree::new();
    let source = t.zip(
        "session.zip",
        &[("a.wav", vec![1; 64]), ("b.wav", vec![2; 64])],
    );
    let mut cfg = config(SourceKind::Zip, vec![source.clone()], true);
    cfg.rules.mode = Mode::Generic;
    let scan = discover(&cfg);
    let mut session = scan.staging_session();
    let cancel = AtomicBool::new(false);
    let first = session.stage(0, &t.0, &cancel, |_| {}).unwrap();
    let second = session.stage(1, &t.0, &cancel, |_| {}).unwrap();
    assert_eq!(fs::read(first.path()).unwrap(), vec![1; 64]);
    assert_eq!(fs::read(second.path()).unwrap(), vec![2; 64]);
    // Changing the source length must fail even when its parsed directory is cached.
    let file = fs::OpenOptions::new().write(true).open(&source).unwrap();
    file.set_len(3).unwrap();
    drop(file);
    assert!(session.stage(1, &t.0, &cancel, |_| {}).is_err());
    drop((session, first, second));
}
