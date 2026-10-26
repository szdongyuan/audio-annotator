#![cfg(windows)]
mod support;
use annotator_core::{collaboration::*, error::ErrorCode};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
use support::*;
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("catalog-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn dir(&self, n: &str) -> PathBuf {
        let p = self.0.join(n);
        fs::create_dir(&p).unwrap();
        p
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn wave(path: &Path, value: i16) {
    let mut b = Vec::new();
    b.extend(b"RIFF");
    b.extend(38u32.to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(8000u32.to_le_bytes());
    b.extend(16000u32.to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(2u32.to_le_bytes());
    b.extend(value.to_le_bytes());
    fs::write(path, b).unwrap();
}
fn setup(t: &Temp) -> (CollaborationRepository, AuthorSession) {
    let id = selected(&t.dir("local")).unwrap();
    CollaborationRepository::create_default(&t.dir("project"), "Default", &id).unwrap()
}
fn prepared(t: &Temp, r: &CollaborationRepository, n: &str, v: i16) -> PreparedCatalogMedia {
    let source = t.0.join(format!("{n}.wav"));
    wave(&source, v);
    r.prepare_media(&source, &t.dir(n), &AtomicBool::new(false))
        .unwrap()
}
#[test]
fn empty_default_stable_identity_and_strict_versions() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    assert_eq!(r.manifest().format_version, CURRENT_COLLABORATION_FORMAT);
    assert!(r.manifest().media.is_empty());
    let id = a.identity().clone();
    drop(a);
    let local = selected(&t.0.join("local")).unwrap();
    let reopened = CollaborationRepository::open(r.root()).unwrap();
    assert_eq!(reopened.adopt(&local).unwrap().identity(), &id);
    let held = reopened.adopt(&local).unwrap();
    assert_eq!(
        reopened.adopt(&local).err().unwrap().code,
        ErrorCode::ProjectLocked
    );
    let second = selected(&t.dir("second-local")).unwrap();
    let second_actor = reopened.adopt(&second).unwrap();
    assert_ne!(second_actor.identity().author_id, held.identity().author_id);
    let bytes = fs::read(r.root().join("collaboration.json")).unwrap();
    assert!(parse_manifest(&bytes).is_err());
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    for version in [1, 2, 3, 4, 6] {
        value["formatVersion"] = version.into();
        fs::write(
            r.root().join("collaboration.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert_eq!(
            CollaborationRepository::open(r.root()).err().unwrap().code,
            ErrorCode::UnsupportedVersion
        );
    }
}
#[test]
fn append_is_verified_idempotent_and_does_not_change_manifest_identity() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    let old = fs::read(r.root().join("collaboration.json")).unwrap();
    let m = r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    assert!(r.manifest().media.is_empty());
    assert_eq!(r.append_media(&a, &p, &AtomicBool::new(true)).unwrap(), m);
    let newer = r.reload_catalog().unwrap();
    assert_eq!(newer.manifest().media, vec![m.clone()]);
    assert_eq!(newer.manifest_identity(), r.manifest_identity());
    assert_ne!(newer.catalog_revision(), r.catalog_revision());
    assert_eq!(fs::read(r.root().join("collaboration.json")).unwrap(), old);
    let duplicate = prepared(&t, &r, "duplicate", 1);
    let separately_imported = r
        .append_media(&a, &duplicate, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(separately_imported, duplicate.media().clone());
    assert_ne!(separately_imported.id, m.id);
    assert_eq!(separately_imported.sha256, m.sha256);
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 2);
}
#[test]
fn staged_capability_retains_decoded_pcm_and_identity_for_native_ready_event() {
    let t = Temp::new();
    let (r, _) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    let first = p.decoded();
    let second = p.decoded();
    assert!(std::sync::Arc::ptr_eq(&first, &second));
    assert_eq!(first.descriptor.id, p.media().id);
    assert_eq!(first.descriptor.sha256, p.media().sha256);
    first.verify_source().unwrap();
}

#[test]
fn source_changes_and_cancellation_during_copy_clean_only_owned_staging() {
    let t = Temp::new();
    let (r, _) = setup(&t);
    let source = t.0.join("source.wav");
    wave(&source, 1);
    let sentinel = r.root().join("media/.foreign.tmp");
    fs::write(&sentinel, b"keep").unwrap();
    for cancel_copy in [false, true] {
        wave(&source, 1);
        let cancel = AtomicBool::new(false);
        let result = r.prepare_media_with_progress(&source, &t.0, &cancel, |phase, _| {
            if phase == "copyMedia" {
                if cancel_copy {
                    cancel.store(true, std::sync::atomic::Ordering::Release);
                } else {
                    fs::write(&source, b"changed during copy").unwrap();
                }
            }
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep");
        assert_eq!(fs::read_dir(r.root().join("media")).unwrap().count(), 1);
        assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    }
}
#[test]
fn copy_and_publication_failures_leave_no_visible_record_and_lost_ack_keeps_media() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    let sentinel = r.root().join("catalog/.foreign.tmp");
    fs::write(&sentinel, b"keep").unwrap();
    for fault in [
        atomic::PublishFault::PartialWrite,
        atomic::PublishFault::Sync,
        atomic::PublishFault::Rename,
        atomic::PublishFault::CancelAfterWrite,
    ] {
        assert!(r
            .append_media_controlled(&a, &p, &AtomicBool::new(false), Some(fault))
            .is_err());
        assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    }
    assert!(r
        .append_media_controlled(
            &a,
            &p,
            &AtomicBool::new(false),
            Some(atomic::PublishFault::AfterPublish)
        )
        .is_err());
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 1);
    assert!(r.root().join(&p.media().source_ref).is_file());
    assert_eq!(
        r.append_media(&a, &p, &AtomicBool::new(true)).unwrap(),
        p.media().clone()
    );
    assert_eq!(fs::read(sentinel).unwrap(), b"keep");
}
#[test]
fn changed_source_and_no_clobber_are_rejected() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    wave(&t.0.join("one.wav"), 2);
    assert!(r.append_media(&a, &p, &AtomicBool::new(false)).is_err());
    assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    let q = prepared(&t, &r, "two", 3);
    let target = r.root().join(&q.media().source_ref);
    fs::write(&target, b"foreign").unwrap();
    assert!(r.append_media(&a, &q, &AtomicBool::new(false)).is_err());
    assert_eq!(fs::read(target).unwrap(), b"foreign");
    assert!(r
        .prepare_media(&t.0.join("missing.wav"), &t.0, &AtomicBool::new(false))
        .is_err());
}
#[test]
fn catalog_growth_preserves_old_payload_and_stages_complete_new_layers() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let old_payload = LayerPayload::default();
    let checkpoint = r.publish(&a, None, &old_payload).unwrap();
    let p = prepared(&t, &r, "one", 1);
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let newer = r.reload_catalog().unwrap();
    assert_eq!(
        newer
            .read_author(&a.identity().author_id)
            .unwrap()
            .unwrap()
            .payload,
        old_payload
    );
    let mut payload =
        LayerPayload::from_document(&newer.manifest().base_document().unwrap()).unwrap();
    payload.media_labels[0].note = "new audio".into();
    newer.publish(&a, Some(&checkpoint), &payload).unwrap();
    let result = r.snapshot_with_catalog().unwrap();
    assert!(result.catalog_update_available);
    assert_eq!(result.deferred_authors.len(), 1);
    assert_eq!(result.deferred_authors[0].payload, payload);
    assert!(result.snapshot.authors[0].error.is_none());
    assert!(result.snapshot.authors[0].layer.is_none());
    assert_eq!(
        newer
            .snapshot_with_catalog()
            .unwrap()
            .deferred_authors
            .len(),
        0
    );
    let legacy_view = r.snapshot().unwrap();
    assert!(legacy_view.authors[0]
        .error
        .as_ref()
        .unwrap()
        .details
        .as_ref()
        .unwrap()["catalogUpdateRequired"]
        .as_bool()
        .unwrap());
}

