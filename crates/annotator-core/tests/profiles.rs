use annotator_core::collaboration::profiles::*;
use annotator_core::error::ErrorCode;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("profiles-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn store(&self) -> ProfileStore {
        ProfileStore::load_or_create(&self.0).unwrap()
    }
    fn file(&self) -> PathBuf {
        self.0.join(STORE_FILE_NAME)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn profile_json() -> Value {
    json!({"authorId":"ab019328-97e9-48a8-ab31-c2677b93d811", "displayName":"测试者", "createdAt":"2026-10-26T01:02:03Z"})
}
fn store_json() -> Value {
    json!({"kind":STORE_KIND,"formatVersion":1,"revision":1,
        "lastSelectedAuthorId":profile_json()["authorId"],"profiles":[profile_json()]})
}

#[test]
fn first_run_persists_one_v4_profile_and_restart_keeps_identity_and_selection() {
    let temp = Temp::new();
    fs::write(
        temp.0.join("local-identity.dpapi"),
        b"old untouched identity",
    )
    .unwrap();
    let first = temp.store().snapshot().unwrap();
    assert_eq!(first.profiles.len(), 1);
    let profile = &first.profiles[0];
    assert_eq!(
        uuid::Uuid::parse_str(&profile.author_id)
            .unwrap()
            .get_version_num(),
        4
    );
    assert_eq!(first.last_selected_author_id, profile.author_id);
    assert_eq!(
        profile.display_name,
        format!("本机身份 · {}", &profile.author_id[..8])
    );
    let bytes = fs::read(temp.file()).unwrap();
    assert_eq!(temp.store().snapshot().unwrap(), first);
    assert_eq!(fs::read(temp.file()).unwrap(), bytes);
    assert_eq!(
        fs::read(temp.0.join("local-identity.dpapi")).unwrap(),
        b"old untouched identity"
    );
}

#[test]
fn profile_names_are_trimmed_unicode_bounded_and_need_not_be_unique() {
    let a = Profile::new("  相同名字  ").unwrap();
    let b = Profile::new("相同名字").unwrap();
    assert_eq!(a.display_name, b.display_name);
    assert_ne!(a.author_id, b.author_id);
    assert!(Profile::new(&"🎵".repeat(64)).is_ok());
    for invalid in [
        "".to_owned(),
        "  ".to_owned(),
        "a".repeat(65),
        "🎵".repeat(65),
        "a\nb".to_owned(),
        "\tname".to_owned(),
        "a\u{7f}".to_owned(),
    ] {
        assert!(Profile::new(&invalid).is_err(), "accepted {invalid:?}");
    }
    let mut raw = profile_json();
    raw["displayName"] = json!("  昵称  ");
    let parsed: Profile = serde_json::from_value(raw).unwrap();
    assert_eq!(parsed.display_name, "昵称");
}

#[test]
fn profile_dto_rejects_noncanonical_ids_invalid_utc_and_unknown_or_duplicate_fields() {
    for bad in [
        "",
        "not-uuid",
        "00000000-0000-0000-0000-000000000000",
        "AB019328-97E9-48A8-AB31-C2677B93D811",
        "ab01932897e948a8ab31c2677b93d811",
    ] {
        let mut raw = profile_json();
        raw["authorId"] = json!(bad);
        assert!(
            serde_json::from_value::<Profile>(raw).is_err(),
            "accepted {bad}"
        );
    }
    for bad in [
        "2026-02-30T01:02:03Z",
        "2026-10-26",
        "2026-10-26T01:02:03+08:00",
        "invalid",
    ] {
        let mut raw = profile_json();
        raw["createdAt"] = json!(bad);
        assert!(
            serde_json::from_value::<Profile>(raw).is_err(),
            "accepted {bad}"
        );
    }
    let raw = serde_json::to_string(&profile_json()).unwrap();
    for field in [
        r#""authorId":"ab019328-97e9-48a8-ab31-c2677b93d811""#,
        r#""displayName":"other""#,
        r#""createdAt":"2026-10-26T01:02:03Z""#,
        r#""password":"unused""#,
    ] {
        let duplicate = format!("{{{field},{}", &raw[1..]);
        assert!(serde_json::from_str::<Profile>(&duplicate).is_err());
    }
}

#[test]
fn invalid_existing_store_is_never_reset_or_modified() {
    let temp = Temp::new();
    let valid = store_json();
    let mut cases = vec![b"{".to_vec(), b"null".to_vec()];
    for (field, value) in [
        ("kind", json!("other")),
        ("formatVersion", json!(2)),
        ("revision", json!(0)),
        ("revision", json!(9_007_199_254_740_992_u64)),
        (
            "lastSelectedAuthorId",
            json!(uuid::Uuid::new_v4().to_string()),
        ),
        ("profiles", json!([])),
        ("profiles", json!([profile_json(), profile_json()])),
        ("extra", json!(true)),
    ] {
        let mut raw = valid.clone();
        raw[field] = value;
        cases.push(serde_json::to_vec(&raw).unwrap());
    }
    let raw = serde_json::to_string(&valid).unwrap();
    for field in [
        r#""kind":"annotator.profile-store""#,
        r#""formatVersion":1"#,
        r#""revision":1"#,
        r#""lastSelectedAuthorId":"ab019328-97e9-48a8-ab31-c2677b93d811""#,
        r#""profiles":[]"#,
    ] {
        cases.push(format!("{{{field},{}", &raw[1..]).into_bytes());
    }
    let mut too_many = valid.clone();
    too_many["profiles"] = Value::Array(
        (0..129)
            .map(|_| {
                let mut p = profile_json();
                p["authorId"] = json!(uuid::Uuid::new_v4().to_string());
                p
            })
            .collect(),
    );
    too_many["lastSelectedAuthorId"] = too_many["profiles"][0]["authorId"].clone();
    cases.push(serde_json::to_vec(&too_many).unwrap());
    let mut oversized = serde_json::to_vec(&valid).unwrap();
    oversized.resize(MAX_STORE_BYTES + 1, b' ');
    cases.push(oversized);
    for bytes in cases {
        fs::write(temp.file(), &bytes).unwrap();
        assert!(ProfileStore::load_or_create(&temp.0).is_err());
        assert_eq!(fs::read(temp.file()).unwrap(), bytes);
    }
}

#[test]
fn store_reads_exact_byte_limit_but_rejects_one_more_byte() {
    let temp = Temp::new();
    let mut bytes = serde_json::to_vec(&store_json()).unwrap();
    bytes.resize(MAX_STORE_BYTES, b' ');
    fs::write(temp.file(), &bytes).unwrap();
    assert!(ProfileStore::load_or_create(&temp.0).is_ok());
    bytes.push(b' ');
    fs::write(temp.file(), &bytes).unwrap();
    assert_eq!(
        ProfileStore::load_or_create(&temp.0).err().unwrap().code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(fs::read(temp.file()).unwrap(), bytes);
}

#[test]
fn create_rename_and_select_are_durable_revision_checked_operations() {
    let temp = Temp::new();
    let store = temp.store();
    let initial = store.snapshot().unwrap();
    let created = store.create(initial.revision, "  Alice  ").unwrap();
    assert_eq!(created.snapshot.profiles.len(), 2);
    assert_eq!(
        created.snapshot.last_selected_author_id,
        initial.last_selected_author_id
    );
    assert_eq!(created.snapshot.revision, initial.revision + 1);
    let selected = store
        .select(created.snapshot.revision, &created.profile.author_id)
        .unwrap();
    assert_eq!(temp.store().snapshot().unwrap(), selected);
    let before = fs::read(temp.file()).unwrap();
    assert_eq!(
        store
            .select(selected.revision, &created.profile.author_id)
            .unwrap(),
        selected
    );
    assert_eq!(fs::read(temp.file()).unwrap(), before);
    let renamed = store
        .rename(selected.revision, &created.profile.author_id, " 新昵称 ")
        .unwrap();
    assert_eq!(renamed.profile.author_id, created.profile.author_id);
    assert_eq!(renamed.profile.created_at, created.profile.created_at);
    assert_eq!(renamed.profile.display_name, "新昵称");
    assert_eq!(
        renamed.snapshot.last_selected_author_id,
        selected.last_selected_author_id
    );
    assert_eq!(temp.store().snapshot().unwrap(), renamed.snapshot);
    let before = fs::read(temp.file()).unwrap();
    for error in [
        store.create(initial.revision, "stale").unwrap_err(),
        store
            .rename(initial.revision, &created.profile.author_id, "stale")
            .unwrap_err(),
        store
            .select(initial.revision, &initial.last_selected_author_id)
            .unwrap_err(),
    ] {
        assert_eq!(error.code, ErrorCode::RevisionConflict);
    }
    assert!(store
        .select(renamed.snapshot.revision, &uuid::Uuid::new_v4().to_string())
        .is_err());
    assert!(store
        .rename(
            renamed.snapshot.revision,
            &created.profile.author_id,
            "bad\nname"
        )
        .is_err());
    assert_eq!(fs::read(temp.file()).unwrap(), before);
}

#[test]
fn two_stale_readers_retry_without_losing_either_addition() {
    use std::sync::{Arc, Barrier};
    let temp = Temp::new();
    let initial = temp.store().snapshot().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = ["Alice", "Bob"]
        .into_iter()
        .map(|name| {
            let root = temp.0.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = ProfileStore::load_or_create(&root).unwrap();
                let read = store.snapshot().unwrap();
                barrier.wait();
                let first = store.create(read.revision, name);
                let stale = first.is_err();
                if let Err(error) = first {
                    assert_eq!(error.code, ErrorCode::RevisionConflict);
                    store
                        .create(store.snapshot().unwrap().revision, name)
                        .unwrap();
                }
                stale
            })
        })
        .collect();
    let stale_count = threads
        .into_iter()
        .map(|thread| usize::from(thread.join().unwrap()))
        .sum::<usize>();
    assert_eq!(stale_count, 1);
    let after = temp.store().snapshot().unwrap();
    assert_eq!(after.profiles.len(), 3);
    assert_eq!(after.revision, initial.revision + 2);
    assert!(after.profiles.iter().any(|p| p.display_name == "Alice"));
    assert!(after.profiles.iter().any(|p| p.display_name == "Bob"));
    assert_eq!(
        after.last_selected_author_id,
        initial.last_selected_author_id
    );
}

