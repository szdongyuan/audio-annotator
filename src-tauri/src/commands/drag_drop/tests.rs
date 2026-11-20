use super::*;
use crate::commands::{collaboration, media};
use annotator_core::project::LocalProject;
use std::{fs, sync::mpsc, time::Duration};
use tauri::ipc::{Channel, InvokeResponseBody};

struct Fixture {
    state: AppState,
    root: std::path::PathBuf,
}
impl Fixture {
    fn new(shared: bool) -> Self {
        let root = std::env::temp_dir().join(format!("drop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        fs::create_dir(root.join("folder")).unwrap();
        fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/audio/mono16.wav"),
            root.join("a.WAV"),
        )
        .unwrap();
        fs::write(root.join("b.flac"), b"flac").unwrap();
        fs::write(root.join("a.ZIP"), b"zip").unwrap();
        fs::write(root.join("share.AUDIOPROJ.ZIP"), b"share").unwrap();
        fs::write(root.join("unsupported.txt"), b"other").unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        if shared {
            tauri::async_runtime::block_on(collaboration::defaults::create(
                &state,
                root.join("project").to_string_lossy().into(),
                "Drop".into(),
            ))
            .unwrap();
        } else {
            *state.0.lock().unwrap() =
                Some(LocalProject::create(&root.join("project"), "Drop".into()).unwrap());
            state.6.install(None).unwrap();
        }
        Self { state, root }
    }
    fn path(&self, name: &str) -> String {
        self.root.join(name).to_string_lossy().into()
    }
    fn session(&self) -> DropSession {
        let id = self
            .state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document
            .project_id;
        session_for(&self.state, &id).unwrap()
    }
    fn target(&self) -> Option<DirectTarget> {
        self.session().shared.then_some(DirectTarget {
            folder_id: None,
            layout_revision: 0,
        })
    }
    fn preflight(&self, names: &[&str]) -> Result<DropPreflight> {
        tauri::async_runtime::block_on(preflight(
            &self.state,
            self.session(),
            names.iter().map(|n| self.path(n)).collect(),
            self.target(),
        ))
    }
    fn close(&self) {
        *self.state.0.lock().unwrap() = None;
        self.state.1.lock().unwrap().reset();
        self.state.6.retire();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.close();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn channel<T: serde::Serialize + Clone + Send + Sync + 'static>(
) -> (Channel<T>, mpsc::Receiver<serde_json::Value>) {
    let (tx, rx) = mpsc::channel();
    (
        Channel::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                panic!("JSON")
            };
            tx.send(serde_json::from_str(&json).unwrap())
                .map_err(|e| tauri::Error::Anyhow(e.into()))?;
            Ok(())
        }),
        rx,
    )
}

#[test]
fn classifies_homogeneous_groups_and_rejects_invalid_sets() {
    let f = Fixture::new(true);
    assert_eq!(
        f.preflight(&["a.WAV", "b.flac"]).unwrap().kind,
        DropKind::Audio
    );
    assert_eq!(f.preflight(&["a.ZIP"]).unwrap().kind, DropKind::Zip);
    assert_eq!(f.preflight(&["folder"]).unwrap().kind, DropKind::Folder);
    for names in [
        vec![],
        vec!["folder", "folder"],
        vec!["a.WAV", "a.ZIP"],
        vec!["a.WAV", "unsupported.txt"],
        vec!["missing.wav"],
        vec!["unsupported.txt"],
    ] {
        assert!(f.preflight(&names).is_err(), "{names:?}");
    }
    assert!(f
        .preflight(&["share.AUDIOPROJ.ZIP"])
        .err()
        .unwrap()
        .message
        .contains("导入分享文件"));
    assert!(f.preflight(&vec!["a.WAV"; 257]).is_err());
    assert!(f.preflight(&vec!["a.ZIP"; 33]).is_err());
    assert!(classify(&["relative.wav".into()], false).is_err());
    assert_eq!(
        f.preflight(&vec!["a.WAV"; 256]).unwrap().kind,
        DropKind::Audio
    );
    assert_eq!(f.preflight(&vec!["a.ZIP"; 32]).unwrap().kind, DropKind::Zip);
}

