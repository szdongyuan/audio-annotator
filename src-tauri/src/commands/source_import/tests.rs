use super::*;
use crate::commands::collaboration::{defaults, runtime::Expected};
use std::{fs, sync::mpsc, time::Duration};
use tauri::ipc::InvokeResponseBody;
struct Fixture {
    state: AppState,
    root: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("source-host-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("project")).unwrap();
        fs::create_dir(root.join("audio")).unwrap();
        fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/audio/mono16.wav"),
            root.join("audio/CH1.wav"),
        )
        .unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(defaults::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Sources".into(),
        ))
        .unwrap();
        Self { state, root }
    }
    fn close(&self) {
        *self.state.0.lock().unwrap() = None;
        self.state.1.lock().unwrap().reset();
        self.state.6.retire();
    }
    fn expected(&self) -> Expected {
        let p = self.state.0.lock().unwrap();
        let d = p.as_ref().unwrap().snapshot().unwrap().document;
        Expected {
            runtime_nonce: self.state.6.current.lock().unwrap().nonce.clone(),
            project_id: d.project_id,
            expected_revision: d.revision,
        }
    }
    fn config(&self) -> Config {
        Config {
            organization: Default::default(),
            kind: annotator_core::media::import_source::SourceKind::Folder,
            paths: vec![self.root.join("audio").to_string_lossy().into()],
            rules: Default::default(),
        }
    }
    fn scan(&self) -> Token {
        let (channel, rx) = channel();
        let e = self.expected();
        let token = tauri::async_runtime::block_on(start(
            &self.state,
            e.runtime_nonce,
            e.project_id,
            self.config(),
            channel,
        ))
        .unwrap();
        loop {
            let event = rx.recv_timeout(Duration::from_secs(20)).unwrap();
            if event["type"] == "result" {
                break;
            }
            assert_ne!(event["type"], "failed", "{event}");
        }
        token
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        *self.state.0.lock().unwrap() = None;
        self.state.6.retire();
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
fn preview_is_owned_bounded_and_never_publishes() {
    let f = Fixture::new();
    let token = f.scan();
    assert_eq!(page(&f.state, &token, 0, 50).unwrap().candidates.len(), 1);
    assert!(page(&f.state, &token, 0, 51).is_err());
    let mut wrong = token.clone();
    wrong.runtime_nonce = "foreign".into();
    assert!(page(&f.state, &wrong, 0, 1).is_err());
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
    let e = f.expected();
    assert!(
        tauri::async_runtime::block_on(crate::commands::media::start(
            &f.state,
            Some(e.runtime_nonce),
            e.project_id,
            vec![f.root.join("audio/CH1.wav").to_string_lossy().into()],
            None,
            channel().0
        ))
        .is_err()
    );
    f.state.6.retire();
    assert!(page(&f.state, &token, 0, 1).is_err());
}
fn wait_media(rx: &mpsc::Receiver<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut out = vec![];
    loop {
        let event = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        let done = event["type"] == "finished";
        out.push(event);
        if done {
            return out;
        }
    }
}
fn zip_config(f: &Fixture, count: usize) -> Config {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(fs::File::create(f.root.join("recordings.zip")).unwrap());
    let bytes = fs::read(f.root.join("audio/CH1.wav")).unwrap();
    for i in 0..count {
        zip.start_file(
            format!("record-{i}/audio/CH1.wav"),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap();
    Config {
        organization: Default::default(),
        kind: import_source::SourceKind::Zip,
        paths: vec![f.root.join("recordings.zip").to_string_lossy().into()],
        rules: Default::default(),
    }
}
fn scan_config(f: &Fixture, config: Config) -> Token {
    let e = f.expected();
    let (ch, rx) = channel();
    let t =
        tauri::async_runtime::block_on(start(&f.state, e.runtime_nonce, e.project_id, config, ch))
            .unwrap();
    loop {
        let v = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        if v["type"] == "result" {
            return t;
        }
        assert_ne!(v["type"], "failed", "{v}");
    }
}
#[test]
fn zip_ready_retains_source_through_release_preview_publication_retry_and_reopen() {
    use crate::commands::collaboration::catalog;
    let f = Fixture::new();
    let token = scan_config(&f, zip_config(&f, 1));
    let preview = page(&f.state, &token, 0, 1).unwrap().candidates.remove(0);
    let (ch, rx) = channel();
    let task = tauri::async_runtime::block_on(batch(&f.state, token.clone(), vec![0], ch)).unwrap();
    let events = wait_media(&rx);
    assert!(events.iter().all(|e| e["type"] != "failed"), "{events:?}");
    let ready: annotator_core::model::MediaDescriptor = serde_json::from_value(
        events.iter().find(|e| e["type"] == "ready").unwrap()["media"].clone(),
    )
    .unwrap();
    assert_eq!(ready.display_name, preview.display_name);
    let staged = std::path::PathBuf::from(&ready.source_ref);
    assert!(staged.is_file());
    cancel(&f.state, &token, true).unwrap();
    fs::remove_file(f.root.join("recordings.zip")).unwrap();
    assert!(
        staged.is_file(),
        "pending publication owns staging independently of preview"
    );
    let admitted = f.expected();
    let busy = f.state.6.begin("block-publication".into()).unwrap();
    assert!(
        tauri::async_runtime::block_on(catalog::import(&f.state, admitted.clone(), ready.clone()))
            .unwrap_err()
            .retryable
    );
    assert!(staged.is_file());
    drop(busy);
    let imported =
        tauri::async_runtime::block_on(catalog::import(&f.state, admitted.clone(), ready.clone()))
            .unwrap();
    assert_eq!(
        imported.document.media[0].display_name,
        preview.display_name
    );
    assert_eq!(
        tauri::async_runtime::block_on(catalog::import(&f.state, admitted, ready.clone()))
            .unwrap()
            .document,
        imported.document
    );
    crate::commands::media::release(&f.state, &task, &ready.id).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while staged.exists() && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(!staged.exists());
    let stored = &imported.document.media[0];
    assert!(stored.source_ref.starts_with("media/"));
    // Native registry now points at the durable copy, even after its extraction lease is gone.
    f.state
        .1
        .lock()
        .unwrap()
        .registry
        .get_checked(stored)
        .unwrap();
    f.state
        .0
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .save(&imported.document.project_id, imported.document.revision)
        .unwrap();
    assert_eq!(
        fs::read(f.root.join("project").join(&stored.source_ref)).unwrap(),
        fs::read(f.root.join("audio/CH1.wav")).unwrap()
    );
    f.close();
    tauri::async_runtime::block_on(crate::commands::collaboration::open(
        &f.state,
        f.root.join("project").to_string_lossy().into(),
    ))
    .unwrap();
    let current = f.state.0.lock().unwrap();
    assert_eq!(
        current.as_ref().unwrap().snapshot().unwrap().document.media[0],
        *stored
    );
    let decoded = annotator_core::media::decode::decode(
        &f.root.join("project").join(&stored.source_ref),
        &f.root.join("reopen-pcm"),
        &AtomicBool::new(false),
        |_, _| {},
    )
    .unwrap();
    assert!(annotator_core::media::registry::same_identity(
        &decoded.descriptor,
        stored
    ));
}
#[test]
fn source_change_cancel_and_invalid_indices_never_publish() {
    let f = Fixture::new();
    let t = f.scan();
    for indices in [vec![], vec![1], vec![0, 0], vec![0; 257]] {
        assert!(
            tauri::async_runtime::block_on(batch(&f.state, t.clone(), indices, channel().0))
                .is_err()
        );
    }
    fs::write(f.root.join("audio/CH1.wav"), b"changed").unwrap();
    let (ch, rx) = channel();
    tauri::async_runtime::block_on(batch(&f.state, t.clone(), vec![0], ch)).unwrap();
    let events = wait_media(&rx);
    let failed = events.iter().find(|e| e["type"] == "failed").unwrap();
    assert!(failed["error"]["message"]
        .as_str()
        .unwrap()
        .contains("重新扫描"));
    assert!(events.iter().all(|e| e["type"] != "ready"));
    cancel(&f.state, &t, false).unwrap();
    assert!(page(&f.state, &t, 0, 1).is_err());
    assert!(
        tauri::async_runtime::block_on(batch(&f.state, t.clone(), vec![0], channel().0)).is_err()
    );
    cancel(&f.state, &t, true).unwrap();
}
#[test]
fn legacy_and_view_only_rejected_before_source_io() {
    let f = Fixture::new();
    f.close();
    tauri::async_runtime::block_on(crate::commands::collaboration::open_mode(
        &f.state,
        f.root.join("project").to_string_lossy().into(),
        true,
    ))
    .unwrap();
    let e = f.expected();
    assert!(tauri::async_runtime::block_on(start(
        &f.state,
        e.runtime_nonce,
        e.project_id,
        f.config(),
        channel().0
    ))
    .is_err());
    fs::create_dir(f.root.join("legacy")).unwrap();
    *f.state.0.lock().unwrap() = Some(
        annotator_core::project::LocalProject::create(&f.root.join("legacy"), "Legacy".into())
            .unwrap(),
    );
    f.state.6.retire();
    let e = f.expected();
    assert!(tauri::async_runtime::block_on(start(
        &f.state,
        e.runtime_nonce.clone(),
        e.project_id.clone(),
        f.config(),
        channel().0
    ))
    .is_err());
    let (ch, rx) = channel();
    tauri::async_runtime::block_on(crate::commands::media::start(
        &f.state,
        Some(e.runtime_nonce),
        e.project_id,
        vec![f.root.join("audio/CH1.wav").to_string_lossy().into()],
        None,
        ch,
    ))
    .unwrap();
    assert!(wait_media(&rx).iter().any(|e| e["type"] == "ready"));
}
#[test]
fn scan_channel_failure_cancels_and_releases_preview() {
    let f = Fixture::new();
    let e = f.expected();
    let (ch, rx) = channel();
    drop(rx);
    let t = tauri::async_runtime::block_on(start(
        &f.state,
        e.runtime_nonce,
        e.project_id,
        f.config(),
        ch,
    ))
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while f.state.6.sources.lock().unwrap().active() && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(!f.state.6.sources.lock().unwrap().active());
    assert!(page(&f.state, &t, 0, 1).is_err());
}
#[test]
fn batches_over_256_keep_preview_indices_and_release_each_pending_capability() {
    let f = Fixture::new();
    let token = scan_config(&f, distinct_zip_config(&f, 257));
    assert_eq!(page(&f.state, &token, 0, 50).unwrap().candidates.len(), 50);
    assert_eq!(
        page(&f.state, &token, 256, 50).unwrap().candidates[0].index,
        256
    );
    let mut prepared = 0;
    for indices in [(0..256).collect::<Vec<_>>(), vec![256]] {
        let (ch, rx) = channel();
        let task =
            tauri::async_runtime::block_on(batch(&f.state, token.clone(), indices.clone(), ch))
                .unwrap();
        for event in wait_media(&rx) {
            assert_ne!(event["type"], "failed", "{event}");
            if event["type"] == "ready" {
                let index = event["index"].as_u64().unwrap() as usize;
                let candidate = page(&f.state, &token, indices[index], 1)
                    .unwrap()
                    .candidates
                    .remove(0);
                assert_eq!(event["media"]["displayName"], candidate.display_name);
                super::super::collaboration::catalog::release(
                    &f.state.6,
                    &task,
                    event["media"]["id"].as_str().unwrap(),
                )
                .unwrap();
                prepared += 1;
            }
        }
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while f.state.6.prepared_count.load(Ordering::Acquire) != 0
            && std::time::Instant::now() < until
        {
            std::thread::yield_now();
        }
        assert_eq!(f.state.6.prepared_count.load(Ordering::Acquire), 0);
    }
    assert_eq!(prepared, 257);
}
#[test]
fn release_inflight_preview_keeps_admitted_batch_and_reset_cancels_worker() {
    for retire in [false, true] {
        let f = Fixture::new();
        let token = f.scan();
        let (entered, enter) = mpsc::channel();
        let (resume, resumed) = mpsc::channel();
        *f.state.6.hook.lock().unwrap() = Some(Box::new(move || {
            entered.send(()).unwrap();
            resumed.recv_timeout(Duration::from_secs(10)).unwrap();
        }));
        let (ch, rx) = channel();
        let task =
            tauri::async_runtime::block_on(batch(&f.state, token.clone(), vec![0], ch)).unwrap();
        enter.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(f.state.0.try_lock().is_ok());
        assert!(f.state.6.sources.try_lock().is_ok());
        if retire {
            f.state.6.retire();
        } else {
            cancel(&f.state, &token, true).unwrap();
        }
        resume.send(()).unwrap();
        let events = wait_media(&rx);
        if retire {
            assert!(events.iter().all(|e| e["type"] != "ready"));
            assert_eq!(events.last().unwrap()["cancelled"], true);
        } else {
            let e = events.iter().find(|e| e["type"] == "ready").unwrap();
            super::super::collaboration::catalog::release(
                &f.state.6,
                &task,
                e["media"]["id"].as_str().unwrap(),
            )
            .unwrap();
        }
    }
}
#[test]
fn cancelled_scan_and_disconnected_media_release_resources() {
    let f = Fixture::new();
    let e = f.expected();
    let (entered, enter) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    *f.state.6.hook.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        resumed.recv_timeout(Duration::from_secs(10)).unwrap();
    }));
    let (ch, rx) = channel();
    let t = tauri::async_runtime::block_on(start(
        &f.state,
        e.runtime_nonce,
        e.project_id,
        f.config(),
        ch,
    ))
    .unwrap();
    enter.recv_timeout(Duration::from_secs(10)).unwrap();
    cancel(&f.state, &t, false).unwrap();
    resume.send(()).unwrap();
    let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(event["type"], "failed");
    cancel(&f.state, &t, true).unwrap();
    let t = f.scan();
    let (tx, done) = mpsc::channel();
    let ch = Channel::new(move |body| {
        let InvokeResponseBody::Json(json) = body else {
            unreachable!()
        };
        let event: serde_json::Value = serde_json::from_str(&json).unwrap();
        if event["type"] == "ready" {
            return Err(tauri::Error::Anyhow(
                std::io::Error::other("disconnected").into(),
            ));
        }
        if event["type"] == "finished" {
            tx.send(event).unwrap();
        }
        Ok(())
    });
    tauri::async_runtime::block_on(batch(&f.state, t, vec![0], ch)).unwrap();
    assert_eq!(
        done.recv_timeout(Duration::from_secs(10)).unwrap()["cancelled"],
        true
    );
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while f.state.6.prepared_count.load(Ordering::Acquire) != 0 && std::time::Instant::now() < until
    {
        std::thread::yield_now();
    }
    assert_eq!(f.state.6.prepared_count.load(Ordering::Acquire), 0);
}
#[test]
fn scan_events_can_arrive_before_ack_and_do_not_hold_authority_locks() {
    let f = Fixture::new();
    let e = f.expected();
    let config = f.config();
    let captured = f.state.clone();
    let state = f.state.clone();
    let (tx, rx) = mpsc::channel();
    let (ack_tx, ack_rx) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    let ch = Channel::new(move |body| {
        assert!(captured.0.try_lock().is_ok());
        assert!(captured.6.sources.try_lock().is_ok());
        let InvokeResponseBody::Json(json) = body else {
            unreachable!()
        };
        tx.send(serde_json::from_str::<serde_json::Value>(&json).unwrap())
            .unwrap();
        Ok(())
    });
    let worker = std::thread::spawn(move || {
        let token = tauri::async_runtime::block_on(start(
            &state,
            e.runtime_nonce,
            e.project_id,
            config,
            ch,
        ))
        .unwrap();
        resumed.recv_timeout(Duration::from_secs(10)).unwrap();
        ack_tx.send(token).unwrap();
    });
    let event = loop {
        let event = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        if event["type"] == "result" {
            break event;
        }
    };
    assert!(ack_rx.try_recv().is_err());
    let event_token: Token = serde_json::from_value(event["token"].clone()).unwrap();
    assert_eq!(
        page(&f.state, &event_token, 0, 1).unwrap().candidates.len(),
        1
    );
    resume.send(()).unwrap();
    assert_eq!(
        ack_rx.recv_timeout(Duration::from_secs(10)).unwrap(),
        event_token
    );
    worker.join().unwrap();
}
#[test]
fn accepted_ready_cannot_publish_after_runtime_replacement() {
    let f = Fixture::new();
    let token = f.scan();
    let (ch, rx) = channel();
    tauri::async_runtime::block_on(batch(&f.state, token, vec![0], ch)).unwrap();
    let events = wait_media(&rx);
    let ready: annotator_core::model::MediaDescriptor = serde_json::from_value(
        events.iter().find(|e| e["type"] == "ready").unwrap()["media"].clone(),
    )
    .unwrap();
    let expected = f.expected();
    f.state.6.retire();
    assert!(
        tauri::async_runtime::block_on(super::super::collaboration::catalog::import(
            &f.state, expected, ready
        ))
        .is_err()
    );
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
}
#[test]
fn folder_preview_skips_only_existing_project_media_paths() {
    let f = Fixture::new();
    let token = f.scan();
    let (ch, rx) = channel();
    let task = tauri::async_runtime::block_on(batch(&f.state, token.clone(), vec![0], ch)).unwrap();
    let events = wait_media(&rx);
    let ready: annotator_core::model::MediaDescriptor = serde_json::from_value(
        events.iter().find(|e| e["type"] == "ready").unwrap()["media"].clone(),
    )
    .unwrap();
    tauri::async_runtime::block_on(super::super::collaboration::catalog::import(
        &f.state,
        f.expected(),
        ready.clone(),
    ))
    .unwrap();
    crate::commands::media::release(&f.state, &task, &ready.id).unwrap();
    cancel(&f.state, &token, true).unwrap();
    let config = Config {
        organization: Default::default(),
        paths: vec![f.root.join("project/media").to_string_lossy().into()],
        ..f.config()
    };
    let token = scan_config(&f, config);
    let page = page(&f.state, &token, 0, 50).unwrap();
    assert!(page.candidates.is_empty());
    assert_eq!(page.counts.skipped, 1);
    cancel(&f.state, &token, true).unwrap();
    let mut legacy = f.config();
    legacy.rules.skip_duplicates = false;
    let original = scan_config(&f, legacy);
    assert_eq!(
        super::page(&f.state, &original, 0, 1)
            .unwrap()
            .candidates
            .len(),
        1
    );
    cancel(&f.state, &original, true).unwrap();
    let mut legacy_zip = zip_config(&f, 2);
    legacy_zip.rules.skip_duplicates = false;
    let zip = scan_config(&f, legacy_zip);
    assert_eq!(
        super::page(&f.state, &zip, 0, 50).unwrap().candidates.len(),
        2
    );
}
#[test]
fn release_ack_retry_is_idempotent_and_cannot_release_new_preview() {
    let f = Fixture::new();
    let old = f.scan();
    cancel(&f.state, &old, true).unwrap();
    cancel(&f.state, &old, true).unwrap();
    let new = f.scan();
    cancel(&f.state, &old, true).unwrap();
    assert_eq!(page(&f.state, &new, 0, 1).unwrap().candidates.len(), 1);
}
#[test]
fn finished_callback_can_immediately_start_next_source_batch() {
    let f = Fixture::new();
    // Both batches fail decoding, so there are no publications or disposal barriers.
    fs::write(f.root.join("audio/CH1.wav"), b"not an audio stream").unwrap();
    let token = f.scan();
    let state = f.state.clone();
    let next_token = token.clone();
    let (next_channel, next_events) = channel();
    let (started, next_started) = mpsc::channel();
    let (sent, first_events) = mpsc::channel();
    let first_channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(json) = body else {
            unreachable!()
        };
        let event: serde_json::Value = serde_json::from_str(&json).unwrap();
        if event["type"] == "finished" {
            started
                .send(tauri::async_runtime::block_on(batch(
                    &state,
                    next_token.clone(),
                    vec![0],
                    next_channel.clone(),
                )))
                .unwrap();
        }
        sent.send(event).unwrap();
        Ok(())
    });
    tauri::async_runtime::block_on(batch(&f.state, token, vec![0], first_channel)).unwrap();
    let first = wait_media(&first_events);
    assert!(first.iter().any(|event| event["type"] == "failed"));
    assert!(first.iter().all(|event| event["type"] != "ready"));
    next_started
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .expect(
            "Finished must release preparation admission before invoking the terminal callback",
        );
    let next = wait_media(&next_events);
    assert!(next.iter().any(|event| event["type"] == "failed"));
    assert!(next.iter().all(|event| event["type"] != "ready"));
    assert_eq!(f.state.6.prepared_count.load(Ordering::Acquire), 0);
}

