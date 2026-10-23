use annotator_core::{
    error::{AppError, Result},
    media::registry::MediaTasks,
    project::LocalProject,
};
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
pub struct AppState(
    pub Arc<Mutex<Option<LocalProject>>>,
    pub Arc<Mutex<MediaTasks>>,
    pub Arc<crate::commands::analysis::AnalysisRuntime>,
    pub Arc<crate::commands::playback::PlaybackRuntime>,
    pub Arc<Mutex<crate::commands::exchange::ExchangeTasks>>,
    pub Arc<Mutex<annotator_core::media::folder_scan::FolderTasks>>,
);
impl AppState {
    /// File I/O stays off the webview thread; the mutex serializes authority changes.
    pub async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Option<LocalProject>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let state = self.0.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut state = state
                .lock()
                .map_err(|_| AppError::invalid("项目服务不可用"))?;
            f(&mut state)
        })
        .await
        .map_err(|_| AppError::invalid("项目任务中断"))?
    }
}