#[cfg(windows)]
#[test]
fn rejects_locked_unreadable_files() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new(true);
    let _locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(f.path("a.WAV"))
        .unwrap();
    assert!(f.preflight(&["a.WAV"]).is_err());
}

#[test]
fn source_path_limit_matches_utf16_bridge_boundary() {
    let max = "a".repeat(16_384);
    let over = format!("{max}a");
    let astral_max = "😀".repeat(8_192);
    let astral_over = "😀".repeat(8_193);
    for kind in [DropKind::Zip, DropKind::Folder] {
        assert!(source_path_length(&max, kind).is_ok());
        assert!(source_path_length(&over, kind).is_err());
        assert!(source_path_length(&astral_max, kind).is_ok());
        assert!(source_path_length(&astral_over, kind).is_err());
    }
    assert!(source_path_length(&over, DropKind::Audio).is_ok());
}

#[cfg(windows)]
#[test]
fn actual_source_preflight_enforces_source_path_boundary() {
    let f = Fixture::new(true);
    let run = |path: &std::path::Path| {
        tauri::async_runtime::block_on(preflight(
            &f.state,
            f.session(),
            vec![path.to_string_lossy().into()],
            f.target(),
        ))
    };
    for (root, component) in [("deep-ascii", "x"), ("deep-cjk", "界")] {
        let mut parent = f.root.join(root);
        fs::create_dir(&parent).unwrap();
        let mut remaining = 16_384 - parent.to_string_lossy().encode_utf16().count() - 1;
        while remaining > 200 {
            let part = 200.min(remaining - 100);
            parent.push(component.repeat(part));
            fs::create_dir(&parent).unwrap();
            remaining -= part + 1;
        }
        let at_limit = parent.join(component.repeat(remaining));
        let over_limit = parent.join(component.repeat(remaining + 1));
        fs::create_dir(&at_limit).unwrap();
        fs::create_dir(&over_limit).unwrap();
        let classified = run(&at_limit).unwrap();
        assert_eq!(classified.kind, DropKind::Folder);
        if component == "界" {
            let config = annotator_core::media::import_source::Config {
                kind: annotator_core::media::import_source::SourceKind::Folder,
                paths: classified.paths,
                rules: Default::default(),
                organization: Default::default(),
            };
            let (ch, rx) = channel();
            let token =
                tauri::async_runtime::block_on(crate::commands::source_import::start_with_layout(
                    &f.state,
                    classified.session.runtime_nonce,
                    classified.session.project_id,
                    config,
                    Some(classified.target.unwrap().layout_revision),
                    ch,
                ))
                .unwrap();
            loop {
                let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
                if event["type"] == "result" {
                    break;
                }
                assert_ne!(event["type"], "failed", "{event}");
            }
            crate::commands::source_import::cancel(&f.state, &token, true).unwrap();
        }
        assert!(run(&over_limit).err().unwrap().message.contains("路径过长"));
        let zip_at_limit = parent.join(format!("{}.zip", component.repeat(remaining - 4)));
        let zip_over_limit = parent.join(format!("{}.zip", component.repeat(remaining - 3)));
        fs::write(&zip_at_limit, b"zip").unwrap();
        fs::write(&zip_over_limit, b"zip").unwrap();
        assert_eq!(run(&zip_at_limit).unwrap().kind, DropKind::Zip);
        assert!(run(&zip_over_limit)
            .err()
            .unwrap()
            .message
            .contains("路径过长"));
    }
}