#[test]
fn native_preview_seals_target_paths_original_names_and_manual_layout_revision() {
    use crate::commands::{collaboration::catalog, organization};
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new();
    let e = f.expected();
    let binding = organization::Binding {
        runtime_nonce: e.runtime_nonce,
        project_id: e.project_id,
    };
    let target = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding.clone(),
        0,
        OrganizationOperation::CreateFolder {
            id: target.clone(),
            parent_id: None,
            name: "选中".into(),
        },
    ))
    .unwrap();
    let mut config = zip_config(&f, 2);
    config.organization.target_folder_id = Some(target.clone());
    config.organization.mode = import_source::OrganizationMode::Template;
    config.organization.template = "共同".into();
    config.rules.skip_duplicates = false;
    let token = scan_config(&f, config);
    let preview = page(&f.state, &token, 0, 1).unwrap();
    assert_eq!(
        preview.candidates[0].resulting_folder_path,
        ["选中", "共同"]
    );
    assert_eq!(preview.folder_summary.len(), 2);
    println!(
        "import_source_page IPC {}",
        serde_json::to_string(&preview).unwrap()
    );
    let (ch, rx) = channel();
    let task =
        tauri::async_runtime::block_on(batch(&f.state, token.clone(), vec![0, 1], ch)).unwrap();
    let events = wait_media(&rx);
    assert!(events.iter().all(|e| e["type"] != "failed"), "{events:?}");
    let ready = events
        .iter()
        .filter(|e| e["type"] == "ready")
        .map(|e| {
            serde_json::from_value::<annotator_core::model::MediaDescriptor>(e["media"].clone())
                .unwrap()
        })
        .collect::<Vec<_>>();
    let mut forged = ready[0].clone();
    forged.display_name = "forged/path.wav".into();
    assert!(
        tauri::async_runtime::block_on(catalog::import(&f.state, f.expected(), forged)).is_err()
    );
    for descriptor in &ready {
        tauri::async_runtime::block_on(catalog::import(&f.state, f.expected(), descriptor.clone()))
            .unwrap();
    }
    let head = tauri::async_runtime::block_on(organization::get(&f.state, binding.clone()))
        .unwrap()
        .organization;
    assert_eq!(head.folders.len(), 2);
    assert_eq!(head.layout_revision, 1);
    assert!(head.media.iter().all(|m| m.original_filename == "CH1.wav"));
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding,
        head.revision,
        OrganizationOperation::RenameFolder {
            id: target,
            name: "新名字".into(),
        },
    ))
    .unwrap();
    assert!(page(&f.state, &token, 0, 1).is_err());
    assert!(
        tauri::async_runtime::block_on(batch(&f.state, token.clone(), vec![0], channel().0))
            .is_err()
    );
    // Committed retries acknowledge the current moved layout, with the original capability.
    tauri::async_runtime::block_on(catalog::import(&f.state, f.expected(), ready[0].clone()))
        .unwrap();
    for descriptor in &ready {
        crate::commands::media::release(&f.state, &task, &descriptor.id).unwrap();
    }
}
#[test]
fn native_prepared_placement_rejects_manual_changes_before_publication() {
    use crate::commands::{collaboration::catalog, organization};
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new();
    let mut config = zip_config(&f, 1);
    config.organization.mode = import_source::OrganizationMode::SourcePath;
    let token = scan_config(&f, config);
    let (ch, rx) = channel();
    let task = tauri::async_runtime::block_on(batch(&f.state, token, vec![0], ch)).unwrap();
    let events = wait_media(&rx);
    let ready: annotator_core::model::MediaDescriptor = serde_json::from_value(
        events.iter().find(|e| e["type"] == "ready").unwrap()["media"].clone(),
    )
    .unwrap();
    let e = f.expected();
    let binding = organization::Binding {
        runtime_nonce: e.runtime_nonce,
        project_id: e.project_id,
    };
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding.clone(),
        0,
        OrganizationOperation::CreateFolder {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id: None,
            name: "manual".into(),
        },
    ))
    .unwrap();
    assert!(
        tauri::async_runtime::block_on(catalog::import(&f.state, f.expected(), ready.clone()))
            .is_err()
    );
    let head = tauri::async_runtime::block_on(organization::get(&f.state, binding))
        .unwrap()
        .organization;
    assert!(head.media.is_empty());
    assert_eq!(head.folders.len(), 1);
    crate::commands::media::release(&f.state, &task, &ready.id).unwrap();
}

