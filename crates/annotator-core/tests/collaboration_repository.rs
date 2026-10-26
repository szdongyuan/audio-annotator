mod support;
use annotator_core::collaboration::*;
use annotator_core::{error::ErrorCode, model::ProjectDocument};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use support::*;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("collaboration-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("media")).unwrap();
        fs::create_dir(root.join("authors")).unwrap();
        fs::create_dir(root.join("annotations")).unwrap();
        let manifest = manifest_json();
        for media in manifest["media"].as_array().unwrap() {
            fs::write(
                root.join(media["sourceRef"].as_str().unwrap()),
                b"fixture media",
            )
            .unwrap();
        }
        write_manifest(&root, &serde_json::from_value(manifest).unwrap());
        Self(root)
    }
    fn repo(&self) -> CollaborationRepository {
        CollaborationRepository::open(&self.0).unwrap()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn payload() -> LayerPayload {
    LayerPayload::from_document(
        &ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v2.json"))
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn public_payload_round_trip_excludes_all_personal_fields() {
    let manifest = parse_manifest(&serde_json::to_vec(&manifest_json()).unwrap()).unwrap();
    let payload = payload();
    let json = serde_json::to_value(&payload).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 3);
    for field in [
        "edits",
        "analysis",
        "playbackMix",
        "viewState",
        "sourceRef",
        "authorId",
    ] {
        let mut injected = json.clone();
        injected[field] = json!([]);
        assert!(serde_json::from_value::<LayerPayload>(injected).is_err());
    }
    let doc = payload.project(&manifest).unwrap();
    assert!(doc.edits.is_empty());
    assert_eq!(LayerPayload::from_document(&doc).unwrap(), payload);
    let mut unknown = payload.clone();
    unknown.media_labels[0].media_id = uuid::Uuid::new_v4().to_string();
    assert!(unknown.project(&manifest).is_err());
}

#[test]
fn independent_authors_preserve_identical_regions_and_retry_acknowledgement() {
    let temp = Temp::new();
    let repo = temp.repo();
    let a = seed(&repo, "a", "A").unwrap();
    let b = seed(&repo, "b", "B").unwrap();
    let sa = repo.adopt(&profile("a")).unwrap();
    let sb = repo.adopt(&profile("b")).unwrap();
    let data = payload();
    let (ra, rb) = std::thread::scope(|scope| {
        let a = scope.spawn(|| repo.publish(&sa, None, &data));
        let b = scope.spawn(|| repo.publish(&sb, None, &data));
        (a.join().unwrap().unwrap(), b.join().unwrap().unwrap())
    });
    assert_eq!(repo.publish(&sa, None, &data).unwrap(), ra);
    assert_eq!(ra.revision, 1);
    assert_eq!(rb.revision, 1);
    let snapshot = repo.snapshot().unwrap();
    assert_eq!(snapshot.authors.len(), 2);
    for author in &snapshot.authors {
        assert_eq!(author.layer.as_ref().unwrap().payload, data);
    }
    let b_path = temp.0.join(format!(
        "annotations/{}/00000000000000000001.json",
        b.author_id
    ));
    let b_before = fs::read(&b_path).unwrap();
    let mut changed = data.clone();
    changed.annotations.clear();
    let ra2 = repo.publish(&sa, Some(&ra), &changed).unwrap();
    assert_eq!(ra2.revision, 2);
    assert!(repo.publish(&sa, None, &changed).is_err());
    assert_eq!(fs::read(b_path).unwrap(), b_before);
    assert_ne!(a.author_id, b.author_id);
    // A capability from another shared root cannot write here, even with the same project UUID.
    let other = Temp::new();
    let other_repo = other.repo();
    assert!(other_repo.publish(&sa, None, &data).is_err());
}

#[test]
fn newest_corruption_is_reported_per_author_without_rollback() {
    let temp = Temp::new();
    let repo = temp.repo();
    let a = seed(&repo, "a", "A").unwrap();
    seed(&repo, "b", "B").unwrap();
    let session = repo.adopt(&profile("a")).unwrap();
    let first = repo.publish(&session, None, &payload()).unwrap();
    repo.publish(&session, Some(&first), &payload()).unwrap();
    let path = temp.0.join(format!(
        "annotations/{}/00000000000000000002.json",
        a.author_id
    ));
    fs::write(path, b"truncated").unwrap();
    let snapshot = repo.snapshot().unwrap();
    let bad = snapshot
        .authors
        .iter()
        .find(|s| s.identity.author_id == a.author_id)
        .unwrap();
    assert!(bad.layer.is_none());
    assert!(bad.error.is_some());
    assert!(snapshot.authors.iter().any(|s| s.error.is_none()));
    assert!(repo.publish(&session, Some(&first), &payload()).is_err());
}

#[test]
fn projection_revalidates_public_manifest_at_api_boundary() {
    let mut manifest = parse_manifest(&serde_json::to_vec(&manifest_json()).unwrap()).unwrap();
    manifest.media[0].source_ref = "../../private.wav".into();
    assert!(
        payload().project(&manifest).is_err(),
        "a constructed manifest cannot bypass path validation"
    );
}

#[test]
fn external_author_metadata_is_strict_and_bounded() {
    let temp = Temp::new();
    let repo = temp.repo();
    let profile = profile("valid");
    drop(repo.adopt(&profile).unwrap());
    let path = temp
        .0
        .join("authors")
        .join(format!("{}.json", profile.author_id));
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("formatVersion", json!(8)),
        ("passwordHash", json!("retired")),
        ("projectId", json!(uuid::Uuid::new_v4().to_string())),
    ] {
        let mut bad = original.clone();
        bad[field] = value;
        assert!(AuthorRecord::parse(
            &serde_json::to_vec(&bad).unwrap(),
            &repo.manifest().project_id
        )
        .is_err());
    }
    fs::write(&path, vec![b' '; 8193]).unwrap();
    assert_eq!(
        repo.adopt(&profile).err().unwrap().code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn fault_and_cancel_cleanup_is_owned_and_ack_loss_is_idempotent() {
    use atomic::PublishFault;
    let temp = Temp::new();
    let repo = temp.repo();
    let author = seed(&repo, "a", "A").unwrap();
    let session = repo.adopt(&profile("a")).unwrap();
    let dir = temp.0.join("annotations").join(&author.author_id);
    let foreign = dir.join(".foreign.tmp");
    fs::write(&foreign, b"not ours").unwrap();
    for fault in [
        PublishFault::PartialWrite,
        PublishFault::Sync,
        PublishFault::Rename,
    ] {
        assert!(repo
            .publish_controlled(&session, None, &payload(), Some(fault), None)
            .is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        assert!(repo.read_author(&author.author_id).unwrap().is_none());
    }
    let cancel = std::sync::atomic::AtomicBool::new(true);
    assert_eq!(
        repo.publish_controlled(&session, None, &payload(), None, Some(&cancel))
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
    assert!(repo
        .publish_controlled(
            &session,
            None,
            &payload(),
            Some(PublishFault::AfterPublish),
            None
        )
        .is_err());
    let checkpoint = repo.publish(&session, None, &payload()).unwrap();
    assert_eq!(checkpoint.revision, 1);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 3);
    assert_eq!(fs::read(foreign).unwrap(), b"not ours");
}

#[test]
fn history_retention_is_sixteen_own_confirmed_versions() {
    let temp = Temp::new();
    let repo = temp.repo();
    let author = seed(&repo, "a", "A").unwrap();
    let session = repo.adopt(&profile("a")).unwrap();
    let other = temp
        .0
        .join("annotations")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&other).unwrap();
    fs::write(other.join("do-not-touch"), b"other").unwrap();
    let mut checkpoint = None;
    for _ in 0..20 {
        checkpoint = Some(
            repo.publish(&session, checkpoint.as_ref(), &payload())
                .unwrap(),
        );
    }
    let dir = temp.0.join("annotations").join(author.author_id);
    assert_eq!(
        fs::read_dir(&dir)
            .unwrap()
            .filter(|e| e
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|s| s == "json"))
            .count(),
        16
    );
    assert!(!dir.join("00000000000000000004.json").exists());
    assert!(dir.join("00000000000000000005.json").exists());
    assert_eq!(fs::read(other.join("do-not-touch")).unwrap(), b"other");
}

#[test]
fn tampered_layers_versions_sizes_and_enumeration_fail_closed() {
    let temp = Temp::new();
    let repo = temp.repo();
    let author = seed(&repo, "a", "A").unwrap();
    let session = repo.adopt(&profile("a")).unwrap();
    repo.publish(&session, None, &payload()).unwrap();
    let dir = temp.0.join("annotations").join(&author.author_id);
    let path = dir.join("00000000000000000001.json");
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("formatVersion", json!(2)),
        ("authorId", json!(uuid::Uuid::new_v4().to_string())),
        ("hash", json!("0".repeat(64))),
        ("viewState", json!({})),
        ("revision", json!(9007199254740992u64)),
    ] {
        let mut bad = original.clone();
        bad[field] = value;
        fs::write(&path, serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(repo.read_author(&author.author_id).is_err());
    }
    let file = fs::File::create(&path).unwrap();
    file.set_len(MAX_LAYER_BYTES as u64 + 1).unwrap();
    drop(file);
    assert_eq!(
        repo.read_author(&author.author_id).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
    for n in 0..256 {
        fs::write(dir.join(format!(".foreign-{n}.tmp")), b"").unwrap();
    }
    assert_eq!(
        repo.read_author(&author.author_id).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn paths_reparse_points_and_manifest_mutation_are_rejected() {
    let temp = Temp::new();
    for path in [
        "../x.wav",
        "C:/x.wav",
        "media/../x.wav",
        "media/x.wav",
        "media/CON.wav",
        "media/a.wav:stream",
    ] {
        let mut bad = manifest_json();
        bad["media"][0]["sourceRef"] = json!(path);
        assert!(parse_manifest(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    let repo = temp.repo();
    seed(&repo, "a", "A").unwrap();
    let session = repo.adopt(&profile("a")).unwrap();
    let mut bad = manifest_json();
    bad["name"] = json!("changed");
    fs::write(
        temp.0.join("collaboration.json"),
        serde_json::to_vec(&bad).unwrap(),
    )
    .unwrap();
    assert!(repo.publish(&session, None, &payload()).is_err());
    write_manifest(&temp.0, &serde_json::from_value(manifest_json()).unwrap());
    let media_path = temp.0.join("media");
    let moved = temp.0.join("media-original");
    fs::rename(&media_path, &moved).unwrap();
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&media_path)
            .arg(&moved)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction setup: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(&moved, &media_path).unwrap();
    assert!(CollaborationRepository::open(&temp.0).is_err());
    // Remove only our link before the fixture owner removes its tree.
    #[cfg(windows)]
    fs::remove_dir(&media_path).unwrap();
    #[cfg(not(windows))]
    fs::remove_file(&media_path).unwrap();
}

fn wait_file(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}
fn child(root: &std::path::Path, role: &str, name: &str) -> std::process::Child {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "subprocess_worker", "--ignored", "--nocapture"])
        .env("COLLAB_TEST_ROOT", root)
        .env("COLLAB_TEST_ROLE", role)
        .env("COLLAB_TEST_NAME", name)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}
fn finished(child: std::process::Child) {
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "child failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "invoked in isolated child processes by the parent integration tests"]
fn subprocess_worker() {
    let root = PathBuf::from(std::env::var_os("COLLAB_TEST_ROOT").unwrap());
    let role = std::env::var("COLLAB_TEST_ROLE").unwrap();
    let name = std::env::var("COLLAB_TEST_NAME").unwrap();
    if role == "no-clobber" {
        fs::write(root.join(format!("ready-{name}")), b"").unwrap();
        wait_file(&root.join("go"));
        let result = atomic::publish_new(&root.join("winner.json"), name.as_bytes(), None, None);
        fs::write(
            root.join(format!("result-{name}")),
            if result.is_ok() { "ok" } else { "conflict" },
        )
        .unwrap();
        return;
    }
    let repo = CollaborationRepository::open(&root).unwrap();
    if role == "register" {
        fs::write(root.join(format!("ready-{name}")), b"").unwrap();
        wait_file(&root.join("go"));
        let result = repo.adopt(&profile("shared user"));
        // Hold the successful lease until both workers have attempted acquisition.
        fs::write(
            root.join(format!("result-{name}")),
            if result.is_ok() { "ok" } else { "rejected" },
        )
        .unwrap();
        wait_file(&root.join(if name == "one" {
            "result-two"
        } else {
            "result-one"
        }));
        return;
    }
    if role == "contend" {
        assert_eq!(
            repo.adopt(&profile("a")).err().unwrap().code,
            ErrorCode::ProjectLocked
        );
        return;
    }
    if role == "publish" {
        let session = repo.adopt(&profile(&name)).unwrap();
        fs::write(root.join(format!("ready-{name}")), b"").unwrap();
        wait_file(&root.join("go"));
        repo.publish(&session, None, &payload()).unwrap();
        return;
    }
    let _session = repo.adopt(&profile("a")).unwrap();
    fs::write(root.join("holder-ready"), b"").unwrap();
    // Parent kills this owned child to prove that OS handle release, not Rust Drop, unlocks it.
    std::thread::sleep(std::time::Duration::from_secs(30));
}

#[test]
fn real_process_lock_contention_and_abrupt_exit_release() {
    let temp = Temp::new();
    let repo = temp.repo();
    seed(&repo, "a", "A").unwrap();
    let mut holder = child(&temp.0, "hold", "holder");
    wait_file(&temp.0.join("holder-ready"));
    let contender = child(&temp.0, "contend", "contender");
    let result = contender.wait_with_output().unwrap();
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(repo.adopt(&profile("a")).is_ok());
}

#[test]
fn real_process_no_clobber_registration_and_independent_author_publication() {
    for role in ["no-clobber", "register", "publish"] {
        let temp = Temp::new();
        let names = if role == "publish" {
            let repo = temp.repo();
            seed(&repo, "a", "A").unwrap();
            seed(&repo, "b", "B").unwrap();
            ["a", "b"]
        } else {
            ["one", "two"]
        };
        let first = child(&temp.0, role, names[0]);
        let second = child(&temp.0, role, names[1]);
        wait_file(&temp.0.join(format!("ready-{}", names[0])));
        wait_file(&temp.0.join(format!("ready-{}", names[1])));
        fs::write(temp.0.join("go"), b"").unwrap();
        finished(first);
        finished(second);
        if role == "publish" {
            let snapshot = temp.repo().snapshot().unwrap();
            assert_eq!(snapshot.authors.len(), 2);
            assert!(snapshot
                .authors
                .iter()
                .all(|a| a.layer.as_ref().unwrap().payload == payload()));
        } else {
            let results: Vec<_> = names
                .iter()
                .map(|name| fs::read_to_string(temp.0.join(format!("result-{name}"))).unwrap())
                .collect();
            assert_eq!(results.iter().filter(|s| s.as_str() == "ok").count(), 1);
            if role == "no-clobber" {
                let winner = fs::read_to_string(temp.0.join("winner.json")).unwrap();
                assert_eq!(
                    results[names.iter().position(|n| *n == winner).unwrap()],
                    "ok"
                );
                assert!(
                    atomic::publish_new(&temp.0.join("winner.json"), b"overwrite", None, None)
                        .is_err()
                );
                assert_eq!(
                    fs::read_to_string(temp.0.join("winner.json")).unwrap(),
                    winner
                );
            } else {
                assert_eq!(temp.repo().snapshot().unwrap().authors.len(), 1);
            }
        }
    }
}

fn manifest_json() -> Value {
    let doc: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/document-v2.json")).unwrap();
    let media: Vec<Value> = doc["media"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let mut m = m.clone();
            let path = format!("media/{}.wav", m["id"].as_str().unwrap());
            let object = m.as_object_mut().unwrap();
            for key in ["note", "channelNotes", "categoryId", "channelCategoryIds"] {
                object.remove(key);
            }
            object.insert("sourceRef".into(), json!(path));
            m
        })
        .collect();
    json!({"kind":"audio-annotator-collaboration", "formatVersion":3, "projectId":doc["projectId"], "name":doc["name"], "createdAt":doc["createdAt"], "media":media})
}

#[test]
fn strict_manifest_round_trip() {
    let json = manifest_json();
    let parsed = parse_manifest(&serde_json::to_vec(&json).unwrap())
        .expect("valid public manifest must load");
    assert_eq!(serde_json::to_value(parsed).unwrap(), json);
}

#[test]
fn strict_manifest_rejects_private_fields_and_versions() {
    for (field, value) in [
        ("formatVersion", json!(2)),
        ("kind", json!("project")),
        ("viewState", json!({})),
    ] {
        let mut json = manifest_json();
        json[field] = value;
        assert!(parse_manifest(&serde_json::to_vec(&json).unwrap()).is_err());
    }
}

#[test]
fn strict_json_rejects_duplicate_fields() {
    let json = serde_json::to_string(&manifest_json()).unwrap();
    let duplicate = format!("{{\"name\":\"first\",{}", &json[1..]);
    assert!(
        parse_manifest(duplicate.as_bytes()).is_err(),
        "strict records cannot silently discard duplicate fields"
    );
}

#[test]
fn oversized_author_is_independent_from_other_visible_authors() {
    let temp = Temp::new();
    let repo = temp.repo();
    let a = seed(&repo, "a", "A").unwrap();
    seed(&repo, "b", "B").unwrap();
    let session = repo.adopt(&profile("a")).unwrap();
    repo.publish(&session, None, &payload()).unwrap();
    let path = temp
        .0
        .join("annotations")
        .join(&a.author_id)
        .join("00000000000000000001.json");
    let file = fs::File::create(path).unwrap();
    file.set_len(MAX_LAYER_BYTES as u64 + 1).unwrap();
    drop(file);
    let snapshot = repo
        .snapshot()
        .expect("one oversized author must not hide another author");
    assert!(snapshot.authors.iter().any(|a| a
        .error
        .as_ref()
        .is_some_and(|e| e.code == ErrorCode::ResourceLimit)));
    assert!(snapshot.authors.iter().any(|a| a.error.is_none()));
}

#[test]
fn cancellation_after_partial_write_cleans_only_its_temporary() {
    let temp = Temp::new();
    let sentinel = temp.0.join(".foreign.tmp");
    fs::write(&sentinel, b"keep").unwrap();
    let result = atomic::publish_new(
        &temp.0.join("cancelled.json"),
        b"partially written",
        Some(atomic::PublishFault::CancelAfterWrite),
        None,
    );
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert!(!temp.0.join("cancelled.json").exists());
    let temp_names: Vec<_> = fs::read_dir(&temp.0)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .filter(|n| n.to_string_lossy().ends_with(".tmp"))
        .collect();
    assert_eq!(temp_names, [sentinel.file_name().unwrap()]);
}

#[test]
fn account_count_and_collection_limits_are_explicit() {
    let temp = Temp::new();
    let repo = temp.repo();
    seed(&repo, "seed", "Seed").unwrap();
    let path = fs::read_dir(temp.0.join("authors"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|s| s == "json"))
        .unwrap();
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for index in 1..128 {
        let _index = index;
        let mut account = original.clone();
        account["identity"]["authorId"] = json!(uuid::Uuid::new_v4().to_string());
        fs::write(
            temp.0.join("authors").join(format!(
                "{}.json",
                account["identity"]["authorId"].as_str().unwrap()
            )),
            serde_json::to_vec(&account).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(repo.snapshot().unwrap().authors.len(), 128);
    assert_eq!(
        seed(&repo, "overflow", "Overflow").unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    let mut too_many = original;
    too_many["identity"]["authorId"] = json!(uuid::Uuid::new_v4().to_string());
    fs::write(
        temp.0.join("authors").join(format!(
            "{}.json",
            too_many["identity"]["authorId"].as_str().unwrap()
        )),
        serde_json::to_vec(&too_many).unwrap(),
    )
    .unwrap();
    assert_eq!(repo.snapshot().unwrap_err().code, ErrorCode::ResourceLimit);
    let manifest = parse_manifest(&serde_json::to_vec(&manifest_json()).unwrap()).unwrap();
    let mut many_categories = payload();
    many_categories.categories = vec![many_categories.categories[0].clone(); 4097];
    assert_eq!(
        many_categories.project(&manifest).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    let mut many_regions = payload();
    many_regions.annotations = vec![many_regions.annotations[0].clone(); 100001];
    assert_eq!(
        many_regions.project(&manifest).unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    let mut manifest = manifest;
    manifest.media = vec![manifest.media[0].clone(); 4097];
    assert_eq!(
        manifest.validate().unwrap_err().code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn aggregate_loaded_layers_cannot_exceed_sixty_four_mib() {
    let temp = Temp::new();
    let repo = temp.repo();
    let mut data = payload();
    data.media_labels[0].note = "n".repeat(14 * 1024 * 1024);
    for index in 0..5 {
        let login = format!("author{index}");
        seed(&repo, &login, &login).unwrap();
        let session = repo.adopt(&profile(&login)).unwrap();
        repo.publish(&session, None, &data).unwrap();
    }
    assert_eq!(repo.snapshot().unwrap_err().code, ErrorCode::ResourceLimit);
}
