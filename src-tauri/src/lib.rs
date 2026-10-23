mod commands;
#[cfg(feature = "e2e")]
mod e2e;
mod state;
use tauri::{Emitter, Manager};

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(e2e::plugin());
    #[cfg(not(feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    builder
        .manage(state::AppState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<state::AppState>();
                // Prevent native destruction even if the frontend is still submitting edits.
                let occupied = state.0.try_lock().map(|s| s.is_some()).unwrap_or(true);
                if occupied {
                    api.prevent_close();
                    let _ = window.emit("project-close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project,
            commands::project::open_project,
            commands::project::resolve_recovery,
            commands::project::get_project_snapshot,
            commands::project::apply_change,
            commands::project::undo,
            commands::project::redo,
            commands::project::save_project,
            commands::project::save_project_as,
            commands::project::close_project,
            commands::exchange::export_annotations,
            commands::exchange::export_bundle,
            commands::exchange::import_exchange,
            commands::exchange::cancel_exchange,
            commands::media::import_media,
            commands::folders::scan_folder,
            commands::folders::folder_scan_page,
            commands::folders::cancel_folder_scan,
            commands::folders::release_folder_scan,
            commands::media::relink_media,
            commands::media::cancel_media_import,
            commands::media::release_media_import,
            commands::media::media_status,
            commands::analysis::request_tile,
            commands::analysis::register_analysis_view,
            commands::analysis::retire_analysis_view,
            commands::analysis::cancel_generation,
            commands::playback::playback_devices,
            commands::playback::playback_configure,
            commands::playback::playback_control,
            commands::playback::playback_status,
        ])
        .run(tauri::generate_context!())
        .expect("启动音频标注桌面应用失败");
}