#[test]
fn unrelated_general_collaboration_job_does_not_block_drop_preflight() {
    for shared in [false, true] {
        let f = Fixture::new(shared);
        let _job = f.state.6.begin("background-sync".into()).unwrap();
        let audio = f.preflight(&["a.WAV"]).unwrap();
        assert_eq!(audio.kind, DropKind::Audio);
        let (ch, rx) = channel();
        let task = tauri::async_runtime::block_on(media::start_targeted(
            &f.state,
            Some(audio.session.runtime_nonce.clone()),
            audio.session.project_id.clone(),
            audio.paths,
            audio.target,
            ch,
        ))
        .unwrap();
        let mut ready = false;
        loop {
            let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
            if event["type"] == "ready" {
                ready = true;
                media::release(&f.state, &task, event["media"]["id"].as_str().unwrap()).unwrap();
            }
            if event["type"] == "finished" {
                break;
            }
        }
        assert!(ready);
        if shared {
            assert_eq!(f.preflight(&["a.ZIP"]).unwrap().kind, DropKind::Zip);
            let folder = f.preflight(&["folder"]).unwrap();
            assert_eq!(folder.kind, DropKind::Folder);
            let config = annotator_core::media::import_source::Config {
                kind: annotator_core::media::import_source::SourceKind::Folder,
                paths: folder.paths,
                rules: Default::default(),
                organization: Default::default(),
            };
            let (ch, rx) = channel();
            let token =
                tauri::async_runtime::block_on(crate::commands::source_import::start_with_layout(
                    &f.state,
                    folder.session.runtime_nonce,
                    folder.session.project_id,
                    config,
                    Some(folder.target.unwrap().layout_revision),
                    ch,
                ))
                .unwrap();
            loop {
                let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
                if event["type"] == "result" {
                    break;
                }
                assert_ne!(event["type"], "failed", "{event}");
            }
            crate::commands::source_import::cancel(&f.state, &token, true).unwrap();
        }
    }
}

#[cfg(windows)]
#[test]
fn ordinary_direct_import_accepts_junction_while_shared_and_source_paths_reject_it() {
    use std::process::Command;
    let ordinary = Fixture::new(false);
    let shared = Fixture::new(true);
    let dest = ordinary.root.join("linked");
    let link = ordinary.root.join("junction");
    fs::create_dir(&dest).unwrap();
    fs::copy(ordinary.root.join("a.WAV"), dest.join("audio.wav")).unwrap();
    fs::copy(ordinary.root.join("a.ZIP"), dest.join("audio.zip")).unwrap();
    let result = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&dest)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "junction creation failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let audio = ordinary.path("junction/audio.wav");
    let zip = ordinary.path("junction/audio.zip");
    let folder = ordinary.path("junction");
    let drop = tauri::async_runtime::block_on(preflight(
        &ordinary.state,
        ordinary.session(),
        vec![audio.clone()],
        None,
    ))
    .unwrap();
    assert_eq!(drop.kind, DropKind::Audio);
    assert!(classify(&[zip.clone()], false).is_err());
    assert!(classify(&[folder.clone()], false).is_err());
    for path in [audio.clone(), zip, folder] {
        assert!(tauri::async_runtime::block_on(preflight(
            &shared.state,
            shared.session(),
            vec![path],
            shared.target()
        ))
        .is_err());
    }
    // Both the existing menu admission and the drop admission decode the same linked source.
    for nonce in [None, Some(drop.session.runtime_nonce)] {
        let (ch, rx) = channel();
        let task = tauri::async_runtime::block_on(media::start_targeted(
            &ordinary.state,
            nonce,
            drop.session.project_id.clone(),
            vec![audio.clone()],
            None,
            ch,
        ))
        .unwrap();
        let mut ready = false;
        loop {
            let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
            if event["type"] == "ready" {
                ready = true;
                media::release(
                    &ordinary.state,
                    &task,
                    event["media"]["id"].as_str().unwrap(),
                )
                .unwrap();
            }
            if event["type"] == "finished" {
                break;
            }
        }
        assert!(
            ready,
            "ordinary direct import must decode through a junction"
        );
    }
}