#[test]
fn writes_obey_profile_count_and_revision_bounds_without_modifying_existing_data() {
    let temp = Temp::new();
    let store = temp.store();
    let mut snapshot = store.snapshot().unwrap();
    for _ in 1..MAX_PROFILES {
        snapshot = store
            .create(snapshot.revision, &"🎵".repeat(64))
            .unwrap()
            .snapshot;
        assert!(fs::metadata(temp.file()).unwrap().len() <= MAX_STORE_BYTES as u64);
    }
    assert_eq!(temp.store().snapshot().unwrap(), snapshot);
    let before = fs::read(temp.file()).unwrap();
    assert_eq!(
        store
            .create(snapshot.revision, "too many")
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(fs::read(temp.file()).unwrap(), before);
    let mut raw = store_json();
    raw["revision"] = json!(9_007_199_254_740_991_u64);
    let before = serde_json::to_vec(&raw).unwrap();
    fs::write(temp.file(), &before).unwrap();
    assert!(store.create(9_007_199_254_740_991, "overflow").is_err());
    assert_eq!(fs::read(temp.file()).unwrap(), before);
}

#[cfg(windows)]
#[test]
fn real_atomic_replace_failure_keeps_original_bytes_and_removes_owned_temp() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = Temp::new();
    let store = temp.store();
    let before = fs::read(temp.file()).unwrap();
    let snapshot = store.snapshot().unwrap();
    // Permit reads/writes but deny delete/rename sharing, forcing MoveFileEx to fail.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(temp.file())
        .unwrap();
    let error = store
        .create(snapshot.revision, "cannot replace")
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::SaveFailed);
    assert_eq!(fs::read(temp.file()).unwrap(), before);
    assert_eq!(store.snapshot().unwrap(), snapshot);
    assert!(!fs::read_dir(&temp.0).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
    drop(held);
    assert!(store.create(snapshot.revision, "can replace").is_ok());
}

