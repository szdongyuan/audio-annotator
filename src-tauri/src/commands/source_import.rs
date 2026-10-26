//! Native-owned preview capabilities; never accept extraction paths from the webview.
use super::collaboration::runtime;
use crate::state::AppState;
use annotator_core::{
    error::{AppError, Result},
    media::import_source::{self, Candidate, Config, Counts, Issue, Limits, ScanResult},
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{ipc::Channel, State};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Token {
    pub runtime_nonce: String,
    pub project_id: String,
    pub task_id: String,
}
#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScanEvent {
    Progress { token: Token, counts: Counts },
    Result { token: Token, counts: Counts },
    Failed { token: Token, error: AppError },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub candidates: Vec<Candidate>,
    pub issues: Vec<Issue>,
    pub counts: Counts,
}
struct Entry {
    token: Token,
    cancel: Arc<AtomicBool>,
    result: Option<Arc<ScanResult>>,
}
#[derive(Default)]
pub struct Registry {
    entry: Option<Entry>,
}
impl Registry {
    pub fn reset(&mut self) {
        if let Some(e) = self.entry.take() {
            e.cancel.store(true, Ordering::Relaxed);
        }
    }
    pub fn active(&self) -> bool {
        self.entry.is_some()
    }
    fn get(&self, token: &Token) -> Result<&Entry> {
        self.entry
            .as_ref()
            .filter(|e| e.token == *token)
            .ok_or_else(runtime::stale)
    }
    pub(crate) fn result(&self, token: &Token) -> Result<Arc<ScanResult>> {
        let e = self.get(token)?;
        annotator_core::media::identity::check_cancel(&e.cancel)?;
        e.result
            .clone()
            .ok_or_else(|| AppError::invalid("扫描尚未完成"))
    }
}
fn authority(state: &AppState, token: &Token) -> Result<()> {
    let p = state.0.lock().map_err(|_| runtime::unavailable())?;
    check(
        p.as_ref().ok_or_else(runtime::stale)?,
        &state.6,
        &token.runtime_nonce,
        &token.project_id,
    )
}
fn check(
    p: &annotator_core::project::LocalProject,
    service: &runtime::Service,
    nonce: &str,
    project: &str,
) -> Result<()> {
    runtime::check_mutation(p, service, Some(nonce))?;
    if p.snapshot()?.document.project_id != project {
        return Err(runtime::stale());
    }
    if !p.is_shared() || !super::collaboration::catalog::can_import(p) {
        return Err(AppError::invalid(
            "可配置导入需要可写的格式 2 项目；旧项目仍可直接导入音频",
        ));
    }
    Ok(())
}
pub(crate) async fn start(
    state: &AppState,
    runtime_nonce: String,
    project_id: String,
    config: Config,
    on_event: Channel<ScanEvent>,
) -> Result<Token> {
    config.validate()?;
    let token = Token {
        runtime_nonce,
        project_id,
        task_id: uuid::Uuid::new_v4().to_string(),
    };
    let s = state.clone();
    let t = token.clone();
    let (cancel, existing) = state
        .run(move |p| {
            check(
                p.as_ref().ok_or_else(runtime::stale)?,
                &s.6,
                &t.runtime_nonce,
                &t.project_id,
            )?;
            let project = p.as_ref().ok_or_else(runtime::stale)?;
            let existing = project
                .snapshot()?
                .document
                .media
                .into_iter()
                .map(|m| project.root().join(m.source_ref))
                .collect::<Vec<_>>();
            let mut registry = s.6.sources.lock().map_err(|_| runtime::unavailable())?;
            if registry.active() {
                return Err(AppError::invalid("请先关闭当前导入预览"));
            }
            // Probe the same admission used by direct imports, and retain it during scanning.
            let (_, cancel) =
                s.1.lock()
                    .map_err(|_| runtime::unavailable())?
                    .begin(t.task_id.clone())?;
            registry.entry = Some(Entry {
                token: t,
                cancel: cancel.clone(),
                result: None,
            });
            Ok((cancel, existing))
        })
        .await?;
    let s = state.clone();
    let t = token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(test)]
        s.6.run_hook();
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let existing = existing
            .into_iter()
            .take_while(|_| {
                config.kind == import_source::SourceKind::Folder && !cancel.load(Ordering::Relaxed)
            })
            .filter_map(|p| p.canonicalize().ok())
            .collect::<Vec<_>>();
        let result = import_source::scan(&config, &cancel, Limits::default(), |counts| {
            if last.elapsed() < std::time::Duration::from_millis(100) {
                return;
            }
            last = std::time::Instant::now();
            if on_event
                .send(ScanEvent::Progress {
                    token: t.clone(),
                    counts: counts.clone(),
                })
                .is_err()
            {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        let result = result.map(|mut result| {
            result.exclude_folder_paths(&existing);
            result
        });
        // Recheck runtime authority after filesystem work; no project lock during traversal.
        let event = (|| -> Result<ScanEvent> {
            authority(&s, &t)?;
            let mut registry = s.6.sources.lock().map_err(|_| runtime::unavailable())?;
            let entry = registry
                .entry
                .as_mut()
                .filter(|e| e.token == t)
                .ok_or_else(runtime::stale)?;
            let result = result.and_then(|r| {
                annotator_core::media::identity::check_cancel(&cancel)?;
                Ok(r)
            });
            Ok(match result {
                Ok(r) => {
                    let counts = r.counts.clone();
                    entry.result = Some(Arc::new(r));
                    ScanEvent::Result {
                        token: t.clone(),
                        counts,
                    }
                }
                Err(error) => ScanEvent::Failed {
                    token: t.clone(),
                    error,
                },
            })
        })();
        if let Ok(mut media) = s.1.lock() {
            media.finish(&t.task_id);
        }
        if let Ok(event) = event {
            if on_event.send(event).is_err() {
                if let Ok(mut r) = s.6.sources.lock() {
                    if r.get(&t).is_ok() {
                        r.reset();
                    }
                }
            }
        }
    });
    Ok(token)
}
pub(crate) fn page(state: &AppState, token: &Token, offset: usize, limit: usize) -> Result<Page> {
    authority(state, token)?;
    let r = state
        .6
        .sources
        .lock()
        .map_err(|_| runtime::unavailable())?
        .result(token)?;
    Ok(Page {
        candidates: r.page(offset, limit)?.to_vec(),
        issues: r.issues.clone(),
        counts: r.counts.clone(),
    })
}
pub(crate) fn cancel(state: &AppState, token: &Token, release: bool) -> Result<()> {
    authority(state, token)?;
    let mut r = state.6.sources.lock().map_err(|_| runtime::unavailable())?;
    if release && r.get(token).is_err() {
        return Ok(());
    }
    r.get(token)?.cancel.store(true, Ordering::Relaxed);
    if release {
        r.reset();
    }
    Ok(())
}
#[tauri::command]
pub async fn scan_import_sources(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    config: Config,
    on_event: Channel<ScanEvent>,
) -> Result<Token> {
    start(&state, runtime_nonce, project_id, config, on_event).await
}
#[tauri::command]
pub fn import_source_page(
    state: State<'_, AppState>,
    token: Token,
    offset: usize,
    limit: usize,
) -> Result<Page> {
    page(&state, &token, offset, limit)
}
#[tauri::command]
pub fn cancel_import_source_scan(state: State<'_, AppState>, token: Token) -> Result<()> {
    cancel(&state, &token, false)
}
#[tauri::command]
pub fn release_import_source_scan(state: State<'_, AppState>, token: Token) -> Result<()> {
    cancel(&state, &token, true)
}
#[tauri::command]
pub async fn import_source_batch(
    state: State<'_, AppState>,
    token: Token,
    indices: Vec<usize>,
    on_event: Channel<super::media::MediaEvent>,
) -> Result<String> {
    batch(&state, token, indices, on_event).await
}
pub(crate) async fn batch(
    state: &AppState,
    token: Token,
    indices: Vec<usize>,
    on_event: Channel<super::media::MediaEvent>,
) -> Result<String> {
    super::media::start_sources(state, token, indices, on_event).await
}
#[cfg(test)]
mod tests;