#[test]
fn stale_view_keeps_known_media_authors_syncing_and_unknown_media_is_corruption() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    seed(&r, "other", "Other").unwrap();
    let b = r.adopt(&profile("other")).unwrap();
    let p = prepared(&t, &r, "one", 1);
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let current = r.reload_catalog().unwrap();
    r.publish(&a, None, &LayerPayload::default()).unwrap();
    let mut payload =
        LayerPayload::from_document(&current.manifest().base_document().unwrap()).unwrap();
    payload.media_labels[0].note = "other".into();
    let cp = current.publish(&b, None, &payload).unwrap();
    let snapshot = r.snapshot_with_catalog().unwrap();
    assert_eq!(snapshot.deferred_authors.len(), 1);
    assert!(snapshot
        .snapshot
        .authors
        .iter()
        .find(|x| x.identity.author_id == a.identity().author_id)
        .unwrap()
        .layer
        .is_some());
    let path = r.root().join(format!(
        "annotations/{}/{:020}.json",
        b.identity().author_id,
        cp.revision
    ));
    let mut layer: AuthorLayer = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    layer.payload.media_labels[0].media_id = uuid::Uuid::new_v4().to_string();
    layer.hash = layer.computed_hash().unwrap();
    fs::write(path, serde_json::to_vec(&layer).unwrap()).unwrap();
    let snapshot = r.snapshot_with_catalog().unwrap();
    assert!(snapshot.deferred_authors.is_empty());
    assert!(snapshot
        .snapshot
        .authors
        .iter()
        .find(|x| x.identity.author_id == b.identity().author_id)
        .unwrap()
        .error
        .is_some());
}