#[test]
fn capability_target_and_admission_are_checked_for_both_flavors() {
    let ordinary = Fixture::new(false);
    assert_eq!(ordinary.preflight(&["a.WAV"]).unwrap().target, None);
    assert!(ordinary
        .preflight(&["a.ZIP"])
        .err()
        .unwrap()
        .message
        .contains("协作项目"));
    assert!(ordinary.preflight(&["folder"]).is_err());
    let shared = Fixture::new(true);
    let session = shared.session();
    let target = DirectTarget {
        folder_id: None,
        layout_revision: 1,
    };
    assert!(tauri::async_runtime::block_on(preflight(
        &shared.state,
        session.clone(),
        vec![shared.path("a.WAV")],
        Some(target)
    ))
    .is_err());
    let missing = DirectTarget {
        folder_id: Some(uuid::Uuid::new_v4().to_string()),
        layout_revision: 0,
    };
    assert!(tauri::async_runtime::block_on(preflight(
        &shared.state,
        session.clone(),
        vec![shared.path("a.WAV")],
        Some(missing)
    ))
    .is_err());
    let id = "busy-task".to_owned();
    shared.state.1.lock().unwrap().begin(id.clone()).unwrap();
    assert!(shared.preflight(&["a.WAV"]).is_err());
    shared.state.1.lock().unwrap().finish(&id);
    assert!(shared.preflight(&["a.WAV"]).is_ok());
    shared.close();
    tauri::async_runtime::block_on(collaboration::open_mode(
        &shared.state,
        shared.path("project"),
        true,
    ))
    .unwrap();
    assert!(shared
        .preflight(&["a.WAV"])
        .err()
        .unwrap()
        .message
        .contains("只读"));
}

#[test]
fn deleted_drop_target_is_rejected_at_admission_after_successful_preflight() {
    use crate::commands::organization;
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new(true);
    let session = f.session();
    let binding = organization::Binding {
        runtime_nonce: session.runtime_nonce.clone(),
        project_id: session.project_id.clone(),
    };
    let target_id = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding.clone(),
        0,
        OrganizationOperation::CreateFolder {
            id: target_id.clone(),
            parent_id: None,
            name: "target".into(),
        },
    ))
    .unwrap();
    let drop = tauri::async_runtime::block_on(preflight(
        &f.state,
        session,
        vec![f.path("a.WAV")],
        Some(DirectTarget {
            folder_id: Some(target_id.clone()),
            layout_revision: 1,
        }),
    ))
    .unwrap();
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding,
        1,
        OrganizationOperation::RemoveFolder { id: target_id },
    ))
    .unwrap();
    let error = tauri::async_runtime::block_on(media::start_targeted(
        &f.state,
        Some(drop.session.runtime_nonce),
        drop.session.project_id,
        drop.paths,
        drop.target,
        channel().0,
    ))
    .err()
    .unwrap();
    // The drop controller translates this precise error; ordinary menu callers keep it unchanged.
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.message, "Target folder no longer exists");
    assert_eq!(
        f.state
            .6
            .prepared_count
            .load(std::sync::atomic::Ordering::Acquire),
        0
    );
}

#[test]
fn changed_layout_rejects_dropped_publication_and_keeps_prepared_media_for_retry_or_release() {
    use crate::commands::{collaboration::catalog, organization};
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new(true);
    let session = f.session();
    let binding = organization::Binding {
        runtime_nonce: session.runtime_nonce.clone(),
        project_id: session.project_id.clone(),
    };
    let target_id = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding.clone(),
        0,
        OrganizationOperation::CreateFolder {
            id: target_id.clone(),
            parent_id: None,
            name: "target".into(),
        },
    ))
    .unwrap();
    let drop = tauri::async_runtime::block_on(preflight(
        &f.state,
        session,
        vec![f.path("a.WAV")],
        Some(DirectTarget {
            folder_id: Some(target_id.clone()),
            layout_revision: 1,
        }),
    ))
    .unwrap();
    let (ch, rx) = channel();
    let task = tauri::async_runtime::block_on(media::start_targeted(
        &f.state,
        Some(drop.session.runtime_nonce.clone()),
        drop.session.project_id.clone(),
        drop.paths,
        drop.target,
        ch,
    ))
    .unwrap();
    let mut ready = None;
    loop {
        let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        if event["type"] == "ready" {
            ready = Some(
                serde_json::from_value::<annotator_core::model::MediaDescriptor>(
                    event["media"].clone(),
                )
                .unwrap(),
            );
        }
        if event["type"] == "finished" {
            break;
        }
        assert_ne!(event["type"], "failed", "{event}");
    }
    let ready = ready.unwrap();
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding,
        1,
        OrganizationOperation::RenameFolder {
            id: target_id,
            name: "renamed".into(),
        },
    ))
    .unwrap();
    for _ in 0..2 {
        let snapshot = f
            .state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap();
        let expected = collaboration::runtime::Expected {
            runtime_nonce: drop.session.runtime_nonce.clone(),
            project_id: drop.session.project_id.clone(),
            expected_revision: snapshot.document.revision,
        };
        let error =
            tauri::async_runtime::block_on(catalog::import(&f.state, expected, ready.clone()))
                .err()
                .unwrap();
        assert_eq!(error.code, ErrorCode::RevisionConflict);
        assert_eq!(error.message, "Organization layout changed");
        assert_eq!(
            f.state
                .6
                .prepared_count
                .load(std::sync::atomic::Ordering::Acquire),
            1
        );
    }
    assert!(f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .document
        .media
        .is_empty());
    media::release(&f.state, &task, &ready.id).unwrap();
    assert!(!f.state.6.prepared.lock().unwrap().contains_key(&ready.id));
}