#[test]
fn direct_import_target_is_bound_and_relink_keeps_membership_and_filename() {
    use crate::commands::{collaboration::catalog, media, organization};
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new();
    let e = f.expected();
    let binding = organization::Binding {
        runtime_nonce: e.runtime_nonce,
        project_id: e.project_id,
    };
    let target = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::block_on(organization::apply(
        &f.state,
        binding.clone(),
        0,
        OrganizationOperation::CreateFolder {
            id: target.clone(),
            parent_id: None,
            name: "direct".into(),
        },
    ))
    .unwrap();
    let e = f.expected();
    let (ch, rx) = channel();
    let task = tauri::async_runtime::block_on(media::start_targeted(
        &f.state,
        Some(e.runtime_nonce),
        e.project_id,
        vec![f.root.join("audio/CH1.wav").to_string_lossy().into()],
        Some(media::DirectTarget {
            folder_id: Some(target.clone()),
            layout_revision: 1,
        }),
        ch,
    ))
    .unwrap();
    let events = wait_media(&rx);
    let ready: annotator_core::model::MediaDescriptor = serde_json::from_value(
        events.iter().find(|e| e["type"] == "ready").unwrap()["media"].clone(),
    )
    .unwrap();
    tauri::async_runtime::block_on(catalog::import(&f.state, f.expected(), ready.clone())).unwrap();
    let head = tauri::async_runtime::block_on(organization::get(&f.state, binding.clone()))
        .unwrap()
        .organization;
    assert_eq!(head.media[0].folder_id, Some(target));
    assert_eq!(head.media[0].original_filename, "CH1.wav");
    media::release(&f.state, &task, &ready.id).unwrap();
    let e = f.expected();
    let (ch, rx) = channel();
    let relink_task = tauri::async_runtime::block_on(media::start(
        &f.state,
        Some(e.runtime_nonce),
        e.project_id,
        vec![f.root.join("audio/CH1.wav").to_string_lossy().into()],
        Some(ready.id.clone()),
        ch,
    ))
    .unwrap();
    assert!(wait_media(&rx).iter().all(|e| e["type"] != "failed"));
    assert_eq!(
        tauri::async_runtime::block_on(organization::get(&f.state, binding))
            .unwrap()
            .organization,
        head
    );
    media::release(&f.state, &relink_task, &ready.id).unwrap();
}

