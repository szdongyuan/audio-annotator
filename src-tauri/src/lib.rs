mod commands;
#[cfg(feature = "e2e")]
mod e2e;
mod state;
use tauri::{Emitter, Manager};

pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(feature = "e2e")]
    let context = {
        let mut context = context;
        e2e::configure_debug_port(
            context.config_mut(),
            std::env::var("ANNOTATOR_E2E_DEBUG_PORT").ok().as_deref(),
        )
        .expect("Invalid e2e debug port");
        context
    };
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(e2e::plugin());
    #[cfg(not(feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    builder
        .manage(state::AppState::default())
        .setup(|app| {
            let local = app.path().app_local_data_dir()?;
            #[cfg(feature = "e2e")]
            let local = std::env::var_os("ANNOTATOR_E2E_LOCAL_DATA")
                .map(std::path::PathBuf::from)
                .unwrap_or(local);
            app.state::<state::AppState>()
                .6
                .set_local(local)
                .map_err(|e| std::io::Error::other(e.message))?;
            Ok(())
        })
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
            commands::collaboration::collaboration_status,
            commands::profiles::profile_list,
            commands::profiles::profile_create,
            commands::profiles::profile_rename,
            commands::profiles::profile_select,
            commands::profiles::profile_import,
            commands::profiles::profile_export,
            commands::collaboration::collaboration_create,
            commands::collaboration::collaboration_refresh,
            commands::collaboration::collaboration_sync,
            commands::collaboration::collaboration_cancel,
            commands::collaboration::collaboration_preferences,
            commands::collaboration::collaboration_load_shared,
            commands::project::create_project,
            commands::project::open_project,
            commands::collaboration::defaults::open_project_view_only,
            commands::collaboration::catalog::collaboration_adopt_catalog,
            commands::collaboration::catalog::collaboration_hide_media,
            commands::project::resolve_recovery,
            commands::project::get_project_snapshot,
            commands::project::apply_change,
            commands::project::undo,
            commands::project::redo,
            commands::project::save_project,
            commands::project::save_project_as,
            commands::project::save_project_as_controlled,
            commands::project::close_project,
            commands::exchange::export_path_preview,
            commands::exchange::export_annotations,
            commands::exchange::export_bundle,
            commands::exchange::import_exchange,
            commands::exchange::cancel_exchange,
            commands::media::import_media,
            commands::organization::organization_get,
            commands::recycle::recycle_get,
            commands::recycle::recycle_apply,
            commands::collaboration::catalog::collaboration_hide_media_batch,
            commands::organization::organization_apply,
            commands::source_import::scan_import_sources,
            commands::source_import::import_source_page,
            commands::source_import::cancel_import_source_scan,
            commands::source_import::release_import_source_scan,
            commands::source_import::import_source_batch,
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
            commands::playback::playback_monitor_gain,
        ])
        .run(context)
        .expect("启动音频标注桌面应用失败");
}