#[test]
fn same_project_reopened_has_new_session_and_cannot_admit_old_drop() {
    for shared in [false, true] {
        let f = Fixture::new(shared);
        let old = f.session();
        let drop = f.preflight(&["a.WAV"]).unwrap();
        check(&f.state, &old, &drop.target).unwrap();
        let inspected = classify(&drop.paths, old.shared);
        f.close();
        tauri::async_runtime::block_on(collaboration::open(&f.state, f.path("project"))).unwrap();
        let current = f.session();
        assert_eq!(old.project_id, current.project_id);
        assert_ne!(old.runtime_nonce, current.runtime_nonce);
        let post_io = complete_preflight(
            &f.state,
            old.clone(),
            drop.paths.clone(),
            drop.target.clone(),
            inspected,
        )
        .err()
        .unwrap();
        assert_eq!(post_io.code, ErrorCode::RevisionConflict);
        assert!(post_io.message.contains("重新拖入"));
        assert!(tauri::async_runtime::block_on(preflight(
            &f.state,
            old.clone(),
            drop.paths.clone(),
            drop.target.clone()
        ))
        .is_err());
        assert!(tauri::async_runtime::block_on(media::start_targeted(
            &f.state,
            Some(old.runtime_nonce),
            old.project_id,
            drop.paths,
            drop.target,
            channel().0
        ))
        .is_err());
        let (ch, rx) = channel();
        let now = f.session();
        let task = tauri::async_runtime::block_on(media::start_targeted(
            &f.state,
            Some(now.runtime_nonce),
            now.project_id,
            vec![f.path("a.WAV")],
            f.target(),
            ch,
        ))
        .unwrap();
        let mut ready = false;
        loop {
            let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
            if event["type"] == "ready" {
                ready = true;
                media::release(&f.state, &task, event["media"]["id"].as_str().unwrap()).unwrap();
            }
            if event["type"] == "finished" {
                break;
            }
        }
        assert!(ready);
    }
}

#[test]
fn source_preview_reserves_native_admission_until_release() {
    let f = Fixture::new(true);
    let session = f.session();
    let config = annotator_core::media::import_source::Config {
        kind: annotator_core::media::import_source::SourceKind::Folder,
        paths: vec![f.path("folder")],
        rules: Default::default(),
        organization: Default::default(),
    };
    let (ch, rx) = channel();
    let token = tauri::async_runtime::block_on(crate::commands::source_import::start(
        &f.state,
        session.runtime_nonce,
        session.project_id,
        config,
        ch,
    ))
    .unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if event["type"] == "result" {
            break;
        }
        assert_ne!(event["type"], "failed", "{event}");
    }
    assert!(f.preflight(&["a.WAV"]).is_err());
    crate::commands::source_import::cancel(&f.state, &token, true).unwrap();
    assert!(f.preflight(&["a.WAV"]).is_ok());
}