#[test]
fn scan_preflight_excludes_paths_that_exceed_existing_project_folder_capacity() {
    let f = Fixture::new();
    let repo = f.state.6.current.lock().unwrap().repo.clone().unwrap();
    let mut head = repo.read_organization().unwrap();
    head.revision = 1;
    head.layout_revision = 1;
    head.folders = (0..10_000)
        .map(|i| annotator_core::collaboration::organization::Folder {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id: None,
            name: format!("existing-{i}"),
        })
        .collect();
    head.validate().unwrap();
    fs::write(
        f.root.join("project/organization.json"),
        serde_json::to_vec(&head).unwrap(),
    )
    .unwrap();
    let mut config = zip_config(&f, 1);
    config.organization.mode = import_source::OrganizationMode::Template;
    config.organization.template = "new".into();
    let token = scan_config(&f, config);
    let preview = page(&f.state, &token, 0, 50).unwrap();
    assert_eq!(preview.counts.candidates, 0);
    assert_eq!(preview.counts.skipped, 1);
    assert_eq!(preview.counts.issues, 1);
    assert!(preview.folder_summary.is_empty());
}

#[test]
fn batch_publication_adopts_prepared_sources_once_and_rejects_forgery() {
    use crate::commands::collaboration::catalog;
    let f = Fixture::new();
    let token = scan_config(&f, distinct_zip_config(&f, 65));
    let (ch, rx) = channel();
    let task =
        tauri::async_runtime::block_on(batch(&f.state, token, (0..65).collect(), ch)).unwrap();
    let events = wait_media(&rx);
    assert!(events.iter().all(|e| e["type"] != "failed"), "{events:?}");
    let ready: Vec<annotator_core::model::MediaDescriptor> = events
        .iter()
        .filter(|e| e["type"] == "ready")
        .map(|e| serde_json::from_value(e["media"].clone()).unwrap())
        .collect();
    assert_eq!(ready.len(), 65);
    let before = f.expected();
    let mut forged = ready.clone();
    forged[1].display_name = "forged".into();
    assert!(tauri::async_runtime::block_on(catalog::import_batch(
        &f.state,
        before.clone(),
        forged
    ))
    .is_err());
    let first = tauri::async_runtime::block_on(catalog::import_batch(
        &f.state,
        before.clone(),
        ready.clone(),
    ))
    .unwrap();
    assert_eq!(first.document.media.len(), 65);
    assert_eq!(first.document.revision, before.expected_revision + 1);
    let retry =
        tauri::async_runtime::block_on(catalog::import_batch(&f.state, before, ready.clone()))
            .unwrap();
    assert_eq!(retry.document, first.document);
    for media in ready {
        catalog::release(&f.state.6, &task, &media.id).unwrap();
    }
}