fn wait_file(path: &Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
fn child(root: &Path, role: &str) -> std::process::Child {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "catalog_subprocess", "--ignored", "--nocapture"])
        .env("CATALOG_ROOT", root)
        .env("CATALOG_ROLE", role)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}
#[test]
#[ignore = "isolated subprocess worker"]
fn catalog_subprocess() {
    let root = PathBuf::from(std::env::var_os("CATALOG_ROOT").unwrap());
    let role = std::env::var("CATALOG_ROLE").unwrap();
    if role == "crash" {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("project/catalog/.commit.lock"))
            .unwrap();
        lock.lock().unwrap();
        fs::write(root.join("crash-ready"), b"").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
        return;
    }
    let repo = CollaborationRepository::open(&root.join("project")).unwrap();
    let session = repo.adopt(&profile(&role)).unwrap();
    let source = root.join(format!("{role}.wav"));
    let cache = root.join(format!("cache-{role}"));
    fs::create_dir(&cache).unwrap();
    let media = repo
        .prepare_media(&source, &cache, &AtomicBool::new(false))
        .unwrap();
    fs::write(root.join(format!("ready-{role}")), b"").unwrap();
    wait_file(&root.join("go"));
    repo.append_media(&session, &media, &AtomicBool::new(false))
        .unwrap();
}
#[test]
fn real_process_independent_appends_and_crashed_commit_lock_release() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    for (i, name) in ["one", "two"].iter().enumerate() {
        seed(&r, name, name).unwrap();
        wave(&t.0.join(format!("{name}.wav")), i as i16);
    }
    let one = child(&t.0, "one");
    let two = child(&t.0, "two");
    wait_file(&t.0.join("ready-one"));
    wait_file(&t.0.join("ready-two"));
    fs::write(t.0.join("go"), b"").unwrap();
    for worker in [one, two] {
        let output = worker.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 2);
    let mut crashed = child(&t.0, "crash");
    wait_file(&t.0.join("crash-ready"));
    crashed.kill().unwrap();
    crashed.wait().unwrap();
    let p = prepared(&t, &r, "three", 3);
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 3);
}

#[test]
fn partial_files_and_orphan_media_are_invisible_but_reparse_catalog_is_rejected() {
    let t = Temp::new();
    let (r, _) = setup(&t);
    fs::write(r.root().join("catalog/.aborted.tmp"), b"half json").unwrap();
    fs::write(
        r.root().join(format!("media/{}.wav", uuid::Uuid::new_v4())),
        b"orphan",
    )
    .unwrap();
    assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    let old = r.root().join("catalog");
    let moved = r.root().join("catalog-original");
    fs::rename(&old, &moved).unwrap();
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&old)
        .arg(&moved)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rejected = r.reload_catalog().is_err();
    fs::remove_dir(&old).unwrap();
    assert!(rejected);
}