#[test]
fn independent_processes_initialize_one_profile() {
    if let Some(root) = std::env::var_os("ANNOTATOR_PROFILE_INIT_CHILD") {
        ProfileStore::load_or_create(&PathBuf::from(root)).unwrap();
        return;
    }
    let temp = Temp::new();
    let children: Vec<_> = (0..4)
        .map(|_| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "independent_processes_initialize_one_profile"])
                .env("ANNOTATOR_PROFILE_INIT_CHILD", &temp.0)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in children {
        let result = child.wait_with_output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let after = temp.store().snapshot().unwrap();
    assert_eq!(after.profiles.len(), 1);
    assert_eq!(after.revision, 1);
}

fn portable_json() -> Value {
    json!({"kind":TRANSFER_KIND,"formatVersion":1,"profile":profile_json()})
}

#[test]
fn export_is_single_profile_metadata_and_never_clobbers_a_target() {
    let temp = Temp::new();
    let store = temp.store();
    let original = store.snapshot().unwrap();
    let other = store.create(original.revision, "other identity").unwrap();
    let target = temp.0.join("portable.json");
    store.export(&other.profile.author_id, &target).unwrap();
    let bytes = fs::read(&target).unwrap();
    assert!(bytes.len() <= MAX_TRANSFER_BYTES);
    let exported: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        exported
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["formatVersion", "kind", "profile"]
    );
    assert_eq!(
        exported["profile"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["authorId", "createdAt", "displayName"]
    );
    assert_eq!(
        exported["profile"],
        serde_json::to_value(&other.profile).unwrap()
    );
    assert_eq!(parse_transfer(&bytes).unwrap(), other.profile);
    assert!(store
        .export(&original.last_selected_author_id, &target)
        .is_err());
    assert_eq!(fs::read(&target).unwrap(), bytes);
    let absent = temp.0.join("absent.json");
    assert!(store
        .export(&uuid::Uuid::new_v4().to_string(), &absent)
        .is_err());
    assert!(!absent.exists());
}