fn distinct_zip_config(f: &Fixture, count: usize) -> Config {
    let mut config = zip_config(f, count);
    config.organization.mode = import_source::OrganizationMode::SourcePath;
    config
}
fn publish_batch(f: &Fixture, token: &Token, indices: Vec<usize>) -> Vec<String> {
    let (ch, rx) = channel();
    let task = tauri::async_runtime::block_on(batch(&f.state, token.clone(), indices, ch)).unwrap();
    let events = wait_media(&rx);
    assert!(events.iter().all(|e| e["type"] != "failed"), "{events:?}");
    let media = events
        .iter()
        .filter(|e| e["type"] == "ready")
        .map(|e| {
            serde_json::from_value::<annotator_core::model::MediaDescriptor>(e["media"].clone())
                .unwrap()
        })
        .collect::<Vec<_>>();
    tauri::async_runtime::block_on(crate::commands::collaboration::catalog::import_batch(
        &f.state,
        f.expected(),
        media.clone(),
    ))
    .unwrap();
    for m in &media {
        crate::commands::collaboration::catalog::release(&f.state.6, &task, &m.id).unwrap();
    }
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while f.state.6.prepared_count.load(Ordering::Acquire) != 0 && std::time::Instant::now() < until
    {
        std::thread::yield_now();
    }
    assert_eq!(f.state.6.prepared_count.load(Ordering::Acquire), 0);
    media.into_iter().map(|m| m.id).collect()
}
#[test]
fn repeated_zip_rescans_only_unpublished_destinations() {
    let f = Fixture::new();
    let config = distinct_zip_config(&f, 100);
    let first = scan_config(&f, config.clone());
    assert_eq!(
        page(&f.state, &first, 0, 50).unwrap().counts.candidates,
        100
    );
    publish_batch(&f, &first, (0..60).collect());
    cancel(&f.state, &first, true).unwrap();
    let second = scan_config(&f, config.clone());
    let counts = page(&f.state, &second, 0, 50).unwrap().counts;
    assert_eq!(
        (counts.candidates, counts.skipped, counts.duplicate_skipped),
        (40, 60, 60)
    );
    publish_batch(&f, &second, (0..40).collect());
    cancel(&f.state, &second, true).unwrap();
    let third = scan_config(&f, config);
    let counts = page(&f.state, &third, 0, 50).unwrap().counts;
    assert_eq!(
        (counts.candidates, counts.skipped, counts.duplicate_skipped),
        (0, 100, 100)
    );
    assert_eq!(
        f.state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document
            .media
            .len(),
        100
    );
}
fn apply_folder(
    f: &Fixture,
    operation: annotator_core::collaboration::organization::OrganizationOperation,
) {
    let e = f.expected();
    let repo = f.state.6.current.lock().unwrap().repo.clone().unwrap();
    let revision = repo.read_organization().unwrap().revision;
    tauri::async_runtime::block_on(crate::commands::organization::apply(
        &f.state,
        crate::commands::organization::Binding {
            runtime_nonce: e.runtime_nonce,
            project_id: e.project_id,
        },
        revision,
        operation,
    ))
    .unwrap();
}
fn recycle(f: &Fixture, ids: Vec<String>) {
    let repo = f.state.6.current.lock().unwrap().repo.clone().unwrap();
    let actor = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .workspace()
        .unwrap()
        .author_session()
        .unwrap();
    repo.apply_recycle_controlled(
        &actor,
        repo.read_recycle().unwrap().revision,
        annotator_core::collaboration::recycle::RecycleOperation {
            operation_id: uuid::Uuid::new_v4().to_string(),
            media_ids: ids,
            trash: true,
        },
        &AtomicBool::new(false),
        || Ok(()),
    )
    .unwrap();
}
#[test]
fn repeated_zip_default_skips_existing_and_hidden_but_other_target_is_free() {
    use annotator_core::collaboration::organization::OrganizationOperation;
    let f = Fixture::new();
    let config = zip_config(&f, 1);
    let first = scan_config(&f, config.clone());
    let ids = publish_batch(&f, &first, vec![0]);
    cancel(&f.state, &first, true).unwrap();
    f.state
        .0
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .workspace_mut()
        .unwrap()
        .set_media_hidden(&ids[0], true)
        .unwrap();
    let again = scan_config(&f, config.clone());
    let counts = page(&f.state, &again, 0, 50).unwrap().counts;
    assert_eq!((counts.candidates, counts.duplicate_skipped), (0, 1));
    cancel(&f.state, &again, true).unwrap();
    let target = uuid::Uuid::new_v4().to_string();
    apply_folder(
        &f,
        OrganizationOperation::CreateFolder {
            id: target.clone(),
            parent_id: None,
            name: "other".into(),
        },
    );
    let mut elsewhere = config;
    elsewhere.organization.target_folder_id = Some(target);
    let again = scan_config(&f, elsewhere);
    assert_eq!(page(&f.state, &again, 0, 50).unwrap().counts.candidates, 1);
}
#[test]
fn historical_duplicate_paths_remain_occupied_until_all_records_recycled() {
    let f = Fixture::new();
    let mut config = zip_config(&f, 2);
    config.rules.skip_duplicates = false;
    let first = scan_config(&f, config.clone());
    let ids = publish_batch(&f, &first, vec![0, 1]);
    cancel(&f.state, &first, true).unwrap();
    recycle(&f, vec![ids[0].clone()]);
    config.rules.skip_duplicates = true;
    let second = scan_config(&f, config.clone());
    assert_eq!(
        page(&f.state, &second, 0, 50)
            .unwrap()
            .counts
            .duplicate_skipped,
        2
    );
    cancel(&f.state, &second, true).unwrap();
    recycle(&f, vec![ids[1].clone()]);
    let third = scan_config(&f, config);
    let counts = page(&f.state, &third, 0, 50).unwrap().counts;
    assert_eq!((counts.candidates, counts.duplicate_skipped), (1, 1));
}
#[test]
fn recycled_exact_folder_sources_only_excluded_when_duplicate_policy_is_disabled() {
    let f = Fixture::new();
    let first = f.scan();
    let ids = publish_batch(&f, &first, vec![0]);
    cancel(&f.state, &first, true).unwrap();
    recycle(&f, ids);
    for skip_duplicates in [true, false] {
        let mut config = f.config();
        config.paths = vec![f.root.join("project/media").to_string_lossy().into()];
        config.rules.skip_duplicates = skip_duplicates;
        let token = scan_config(&f, config);
        let counts = page(&f.state, &token, 0, 50).unwrap().counts;
        assert_eq!(counts.candidates, if skip_duplicates { 1 } else { 0 });
        assert_eq!(counts.duplicate_skipped, 0);
        cancel(&f.state, &token, true).unwrap();
    }
}