#[test]
fn capabilities_are_project_bound_and_cancellation_never_publishes() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let u = Temp::new();
    let (other, b) = setup(&u);
    let p = prepared(&t, &r, "one", 1);
    assert!(r.append_media(&b, &p, &AtomicBool::new(false)).is_err());
    assert!(other.append_media(&a, &p, &AtomicBool::new(false)).is_err());
    assert_eq!(
        r.append_media(&a, &p, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    assert!(r
        .prepare_media(&t.0.join("one.wav"), &t.0, &AtomicBool::new(true))
        .is_err());
}

#[test]
fn catalog_collection_limit_and_record_versions_are_enforced() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let file = r.root().join(format!("catalog/{}.json", p.media().id));
    let bytes = fs::read(&file).unwrap();
    for mutation in ["version", "unknown", "duplicate", "channels"] {
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        match mutation {
            "version" => value["formatVersion"] = 2.into(),
            "unknown" => value["secret"] = "bad".into(),
            "channels" => value["media"]["channelCount"] = 7.into(),
            _ => {}
        };
        let encoded = if mutation == "duplicate" {
            let s = String::from_utf8(bytes.clone()).unwrap();
            format!("{{\"kind\":\"duplicate\",{}", &s[1..]).into_bytes()
        } else {
            serde_json::to_vec(&value).unwrap()
        };
        fs::write(&file, encoded).unwrap();
        assert!(r.reload_catalog().is_err());
    }
    fs::write(&file, &bytes).unwrap();
    let original: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut organization = r.read_organization().unwrap();
    for i in 1..9999 {
        let mut record = original.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let source = format!("media/{id}.wav");
        record["media"]["id"] = id.clone().into();
        record["media"]["sourceRef"] = source.clone().into();
        record["media"]["sha256"] = format!("{i:064x}").into();
        organization.media.push(organization::MediaMembership {
            media_id: id.clone(),
            folder_id: None,
            original_filename: format!("{id}.wav"),
        });
        fs::write(
            r.root().join(source),
            fs::read(r.root().join(&p.media().source_ref)).unwrap(),
        )
        .unwrap();
        fs::write(
            r.root().join(format!("catalog/{id}.json")),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
    fs::write(
        r.root().join("organization.json"),
        serde_json::to_vec(&organization).unwrap(),
    )
    .unwrap();
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 9999);
    let sentinel = r.root().join("catalog/.foreign.tmp");
    fs::write(&sentinel, b"retained foreign temporary").unwrap();
    let last = prepared(&t, &r, "last", 2);
    r.append_media(&a, &last, &AtomicBool::new(false)).unwrap();
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 10_000);
    assert_eq!(fs::read(sentinel).unwrap(), b"retained foreign temporary");
    let q = prepared(&t, &r, "overflow", 2);
    assert_eq!(
        r.append_media(&a, &q, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    fs::write(
        r.root()
            .join(format!("catalog/{}.json", uuid::Uuid::new_v4())),
        &bytes,
    )
    .unwrap();
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 10_000);
}
#[test]
fn malformed_records_changed_old_media_and_limits_fail_closed() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    let m = r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let loaded = r.reload_catalog().unwrap();
    let file = r.root().join(format!("catalog/{}.json", m.id));
    let bytes = fs::read(&file).unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["media"]["displayName"] = "changed".into();
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(loaded.reload_catalog().is_err());
    for field in ["sourceRef", "id", "sha256"] {
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["media"][field] = "../escape".into();
        fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(r.reload_catalog().is_err());
    }
    fs::write(&file, vec![b' '; 65537]).unwrap();
    assert_eq!(
        r.reload_catalog().err().unwrap().code,
        ErrorCode::ResourceLimit
    );
    fs::write(&file, &bytes).unwrap();
    fs::write(r.root().join("catalog/unknown"), b"x").unwrap();
    assert!(r.reload_catalog().is_err());
}