#[test]
fn transfer_to_independent_store_preserves_uuid_and_duplicate_import_keeps_local_metadata_and_selection(
) {
    let machine_a = Temp::new();
    let a = machine_a.store();
    let source = a.snapshot().unwrap();
    let portable = machine_a.0.join("portable.json");
    a.export(&source.last_selected_author_id, &portable)
        .unwrap();
    let machine_b = Temp::new();
    let b = machine_b.store();
    let initial_b = b.snapshot().unwrap();
    let imported = b.import(initial_b.revision, &portable).unwrap();
    assert!(!imported.already_exists);
    assert_eq!(imported.profile, source.profiles[0]);
    assert_eq!(
        imported.snapshot.last_selected_author_id,
        initial_b.last_selected_author_id
    );
    assert_eq!(imported.snapshot.profiles.len(), 2);
    let renamed = b
        .rename(
            imported.snapshot.revision,
            &imported.profile.author_id,
            "local nickname",
        )
        .unwrap();
    let mut conflicting_metadata = portable_json();
    conflicting_metadata["profile"]["authorId"] = json!(imported.profile.author_id);
    conflicting_metadata["profile"]["createdAt"] = json!("2020-01-01T00:00:00Z");
    fs::write(
        &portable,
        serde_json::to_vec(&conflicting_metadata).unwrap(),
    )
    .unwrap();
    let before = fs::read(machine_b.file()).unwrap();
    let duplicate = b.import(renamed.snapshot.revision, &portable).unwrap();
    assert!(duplicate.already_exists);
    assert_eq!(duplicate.profile, renamed.profile);
    assert_eq!(duplicate.snapshot, renamed.snapshot);
    assert_eq!(fs::read(machine_b.file()).unwrap(), before);
    let mut another_id = conflicting_metadata;
    another_id["profile"]["authorId"] = json!(uuid::Uuid::new_v4().to_string());
    another_id["profile"]["displayName"] = json!(renamed.profile.display_name);
    fs::write(&portable, serde_json::to_vec(&another_id).unwrap()).unwrap();
    let distinct = b.import(duplicate.snapshot.revision, &portable).unwrap();
    assert!(!distinct.already_exists);
    assert_eq!(distinct.snapshot.profiles.len(), 3);
    assert_eq!(distinct.profile.display_name, renamed.profile.display_name);
    assert_ne!(distinct.profile.author_id, renamed.profile.author_id);
    assert_eq!(
        distinct.snapshot.last_selected_author_id,
        initial_b.last_selected_author_id
    );
    let before = fs::read(machine_b.file()).unwrap();
    assert_eq!(
        b.import(initial_b.revision, &portable).unwrap_err().code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(fs::read(machine_b.file()).unwrap(), before);
}

#[test]
fn malformed_portable_input_never_mutates_the_store() {
    let temp = Temp::new();
    let store = temp.store();
    let snapshot = store.snapshot().unwrap();
    let before = fs::read(temp.file()).unwrap();
    let portable = temp.0.join("input.json");
    let valid = portable_json();
    let mut cases = vec![
        b"{".to_vec(),
        b"null".to_vec(),
        serde_json::to_vec(&store_json()).unwrap(),
    ];
    for (field, value) in [
        ("kind", json!("wrong")),
        ("formatVersion", json!(2)),
        ("profile", json!({})),
        ("projectPath", json!("forbidden")),
    ] {
        let mut raw = valid.clone();
        raw[field] = value;
        cases.push(serde_json::to_vec(&raw).unwrap());
    }
    for (field, value) in [
        ("authorId", json!("00000000-0000-0000-0000-000000000000")),
        ("displayName", json!("a\nb")),
        ("createdAt", json!("yesterday")),
        ("password", json!("unused")),
    ] {
        let mut raw = valid.clone();
        raw["profile"][field] = value;
        cases.push(serde_json::to_vec(&raw).unwrap());
    }
    let raw = serde_json::to_string(&valid).unwrap();
    for field in [
        format!("\"kind\":\"{TRANSFER_KIND}\""),
        "\"formatVersion\":1".to_owned(),
        format!("\"profile\":{}", profile_json()),
    ] {
        cases.push(format!("{{{field},{}", &raw[1..]).into_bytes());
    }
    cases.push(
        raw.replace(
            "\"displayName\":",
            "\"displayName\":\"duplicate\",\"displayName\":",
        )
        .into_bytes(),
    );
    let mut oversized = serde_json::to_vec(&valid).unwrap();
    oversized.resize(MAX_TRANSFER_BYTES + 1, b' ');
    cases.push(oversized);
    for bytes in cases {
        fs::write(&portable, &bytes).unwrap();
        assert!(store.import(snapshot.revision, &portable).is_err());
        assert_eq!(fs::read(temp.file()).unwrap(), before);
    }
}

#[test]
fn portable_read_and_write_bounds_are_symmetric() {
    let mut bytes = serde_json::to_vec(&portable_json()).unwrap();
    bytes.resize(MAX_TRANSFER_BYTES, b' ');
    assert!(parse_transfer(&bytes).is_ok());
    bytes.push(b' ');
    assert_eq!(
        parse_transfer(&bytes).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    let mut profile = Profile::new("valid nickname").unwrap();
    profile.display_name = "x".repeat(65);
    assert!(encode_transfer(&profile).is_err());
    profile.display_name = "valid".to_owned();
    // RFC3339 allows arbitrary fractional-second precision; serialization must still be bounded.
    profile.created_at = format!("2026-10-26T01:02:03.{}Z", "0".repeat(MAX_TRANSFER_BYTES));
    assert!(profile.validate().is_ok());
    assert_eq!(
        encode_transfer(&profile).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn store_serialization_cannot_exceed_its_reader_limit() {
    let temp = Temp::new();
    let mut raw = store_json();
    raw["profiles"][0]["createdAt"] = json!("2026-10-26T01:02:03.Z");
    let base = serde_json::to_vec(&raw).unwrap().len();
    raw["profiles"][0]["createdAt"] = json!(format!(
        "2026-10-26T01:02:03.{}Z",
        "0".repeat(MAX_STORE_BYTES - base)
    ));
    let before = serde_json::to_vec(&raw).unwrap();
    assert_eq!(before.len(), MAX_STORE_BYTES);
    fs::write(temp.file(), &before).unwrap();
    let store = temp.store();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        store
            .rename(
                snapshot.revision,
                &snapshot.last_selected_author_id,
                &"🎵".repeat(64)
            )
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(fs::read(temp.file()).unwrap(), before);
}
