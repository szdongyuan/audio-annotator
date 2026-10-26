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
    assert_eq!(page(&f.state, &token, 0, 256).unwrap().candidates.len(), 1);
    assert!(page(&f.state, &token, 0, 257).is_err());
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
    let token = scan_config(&f, zip_config(&f, 257));
    assert_eq!(
        page(&f.state, &token, 0, 256).unwrap().candidates.len(),
        256
    );
    assert_eq!(
        page(&f.state, &token, 256, 256).unwrap().candidates[0].index,
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
        paths: vec![f.root.join("project/media").to_string_lossy().into()],
        ..f.config()
    };
    let token = scan_config(&f, config);
    let page = page(&f.state, &token, 0, 256).unwrap();
    assert!(page.candidates.is_empty());
    assert_eq!(page.counts.skipped, 1);
    cancel(&f.state, &token, true).unwrap();
    let original = f.scan();
    assert_eq!(
        super::page(&f.state, &original, 0, 1)
            .unwrap()
            .candidates
            .len(),
        1
    );
    cancel(&f.state, &original, true).unwrap();
    let zip = scan_config(&f, zip_config(&f, 2));
    assert_eq!(
        super::page(&f.state, &zip, 0, 256)
            .unwrap()
            .candidates
            .len(),
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