#[test]
fn aggregate_catalog_bytes_are_bounded_before_loading_all_records() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let record_path = r.root().join(format!("catalog/{}.json", p.media().id));
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(record_path).unwrap()).unwrap();
    let mut organization = r.read_organization().unwrap();
    for _ in 0..280 {
        let id = uuid::Uuid::new_v4().to_string();
        let source = format!("media/{id}.wav");
        let mut record = original.clone();
        record["media"]["id"] = id.clone().into();
        record["media"]["sourceRef"] = source.clone().into();
        record["media"]["displayName"] = "n".repeat(60000).into();
        organization.media.push(organization::MediaMembership {
            media_id: id.clone(),
            folder_id: None,
            original_filename: format!("{id}.wav"),
        });
        fs::write(
            r.root().join(source),
            fs::read(r.root().join(&p.media().source_ref)).unwrap(),
        )
        .unwrap();
        fs::write(
            r.root().join(format!("catalog/{id}.json")),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
    fs::write(
        r.root().join("organization.json"),
        serde_json::to_vec(&organization).unwrap(),
    )
    .unwrap();
    assert_eq!(
        r.reload_catalog().err().unwrap().code,
        ErrorCode::ResourceLimit
    );
}

#[test]
fn catalog_growth_between_capture_and_author_read_is_deferred_not_corrupt() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "racing", 1);
    let mut published = None;
    let result = r
        .snapshot_with_catalog_interleaved(|attempt| {
            if attempt == 0 {
                r.append_media(&a, &p, &AtomicBool::new(false))?;
                let latest = r.reload_catalog()?;
                let mut payload = LayerPayload::from_document(&latest.manifest().base_document()?)?;
                payload.media_labels[0].note = "published after catalog capture".into();
                latest.publish(&a, None, &payload)?;
                published = Some(payload);
            }
            Ok(())
        })
        .unwrap();
    assert!(result.catalog_update_available);
    assert!(result.snapshot.authors[0].error.is_none());
    assert_eq!(result.deferred_authors.len(), 1);
    assert_eq!(result.deferred_authors[0].payload, published.unwrap());
}

#[test]
fn continuously_growing_catalog_has_a_bounded_retryable_snapshot_result() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let prepared: Vec<_> = (0..3)
        .map(|i| prepared(&t, &r, &format!("growth-{i}"), i))
        .collect();
    let mut calls = 0;
    let mut checkpoint = None;
    let result = r.snapshot_with_catalog_interleaved(|attempt| {
        calls += 1;
        assert!(attempt < 3, "snapshot retries must be bounded");
        r.append_media(&a, &prepared[attempt], &AtomicBool::new(false))?;
        let latest = r.reload_catalog()?;
        let payload = LayerPayload::from_document(&latest.manifest().base_document()?)?;
        checkpoint = Some(latest.publish(&a, checkpoint.as_ref(), &payload)?);
        Ok(())
    });
    let error = result
        .err()
        .expect("continuous growth needs a retryable result, not a corrupt author");
    assert_eq!(calls, 3);
    assert!(error.retryable);
    assert_eq!(error.code, ErrorCode::RevisionConflict);
    assert_eq!(error.details.unwrap()["catalogUpdateRequired"], true);
    let settled = r.snapshot_with_catalog().unwrap();
    assert!(settled.snapshot.authors[0].error.is_none());
    assert_eq!(settled.deferred_authors.len(), 1);
}

