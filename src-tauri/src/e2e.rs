//! Test-only native boundaries, absent from builds without the e2e feature.
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, TryLockError,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
struct Paths(Mutex<BTreeMap<String, VecDeque<Value>>>);
#[derive(Default)]
pub(crate) struct Responsiveness {
    active: Arc<AtomicBool>,
    held: Arc<AtomicBool>,
}
// Independent native timer guarantees release even if synchronous IPC blocks
// the window. No webview message is needed to release the project lock.
#[tauri::command]
pub(crate) async fn hold_project_lock(
    state: tauri::State<'_, crate::state::AppState>,
    probe: tauri::State<'_, Responsiveness>,
) -> Result<(), String> {
    if probe.active.swap(true, Ordering::AcqRel) {
        return Err("A responsiveness probe is already running".into());
    }
    let state = state.inner().clone();
    let active = probe.active.clone();
    let held = probe.held.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread_active = active.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("e2e-bounded-project-lock".into())
        .spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(500);
            loop {
                match state.0.try_lock() {
                    Ok(_guard) => {
                        held.store(true, Ordering::Release);
                        let _ = ready_tx.send(Ok(()));
                        std::thread::sleep(Duration::from_millis(1500));
                        held.store(false, Ordering::Release);
                        break;
                    }
                    Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    _ => {
                        let _ = ready_tx
                            .send(Err("Project lock unavailable for bounded probe".to_string()));
                        break;
                    }
                }
            }
            thread_active.store(false, Ordering::Release);
        })
    {
        active.store(false, Ordering::Release);
        return Err(error.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        ready_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|e| e.to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn native_heartbeat(
    app: tauri::AppHandle,
    probe: tauri::State<'_, Responsiveness>,
) -> Result<bool, String> {
    let held = probe.held.clone();
    let (send, receive) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = send.send(held.load(Ordering::Acquire));
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receive
            .recv_timeout(Duration::from_secs(3))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
// Deliberately reproduces the former sync command dispatch for the negative
// control; it shares the unchanged ownership/mutation implementation.
#[tauri::command]
pub(crate) fn synchronous_playback_probe(
    state: tauri::State<'_, crate::state::AppState>,
) -> annotator_core::error::Result<crate::commands::playback::PlaybackStatus> {
    crate::commands::playback::control_owned(&state, None, "reset")
}
// Applied before Tauri creates the window. WebView2's environment-only browser
// arguments are not reliable on every runtime; never accept arbitrary flags.
pub fn configure_debug_port(
    config: &mut tauri::utils::config::Config,
    value: Option<&str>,
) -> Result<(), String> {
    let port = value
        .unwrap_or("9235")
        .parse::<u16>()
        .map_err(|_| "Invalid e2e debug port".to_string())?;
    if port < 1024 {
        return Err("Invalid e2e debug port".into());
    }
    for window in &mut config.app.windows {
        window.additional_browser_args = Some(format!("--remote-debugging-port={port}"));
    }
    Ok(())
}
fn next(options: Value, paths: tauri::State<'_, Paths>) -> Result<Value, String> {
    let title = options.get("title").and_then(Value::as_str).unwrap_or("");
    paths
        .0
        .lock()
        .map_err(|_| "Picker lock poisoned")?
        .get_mut(title)
        .and_then(VecDeque::pop_front)
        .ok_or_else(|| format!("No preselected e2e picker path for {title}"))
}
#[tauri::command]
fn open(options: Value, paths: tauri::State<'_, Paths>) -> Result<Value, String> {
    next(options, paths)
}
#[tauri::command]
fn save(options: Value, paths: tauri::State<'_, Paths>) -> Result<Value, String> {
    next(options, paths)
}
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let paths: BTreeMap<String, VecDeque<Value>> =
        serde_json::from_str(&std::env::var("ANNOTATOR_E2E_PATHS").unwrap_or_else(|_| "{}".into()))
            .expect("ANNOTATOR_E2E_PATHS must map dialog titles to path queues");
    for queue in paths.values() {
        for value in queue {
            assert!(
                value.is_null()
                    || value.is_string()
                    || value
                        .as_array()
                        .is_some_and(|a| a.iter().all(Value::is_string)),
                "Only picker paths may be preselected"
            );
        }
    }
    tauri::plugin::Builder::new("dialog")
        .setup(move |app, _| {
            app.manage(Paths(Mutex::new(paths)));
            app.manage(Responsiveness::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open, save])
        .build()
}

#[cfg(test)]
mod tests {
    #[test]
    fn debug_port_uses_default_or_validated_instance_override() {
        let mut config = tauri::utils::config::Config::default();
        config.app.windows.push(Default::default());
        super::configure_debug_port(&mut config, None).unwrap();
        assert_eq!(
            config.app.windows[0].additional_browser_args.as_deref(),
            Some("--remote-debugging-port=9235")
        );
        super::configure_debug_port(&mut config, Some("9245")).unwrap();
        assert_eq!(
            config.app.windows[0].additional_browser_args.as_deref(),
            Some("--remote-debugging-port=9245")
        );
        for value in ["0", "1023", "65536", "12.5", "9245 --other-flag", ""] {
            assert!(super::configure_debug_port(&mut config, Some(value)).is_err());
            assert_eq!(
                config.app.windows[0].additional_browser_args.as_deref(),
                Some("--remote-debugging-port=9245")
            );
        }
    }
}
