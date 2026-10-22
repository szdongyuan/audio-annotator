//! Test-only native picker boundary, absent from ordinary/release builds.
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::Mutex,
};
use tauri::Manager;
struct Paths(Mutex<BTreeMap<String, VecDeque<Value>>>);
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open, save])
        .build()
}
