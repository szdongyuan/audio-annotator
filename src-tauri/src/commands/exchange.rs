use crate::{
    commands::project::{info_shared, OpenProject},
    state::AppState,
};
use annotator_core::{
    error::{AppError, ErrorCode, Result},
    exchange::{self, Limits},
    media::identity::check_cancel,
    project::LocalProject,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};
#[derive(Default)]
pub struct ExchangeTasks {
    current: Option<(String, Arc<AtomicBool>)>,
}
impl ExchangeTasks {
    fn begin(&mut self) -> Result<(String, Arc<AtomicBool>)> {
        self.begin_with(Arc::new(AtomicBool::new(false)))
    }
    fn begin_with(&mut self, cancel: Arc<AtomicBool>) -> Result<(String, Arc<AtomicBool>)> {
        if self.current.is_some() {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "请等待交换任务结束",
            ));
        }
        let task = (uuid::Uuid::new_v4().to_string(), cancel);
        self.current = Some(task.clone());
        Ok(task)
    }
    fn finish(&mut self, id: &str) {
        if self.current.as_ref().is_some_and(|(task, _)| task == id) {
            self.current = None;
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedProject {
    project_id: String,
    expected_revision: u64,
    #[serde(default)]
    runtime_nonce: Option<String>,
}
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExchangeEvent {
    Progress {
        task_id: String,
        phase: String,
        completed: u64,
    },
    SourcesRequired {
        task_id: String,
        source_sha256: String,
        media: Vec<super::collaboration::exchange_default::RequiredMedia>,
    },
    Completed {
        task_id: String,
        path: String,
        opened: Option<Box<OpenProject>>,
    },
    Cancelled {
        task_id: String,
    },
    Failed {
        task_id: String,
        error: AppError,
    },
}
fn check_current(
    state: &Option<LocalProject>,
    expected: &Option<ExpectedProject>,
    saved: bool,
) -> Result<()> {
    match (state, expected) {
        (None, None) => Ok(()),
        (Some(p), Some(e)) => {
            let d = p.snapshot()?.document;
            if d.project_id != e.project_id || d.revision != e.expected_revision {
                return Err(AppError::new(
                    ErrorCode::RevisionConflict,
                    "交换期间项目已改变",
                ));
            }
            if saved && p.persisted_revision() != d.revision {
                return Err(AppError::new(ErrorCode::SaveFailed, "请先保存当前项目"));
            }
            Ok(())
        }
        _ => Err(AppError::new(
            ErrorCode::RevisionConflict,
            "当前项目身份已改变",
        )),
    }
}
fn begin(state: &AppState) -> Result<(String, Arc<AtomicBool>)> {
    state
        .4
        .lock()
        .map_err(|_| AppError::invalid("交换服务不可用"))?
        .begin()
}
fn finish(
    state: &AppState,
    id: &str,
    result: Result<(String, Option<OpenProject>)>,
    channel: &Channel<ExchangeEvent>,
) {
    if let Ok(mut tasks) = state.4.lock() {
        tasks.finish(id);
    }
    let event = match result {
        Ok((path, opened)) => ExchangeEvent::Completed {
            task_id: id.into(),
            path,
            opened: opened.map(Box::new),
        },
        Err(e) if e.code == ErrorCode::Cancelled => ExchangeEvent::Cancelled { task_id: id.into() },
        Err(error) => ExchangeEvent::Failed {
            task_id: id.into(),
            error,
        },
    };
    let _ = channel.send(event);
}
async fn export(
    state: &AppState,
    expected: ExpectedProject,
    path: String,
    bundle: bool,
    on_event: Channel<ExchangeEvent>,
) -> Result<String> {
    let service = state.6.clone();
    let capture = state
        .run(move |s| {
            if let Some(p) = s.as_ref() {
                super::collaboration::runtime::check_mutation(
                    p,
                    &service,
                    expected.runtime_nonce.as_deref(),
                )?;
            }
            check_current(s, &Some(expected), false)?;
            let p = s.as_ref().unwrap();
            let mut document = p.export_document()?;
            // PortableMedia whitelists exported fields and never serializes source_ref.
            // Keep validated private relinks only for internal bundle-byte resolution.
            if p.is_shared() && bundle {
                let private = p.snapshot()?.document;
                for media in &mut document.media {
                    if let Some(source) = private.media.iter().find(|m| m.id == media.id) {
                        media.source_ref = source.source_ref.clone();
                    }
                }
            }
            Ok((document, p.root().to_path_buf()))
        })
        .await?;
    let (id, cancel) = begin(state)?;
    let worker_id = id.clone();
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = Instant::now() - Duration::from_secs(1);
        let progress = |phase: &str, completed: u64| {
            if last.elapsed() >= Duration::from_millis(100) {
                last = Instant::now();
                if on_event
                    .send(ExchangeEvent::Progress {
                        task_id: worker_id.clone(),
                        phase: phase.into(),
                        completed,
                    })
                    .is_err()
                {
                    cancel.store(true, Ordering::Relaxed);
                }
            }
        };
        let result = if bundle {
            exchange::export_bundle(
                &capture.0,
                &capture.1,
                Path::new(&path),
                &cancel,
                Limits::default(),
                progress,
            )
        } else {
            exchange::export_annotations(
                &capture.0,
                Path::new(&path),
                &cancel,
                Limits::default(),
                progress,
            )
        };
        finish(&state, &worker_id, result.map(|_| (path, None)), &on_event);
    });
    Ok(id)
}
#[tauri::command]
pub async fn export_annotations(
    state: State<'_, AppState>,
    expected: ExpectedProject,
    path: String,
    on_event: Channel<ExchangeEvent>,
) -> Result<String> {
    export(&state, expected, path, false, on_event).await
}
#[tauri::command]
pub async fn export_bundle(
    state: State<'_, AppState>,
    expected: ExpectedProject,
    path: String,
    on_event: Channel<ExchangeEvent>,
) -> Result<String> {
    export(&state, expected, path, true, on_event).await
}
#[tauri::command]
pub fn import_exchange(
    state: State<'_, AppState>,
    expected: Option<ExpectedProject>,
    source: String,
    parent: String,
    bindings: Option<super::collaboration::exchange_default::SourceBindings>,
    on_event: Channel<ExchangeEvent>,
) -> Result<String> {
    let permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    let (id, cancel) = state
        .4
        .lock()
        .map_err(|_| AppError::invalid("Exchange unavailable"))?
        .begin_with(permit.cancel.clone())?;
    let worker_id = id.clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            // Capture only authority under the global mutex; archive/NAS I/O is outside it.
            let nonce = {
                let current = state
                    .0
                    .lock()
                    .map_err(|_| AppError::invalid("项目服务不可用"))?;
                check_current(&current, &expected, true)?;
                if let Some(p) = current.as_ref() {
                    super::collaboration::runtime::check_mutation(
                        p,
                        &state.6,
                        expected.as_ref().and_then(|e| e.runtime_nonce.as_deref()),
                    )?;
                }
                state
                    .6
                    .current
                    .lock()
                    .map_err(|_| super::collaboration::runtime::unavailable())?
                    .nonce
                    .clone()
            };
            check_cancel(&cancel)?;
            let mut last = Instant::now() - Duration::from_secs(1);
            let imported = super::collaboration::exchange_default::prepare(
                Path::new(&source),
                Path::new(&parent),
                &state.6.local()?,
                bindings,
                &cancel,
                |phase, completed| {
                    if last.elapsed() >= Duration::from_millis(100) {
                        last = Instant::now();
                        if on_event
                            .send(ExchangeEvent::Progress {
                                task_id: worker_id.clone(),
                                phase: phase.into(),
                                completed,
                            })
                            .is_err()
                        {
                            cancel.store(true, Ordering::Relaxed);
                        }
                    }
                },
            )?;
            let prepared = match imported {
                super::collaboration::exchange_default::PreparedImport::SourcesRequired {
                    source_sha256,
                    media,
                } => {
                    state
                        .4
                        .lock()
                        .map_err(|_| AppError::invalid("Exchange unavailable"))?
                        .finish(&worker_id);
                    let _ = on_event.send(ExchangeEvent::SourcesRequired {
                        task_id: worker_id.clone(),
                        source_sha256,
                        media,
                    });
                    return Ok(None);
                }
                super::collaboration::exchange_default::PreparedImport::Ready(prepared) => prepared,
            };
            let mut current = state
                .0
                .lock()
                .map_err(|_| AppError::invalid("项目服务不可用"))?;
            check_current(&current, &expected, true)?;
            check_cancel(&cancel)?;
            if state
                .6
                .current
                .lock()
                .map_err(|_| super::collaboration::runtime::unavailable())?
                .nonce
                != nonce
            {
                return Err(super::collaboration::runtime::stale());
            }
            check_cancel(&permit.cancel)?;
            super::collaboration::reset_resources(&state)?;
            let (new, repo) = prepared.commit();
            let path = new.root().to_string_lossy().into_owned();
            state.6.install(Some(repo))?;
            let opened = info_shared(&new, &state.6)?;
            *current = Some(new);
            Ok(Some((path, Some(opened))))
        })();
        drop(permit);
        match result {
            Ok(None) => (),
            Ok(Some(completed)) => finish(&state, &worker_id, Ok(completed), &on_event),
            Err(error) => finish(&state, &worker_id, Err(error), &on_event),
        }
    });
    Ok(id)
}
#[tauri::command]
pub fn cancel_exchange(state: State<'_, AppState>, task_id: String) -> Result<()> {
    let tasks = state
        .4
        .lock()
        .map_err(|_| AppError::invalid("交换服务不可用"))?;
    if let Some((id, cancel)) = &tasks.current {
        if id == &task_id {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authority_requires_saved_current_identity_and_revision() {
        let root = std::env::temp_dir().join(format!("exchange-host-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let p = LocalProject::create(&root, "existing".into()).unwrap();
        let d = p.snapshot().unwrap().document;
        let mut current = Some(p);
        let expected = Some(ExpectedProject {
            runtime_nonce: None,
            project_id: d.project_id.clone(),
            expected_revision: d.revision,
        });
        check_current(&current, &expected, true).unwrap();
        assert!(check_current(&current, &None, true).is_err());
        let category = annotator_core::model::Category {
            id: uuid::Uuid::new_v4().to_string(),
            name: "test".into(),
            color: "#aabbcc".into(),
        };
        current
            .as_mut()
            .unwrap()
            .session_mut()
            .unwrap()
            .apply_change(
                &d.project_id,
                d.revision,
                annotator_core::model::Change::AddCategory { category },
            )
            .unwrap();
        assert_eq!(
            check_current(&current, &expected, true).unwrap_err().code,
            ErrorCode::RevisionConflict
        );
        let next = Some(ExpectedProject {
            runtime_nonce: None,
            project_id: d.project_id,
            expected_revision: d.revision + 1,
        });
        assert_eq!(
            check_current(&current, &next, true).unwrap_err().code,
            ErrorCode::SaveFailed
        );
        drop(current);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn task_cancellation_is_independent_and_single_terminal_slot() {
        let mut tasks = ExchangeTasks::default();
        let (id, cancel) = tasks.begin().unwrap();
        assert!(tasks.begin().is_err());
        cancel.store(true, Ordering::Relaxed);
        assert!(check_cancel(&cancel).is_err());
        tasks.finish("stale");
        assert!(tasks.begin().is_err());
        tasks.finish(&id);
        assert!(tasks.begin().is_ok());
    }
}