// Publish through another valid native repository operation without adopting it
// into the local editor, so duplicate checks must read shared authority.
fn publish_external(f: &Fixture, candidate: &Candidate) -> String {
    let repo = f
        .state
        .6
        .current
        .lock()
        .unwrap()
        .repo
        .clone()
        .unwrap()
        .reload_catalog()
        .unwrap();
    let actor = f
        .state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .workspace()
        .unwrap()
        .author_session()
        .unwrap();
    let capture = repo.capture_loaded_media_placement(None).unwrap();
    let plan = capture
        .seal(
            candidate.resulting_folder_path.clone(),
            candidate.original_filename.clone(),
        )
        .unwrap();
    let prepared = repo
        .prepare_media_with_placement(
            &f.root.join("audio/CH1.wav"),
            &f.root.join("external-pcm"),
            &AtomicBool::new(false),
            plan,
            |_, _| {},
        )
        .unwrap();
    repo.append_media(&actor, &prepared, &AtomicBool::new(false))
        .unwrap()
        .id
}
#[test]
fn new_shared_occupancy_rejects_batch_before_task_or_ready() {
    let f = Fixture::new();
    let token = scan_config(&f, distinct_zip_config(&f, 3));
    publish_batch(&f, &token, vec![0]);
    let candidate = page(&f.state, &token, 1, 1).unwrap().candidates.remove(0);
    publish_external(&f, &candidate);
    let (ch, rx) = channel();
    let error = tauri::async_runtime::block_on(batch(&f.state, token, vec![1, 2], ch)).unwrap_err();
    assert_eq!(
        error.code,
        annotator_core::error::ErrorCode::RevisionConflict
    );
    assert!(!error.retryable);
    assert_eq!(error.message, "项目音频已变化，请重新扫描");
    assert_eq!(
        error.details,
        Some(serde_json::json!({"sourceImportRescanRequired": true}))
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(f.state.6.prepared_count.load(Ordering::Acquire), 0);
    let count = f
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
        .len();
    assert_eq!(
        count, 1,
        "the earlier published batch remains in the local editor"
    );
    let mut tasks = f.state.1.lock().unwrap();
    tasks.begin("probe-no-task".into()).unwrap();
    tasks.finish("probe-no-task");
}
#[test]
fn batch_recheck_ignores_prior_successful_indices_and_recycled_new_occupancy() {
    let f = Fixture::new();
    let token = scan_config(&f, distinct_zip_config(&f, 3));
    publish_batch(&f, &token, vec![0]);
    let candidate = page(&f.state, &token, 1, 1).unwrap().candidates.remove(0);
    let id = publish_external(&f, &candidate);
    recycle(&f, vec![id]);
    publish_batch(&f, &token, vec![1, 2]);
    let count = f
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
        .len();
    // Catalog descriptors include the external recycled record as well as our three imports.
    assert_eq!(count, 4);
}
#[test]
fn disabled_policy_does_not_read_recycle_or_recheck_new_occupancy() {
    let f = Fixture::new();
    let mut config = zip_config(&f, 1);
    config.rules.skip_duplicates = false;
    fs::write(f.root.join("project/recycle.json"), b"invalid").unwrap();
    let token = scan_config(&f, config);
    let candidate = page(&f.state, &token, 0, 1).unwrap().candidates.remove(0);
    publish_external(&f, &candidate);
    let (ch, rx) = channel();
    let task = tauri::async_runtime::block_on(batch(&f.state, token, vec![0], ch)).unwrap();
    let events = wait_media(&rx);
    assert!(events.iter().any(|e| e["type"] == "ready"), "{events:?}");
    for e in events.iter().filter(|e| e["type"] == "ready") {
        crate::commands::collaboration::catalog::release(
            &f.state.6,
            &task,
            e["media"]["id"].as_str().unwrap(),
        )
        .unwrap();
    }
}
#[test]
fn corrupt_shared_authority_never_creates_scan_result_or_batch_task() {
    for (name, directory) in [
        ("recycle.json", false),
        ("organization.json", false),
        ("recycle.json", true),
        ("organization.json", true),
    ] {
        let f = Fixture::new();
        let config = zip_config(&f, 1);
        let token = scan_config(&f, config.clone());
        let path = f.root.join("project").join(name);
        if directory {
            if path.exists() {
                fs::remove_file(&path).unwrap();
            }
            fs::create_dir(&path).unwrap();
        } else {
            fs::write(&path, b"invalid").unwrap();
        }
        let (ch, rx) = channel();
        assert!(
            tauri::async_runtime::block_on(batch(&f.state, token.clone(), vec![0], ch)).is_err()
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(f.state.6.prepared_count.load(Ordering::Acquire), 0);
        cancel(&f.state, &token, true).unwrap();
        let e = f.expected();
        let (ch, rx) = channel();
        let token = tauri::async_runtime::block_on(start(
            &f.state,
            e.runtime_nonce,
            e.project_id,
            config,
            ch,
        ))
        .unwrap();
        loop {
            let event = rx.recv_timeout(Duration::from_secs(20)).unwrap();
            if event["type"] == "progress" {
                continue;
            }
            assert_eq!(event["type"], "failed", "{event}");
            break;
        }
        assert!(f.state.6.sources.lock().unwrap().result(&token).is_err());
    }
}

#[test]
fn repeated_original_folder_paths_use_destination_dedup_only_when_enabled() {
    let f = Fixture::new();
    let first = f.scan();
    publish_batch(&f, &first, vec![0]);
    cancel(&f.state, &first, true).unwrap();
    for skip_duplicates in [true, false] {
        let mut config = f.config();
        config.rules.skip_duplicates = skip_duplicates;
        let token = scan_config(&f, config);
        let counts = page(&f.state, &token, 0, 50).unwrap().counts;
        assert_eq!(
            (counts.candidates, counts.duplicate_skipped),
            if skip_duplicates { (0, 1) } else { (1, 0) }
        );
        cancel(&f.state, &token, true).unwrap();
    }
}