#[test]
fn same_capability_recovers_owned_orphan_after_record_and_rollback_failures() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "orphan", 1);
    let stage = fs::read_dir(r.root().join("media"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let target = r.root().join(&p.media().source_ref);
    let result = r.append_media_interleaved(
        &a,
        &p,
        &AtomicBool::new(false),
        Some(atomic::PublishFault::Rename),
        || {
            // The record fails, and a foreign file makes rollback to our old staging name fail.
            fs::write(&stage, b"foreign staging file").unwrap();
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(target.is_file());
    assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    assert_eq!(
        r.append_media(&a, &p, &AtomicBool::new(false)).unwrap(),
        p.media().clone()
    );
    assert_eq!(r.reload_catalog().unwrap().manifest().media.len(), 1);
    drop(p);
    assert_eq!(fs::read(&stage).unwrap(), b"foreign staging file");
    assert!(target.is_file());
}

#[test]
fn same_capability_recovers_interrupted_placement_but_rejects_replaced_target() {
    for replace in [false, true] {
        let t = Temp::new();
        let (r, a) = setup(&t);
        let p = prepared(&t, &r, "interrupted", 1);
        let result = r.append_media_interleaved(&a, &p, &AtomicBool::new(false), None, || {
            Err(annotator_core::error::AppError::new(
                ErrorCode::SaveFailed,
                "Interrupted after media placement",
            ))
        });
        assert!(result.is_err());
        let target = r.root().join(&p.media().source_ref);
        let original = fs::read(&target).unwrap();
        if replace {
            // Matching bytes alone do not prove ownership of a newly substituted file.
            fs::rename(&target, t.0.join("retained-original.wav")).unwrap();
            fs::write(&target, &original).unwrap();
            let error = r.append_media(&a, &p, &AtomicBool::new(false)).unwrap_err();
            assert_eq!(error.details.unwrap()["mediaRecoveryRequired"], true);
            assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
        } else {
            assert_eq!(
                r.append_media(&a, &p, &AtomicBool::new(false)).unwrap(),
                p.media().clone()
            );
        }
        drop(p);
        assert_eq!(fs::read(&target).unwrap(), original);
    }
}

#[test]
fn orphan_recovery_rechecks_cancellation_source_and_project_authority() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "guarded", 1);
    r.append_media_interleaved(&a, &p, &AtomicBool::new(false), None, || {
        Err(annotator_core::error::AppError::new(
            ErrorCode::SaveFailed,
            "Interrupted after placement",
        ))
    })
    .unwrap_err();
    assert_eq!(
        r.append_media(&a, &p, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    let other = Temp::new();
    let (_, foreign_actor) = setup(&other);
    assert!(r
        .append_media(&foreign_actor, &p, &AtomicBool::new(false))
        .is_err());
    wave(&t.0.join("guarded.wav"), 2);
    assert!(r.append_media(&a, &p, &AtomicBool::new(false)).is_err());
    assert!(r.reload_catalog().unwrap().manifest().media.is_empty());
    let target = r.root().join(&p.media().source_ref);
    drop(p);
    assert!(target.is_file());
}

#[test]
fn disappearing_temporary_entries_are_ignored_but_committed_entries_remain_strict() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let p = prepared(&t, &r, "one", 1);
    r.append_media(&a, &p, &AtomicBool::new(false)).unwrap();
    let transient = r.root().join("catalog/.disappearing.tmp");
    fs::write(&transient, b"partial").unwrap();
    let opened = CollaborationRepository::open_catalog_interleaved(r.root(), |entry| {
        if entry == transient {
            fs::remove_file(entry).unwrap();
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(opened.manifest().media, vec![p.media().clone()]);
    let linked = r.root().join("catalog/.linked.tmp");
    let outside = t.dir("outside");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&linked)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(output.status.success());
    let rejected = CollaborationRepository::open(r.root()).is_err();
    fs::remove_dir(&linked).unwrap();
    assert!(
        rejected,
        "an existing temporary reparse entry is still forbidden"
    );
    let record = r.root().join(format!("catalog/{}.json", p.media().id));
    assert!(
        CollaborationRepository::open_catalog_interleaved(r.root(), |entry| {
            if entry == record {
                fs::remove_file(entry).unwrap();
            }
            Ok(())
        })
        .is_err()
    );
}

#[test]
fn published_catalog_snapshot_matches_fresh_read_and_revalidates_later_appends() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let first = prepared(&t, &r, "snapshot-first", 1);
    let (media, captured) = r
        .append_media_with_catalog(&a, &first, &AtomicBool::new(false))
        .unwrap();
    let fresh = r.reload_catalog().unwrap();
    assert_eq!(captured.manifest(), fresh.manifest());
    assert_eq!(captured.catalog_revision(), fresh.catalog_revision());
    assert_eq!(captured.manifest().media, vec![media.clone()]);
    assert!(r.manifest().media.is_empty());

    let foreign = prepared(&t, &r, "snapshot-foreign", 2);
    r.append_media(&a, &foreign, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        captured.manifest().media.len(),
        1,
        "captured catalog is immutable"
    );
    // Equivalent valid record whitespace must contribute its exact stored bytes.
    let first_record = r.root().join("catalog").join(format!("{}.json", media.id));
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(&first_record).unwrap()).unwrap();
    fs::write(&first_record, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let third = prepared(&t, &captured, "snapshot-third", 3);
    let (_, extended) = captured
        .append_media_with_catalog(&a, &third, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(extended.manifest().media.len(), 3);
    let fresh = r.reload_catalog().unwrap();
    assert_eq!(extended.manifest(), fresh.manifest());
    assert_eq!(extended.catalog_revision(), fresh.catalog_revision());

    fs::remove_file(t.0.join("snapshot-first.wav")).unwrap();
    let (retried, retry_catalog) = r
        .append_media_with_catalog(&a, &first, &AtomicBool::new(true))
        .unwrap();
    assert_eq!(retried, media);
    assert_eq!(retry_catalog.manifest(), fresh.manifest());
    assert_eq!(retry_catalog.catalog_revision(), fresh.catalog_revision());
}

#[test]
fn published_catalog_snapshot_rejects_changed_known_record_before_new_publication() {
    let t = Temp::new();
    let (r, a) = setup(&t);
    let first = prepared(&t, &r, "known-first", 1);
    let (_, captured) = r
        .append_media_with_catalog(&a, &first, &AtomicBool::new(false))
        .unwrap();
    let next = prepared(&t, &captured, "known-next", 2);
    let record_path = r
        .root()
        .join("catalog")
        .join(format!("{}.json", first.media().id));
    let bytes = fs::read(&record_path).unwrap();
    let mut record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    record["media"]["displayName"] = "substituted.wav".into();
    fs::write(&record_path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(captured
        .append_media_with_catalog(&a, &next, &AtomicBool::new(false))
        .is_err());
    assert!(!r
        .root()
        .join("catalog")
        .join(format!("{}.json", next.media().id))
        .exists());
    fs::write(&record_path, bytes).unwrap();
    let (_, accepted) = captured
        .append_media_with_catalog(&a, &next, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(accepted.manifest(), r.reload_catalog().unwrap().manifest());
}

#[test]
#[ignore = "requires an explicitly supplied owned SMB fixture parent in ANNOTATOR_NAS_TEST_ROOT"]
fn real_smb_published_stamp_survives_prepared_capability_release() {
    use annotator_core::media::identity::{fingerprint, SourceStamp};
    let parent = PathBuf::from(
        std::env::var_os("ANNOTATOR_NAS_TEST_ROOT").expect("owned SMB fixture parent"),
    );
    let root = parent.join(format!("stamp-regression-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap(); // Atomic unique fixture; never remove the supplied parent.
    let local = Temp::new();
    let identity = selected(&local.0).unwrap();
    let (repo, actor) =
        CollaborationRepository::create_default(&root, "SMB sealed copy", &identity).unwrap();
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/audio/mono16.wav");
    let prepared = repo
        .prepare_media(&source, &local.0.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    let (media, _) = repo
        .append_media_with_catalog(&actor, &prepared, &AtomicBool::new(false))
        .unwrap();
    let target = repo.root().join(&media.source_ref);
    let before = SourceStamp::read(&target).unwrap();
    assert_eq!(
        fingerprint(&target, &AtomicBool::new(false), |_| {}).unwrap(),
        media.sha256
    );
    drop(prepared);
    let after = SourceStamp::read(&target).unwrap();
    eprintln!("owned SMB fixture={root:?}; before={before:?}; after={after:?}");
    assert_eq!(
        fingerprint(&target, &AtomicBool::new(false), |_| {}).unwrap(),
        media.sha256
    );
    assert_eq!(
        before, after,
        "releasing the identity capability must not change a published source stamp"
    );
    before.verify(&target).unwrap();
}
