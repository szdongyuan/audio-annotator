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
    preview: Option<(String, Arc<ExportCapture>)>,
    preview_epoch: u64,
}
impl ExchangeTasks {
    #[cfg(test)]
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
#[derive(Clone, PartialEq, Eq, Deserialize)]
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
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSelection {
    media_ids: Vec<String>,
    author_ids: Vec<String>,
    audio_only: bool,
}
struct ExportCapture {
    authors: Vec<exchange::PortableAuthor>,
    audio_only: bool,
    expected: ExpectedProject,
    runtime_nonce: String,
    document: annotator_core::model::ProjectDocument,
    root: std::path::PathBuf,
    repo: Option<Arc<annotator_core::collaboration::CollaborationRepository>>,
    organization_revision: Option<u64>,
    plan: exchange::ExportPathPlan,
    recycle_revision: Option<u64>,
    authority: Option<exchange::SharedSourceAuthority>,
}
impl ExportCapture {
    fn write(
        &self,
        target: &Path,
        cancel: &AtomicBool,
        progress: impl FnMut(&str, u64),
    ) -> Result<()> {
        // Build from the fixed accepted plan off-lock. Recheck exact authority
        // only at publication so ordinary shared work can continue during I/O.
        let before_publish = || self.authority.as_ref().map(|a| a.lock()).transpose();
        if self.plan.bundle {
            exchange::export_selected_controlled(
                &self.document,
                &self.plan,
                &self.root,
                target,
                cancel,
                Limits::default(),
                &self.authors,
                self.audio_only,
                progress,
                before_publish,
            )
        } else {
            exchange::export_annotations_controlled(
                &self.document,
                &self.plan,
                target,
                cancel,
                Limits::default(),
                progress,
                before_publish,
            )
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    token: String,
    runtime_nonce: String,
    project_id: String,
    document_revision: u64,
    organization_revision: Option<u64>,
    bundle: bool,
    preserve_folders: bool,
    directories: Vec<String>,
    media_paths: std::collections::BTreeMap<String, String>,
    changes: Vec<exchange::PathChange>,
}
fn check_capture(state: &AppState, expected: &ExpectedProject, nonce: &str) -> Result<()> {
    let current = state
        .0
        .lock()
        .map_err(|_| AppError::invalid("项目服务不可用"))?;
    let p = current
        .as_ref()
        .ok_or_else(super::collaboration::runtime::stale)?;
    super::collaboration::runtime::check_mutation(p, &state.6, expected.runtime_nonce.as_deref())?;
    check_current(&current, &Some(expected.clone()), false)?;
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
    Ok(())
}
#[cfg(test)]
pub(crate) async fn preview(
    state: &AppState,
    expected: ExpectedProject,
    bundle: bool,
    preserve_folders: bool,
) -> Result<ExportPreview> {
    preview_selected(state, expected, bundle, preserve_folders, None).await
}
async fn preview_selected(
    state: &AppState,
    expected: ExpectedProject,
    bundle: bool,
    preserve_folders: bool,
    selection: Option<ExportSelection>,
) -> Result<ExportPreview> {
    let epoch = {
        let mut tasks = state
            .4
            .lock()
            .map_err(|_| AppError::invalid("交换服务不可用"))?;
        tasks.preview_epoch = tasks.preview_epoch.wrapping_add(1);
        tasks.preview_epoch
    };
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let binding = {
            let current = state
                .0
                .lock()
                .map_err(|_| super::collaboration::runtime::unavailable())?;
            check_current(&current, &Some(expected.clone()), false)?;
            let p = current
                .as_ref()
                .ok_or_else(super::collaboration::runtime::stale)?;
            super::collaboration::runtime::check_mutation(
                p,
                &state.6,
                expected.runtime_nonce.as_deref(),
            )?;
            let r = state
                .6
                .current
                .lock()
                .map_err(|_| super::collaboration::runtime::unavailable())?;
            p.is_shared()
                .then(|| super::collaboration::runtime::Expected {
                    runtime_nonce: r.nonce.clone(),
                    project_id: expected.project_id.clone(),
                    expected_revision: expected.expected_revision,
                })
        };
        if let Some(binding) = binding {
            let repo = state
                .6
                .current
                .lock()
                .map_err(|_| super::collaboration::runtime::unavailable())?
                .repo
                .clone()
                .ok_or_else(super::collaboration::runtime::stale)?;
            if !repo.entry_is_current()? {
                super::collaboration::operations::converge_retirement(&state, &binding)?;
            }
        }
        // Capture immutable native context only; all head I/O and planning is outside state.0.
        let (private, root, manifest, repo, nonce, actor_id) = {
            let current = state
                .0
                .lock()
                .map_err(|_| AppError::invalid("项目服务不可用"))?;
            let p = current
                .as_ref()
                .ok_or_else(super::collaboration::runtime::stale)?;
            super::collaboration::runtime::check_mutation(
                p,
                &state.6,
                expected.runtime_nonce.as_deref(),
            )?;
            check_current(&current, &Some(expected.clone()), false)?;
            let runtime = state
                .6
                .current
                .lock()
                .map_err(|_| super::collaboration::runtime::unavailable())?;
            (
                p.snapshot()?.document,
                p.root().to_path_buf(),
                p.workspace().ok().map(|w| w.manifest().clone()),
                runtime.repo.clone(),
                runtime.nonce.clone(),
                p.workspace()
                    .ok()
                    .and_then(|w| w.actor())
                    .map(|a| a.author_id.clone()),
            )
        };
        let audio_only_request = selection.as_ref().is_some_and(|s| s.audio_only);
        let mut document = if audio_only_request {
            private.clone()
        } else if let Some(mut manifest) = manifest {
            let ids: std::collections::HashSet<_> =
                private.media.iter().map(|m| m.id.as_str()).collect();
            manifest.media.retain(|m| ids.contains(m.id.as_str()));
            annotator_core::collaboration::LayerPayload::from_document(&private)?
                .project(&manifest)?
        } else {
            private.clone()
        };
        if bundle {
            let sources: std::collections::HashMap<_, _> = private
                .media
                .iter()
                .map(|m| (m.id.as_str(), m.source_ref.as_str()))
                .collect();
            for media in &mut document.media {
                media.source_ref = sources[media.id.as_str()].into();
            }
        }
        #[cfg(test)]
        state.6.run_hook();
        let mut organization = if let Some(repo) = &repo {
            repo.read_organization()?
        } else {
            exchange::root_organization(&document)?
        };
        let recycle = repo.as_ref().map(|r| r.read_recycle()).transpose()?;
        let recycle_revision = recycle.as_ref().map(|r| r.revision);
        if let Some(recycle) = recycle {
            recycle.filter_export(&mut document);
        }
        let organization_revision = repo.as_ref().map(|_| organization.revision);
        let mut authors = vec![];
        let mut audio_only = false;
        if let Some(selection) = selection {
            if !bundle {
                return Err(AppError::invalid("部分导出需要使用 ZIP"));
            }
            document = exchange::select_document(&document, &selection.media_ids)?;
            organization = exchange::select_organization(&document, &organization)?;
            let ids = document.media.iter().map(|m| m.id.clone()).collect();
            audio_only = selection.audio_only;
            let requested: std::collections::HashSet<_> = selection.author_ids.iter().collect();
            if requested.len() != selection.author_ids.len() || requested.len() > 128 {
                return Err(AppError::invalid("无效的作者选择"));
            }
            if !audio_only {
                let repo = repo
                    .as_ref()
                    .ok_or_else(|| AppError::invalid("请先将项目保存为共享项目"))?;
                let snapshot = repo.snapshot_authors(&selection.author_ids)?;
                if requested.iter().any(|id| {
                    !snapshot
                        .authors
                        .iter()
                        .any(|a| &a.identity.author_id == *id)
                }) {
                    return Err(AppError::invalid("作者已变化，请重新选择"));
                }
                for author in snapshot.authors {
                    if !requested.contains(&author.identity.author_id) {
                        continue;
                    }
                    if let Some(error) = author.error {
                        return Err(error);
                    }
                    let payload = if actor_id.as_deref() == Some(&author.identity.author_id) {
                        annotator_core::collaboration::LayerPayload::from_document(&private)?
                    } else {
                        author.layer.map(|l| l.payload).unwrap_or_default()
                    };
                    authors.push(exchange::PortableAuthor {
                        identity: author.identity,
                        payload: exchange::select_payload(&payload, &ids),
                    });
                }
                if authors.is_empty() {
                    return Err(AppError::invalid("请至少选择一个作者"));
                }
            }
            // Labels live exclusively in attributed layers for the new package format.
            document.categories.clear();
            document.annotations.clear();
            for media in &mut document.media {
                media.note.clear();
                media.channel_notes.iter_mut().for_each(String::clear);
                media.category_ids.clear();
                media.channel_category_ids.iter_mut().for_each(Vec::clear);
            }
        }

        let plan =
            exchange::ExportPathPlan::build(&document, &organization, bundle, preserve_folders)?;
        let authority = repo
            .as_ref()
            .map(|r| exchange::SharedSourceAuthority::capture(r));
        if let Some(authority) = &authority {
            authority.verify()?;
        }
        check_capture(&state, &expected, &nonce)?;
        let token = uuid::Uuid::new_v4().to_string();
        let result = ExportPreview {
            token: token.clone(),
            runtime_nonce: nonce.clone(),
            project_id: expected.project_id.clone(),
            document_revision: expected.expected_revision,
            organization_revision,
            bundle,
            preserve_folders,
            directories: plan.directories.clone(),
            media_paths: plan.media_paths.clone(),
            changes: plan.changes.clone(),
        };
        let capture = Arc::new(ExportCapture {
            authors,
            audio_only,
            expected,
            runtime_nonce: nonce,
            document,
            root,
            repo,
            organization_revision,
            plan,
            recycle_revision,
            authority,
        });
        let mut tasks = state
            .4
            .lock()
            .map_err(|_| AppError::invalid("交换服务不可用"))?;
        if tasks.current.is_some() {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "请等待交换任务结束",
            ));
        }
        if tasks.preview_epoch != epoch {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "目录预览已被新的请求替代",
            ));
        }
        tasks.preview = Some((token, capture));
        Ok(result)
    })
    .await
    .map_err(|_| super::collaboration::runtime::unavailable())?
}
#[tauri::command]
pub async fn export_path_preview(
    state: State<'_, AppState>,
    expected: ExpectedProject,
    bundle: bool,
    preserve_folders: bool,
    selection: Option<ExportSelection>,
) -> Result<ExportPreview> {
    preview_selected(&state, expected, bundle, preserve_folders, selection).await
}
fn accepted(
    state: &AppState,
    expected: &ExpectedProject,
    token: &str,
    bundle: bool,
) -> Result<Arc<ExportCapture>> {
    let capture = {
        let tasks = state
            .4
            .lock()
            .map_err(|_| AppError::invalid("交换服务不可用"))?;
        let (id, capture) = tasks
            .preview
            .as_ref()
            .ok_or_else(super::collaboration::runtime::stale)?;
        if id != token || capture.expected != *expected || capture.plan.bundle != bundle {
            return Err(super::collaboration::runtime::stale());
        }
        capture.clone()
    };
    check_capture(state, expected, &capture.runtime_nonce)?;
    let _source_guard = capture.authority.as_ref().map(|a| a.lock()).transpose()?;
    if let Some(repo) = &capture.repo {
        if Some(repo.read_organization()?.revision) != capture.organization_revision
            || Some(repo.read_recycle()?.revision) != capture.recycle_revision
        {
            return Err(AppError::new(
                ErrorCode::RevisionConflict,
                "导出目录已改变，请刷新预览",
            ));
        }
    }
    check_capture(state, expected, &capture.runtime_nonce)?;
    Ok(capture)
}
async fn export(
    state: &AppState,
    expected: ExpectedProject,
    path: String,
    bundle: bool,
    preview_token: String,
    on_event: Channel<ExchangeEvent>,
) -> Result<String> {
    let permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    let validate_state = state.clone();
    let capture = tauri::async_runtime::spawn_blocking(move || {
        accepted(&validate_state, &expected, &preview_token, bundle)
    })
    .await
    .map_err(|_| super::collaboration::runtime::unavailable())??;
    let (id, cancel) = state
        .4
        .lock()
        .map_err(|_| AppError::invalid("交换服务不可用"))?
        .begin_with(permit.cancel.clone())?;
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
        let result = capture.write(Path::new(&path), &cancel, progress);
        drop(permit);
        finish(&state, &worker_id, result.map(|_| (path, None)), &on_event);
    });
    Ok(id)
}
#[tauri::command]
pub async fn export_annotations(
    state: State<'_, AppState>,
    expected: ExpectedProject,
    path: String,
    preview_token: String,
    on_event: Channel<ExchangeEvent>,
) -> Result<String> {
    export(&state, expected, path, false, preview_token, on_event).await
}
#[tauri::command]
pub async fn export_bundle(
    state: State<'_, AppState>,
    expected: ExpectedProject,
    path: String,
    preview_token: String,
    on_event: Channel<ExchangeEvent>,
) -> Result<String> {
    export(&state, expected, path, true, preview_token, on_event).await
}
#[tauri::command]
pub fn import_exchange(
    state: State<'_, AppState>,
    expected: Option<ExpectedProject>,
    source: String,
    parent: Option<String>,
    merge: Option<bool>,
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
            if merge.unwrap_or(false) {
                let expected = expected
                    .as_ref()
                    .ok_or_else(|| AppError::invalid("请先打开目标项目"))?;
                let (repo, actor) = {
                    let current = state
                        .0
                        .lock()
                        .map_err(|_| super::collaboration::runtime::unavailable())?;
                    let p = current
                        .as_ref()
                        .ok_or_else(super::collaboration::runtime::stale)?;
                    if !super::collaboration::catalog::can_import(p) {
                        return Err(AppError::invalid("当前项目不能导入音频"));
                    }
                    let workspace = p.workspace()?;
                    (
                        state
                            .6
                            .current
                            .lock()
                            .map_err(|_| super::collaboration::runtime::unavailable())?
                            .repo
                            .clone()
                            .ok_or_else(super::collaboration::runtime::stale)?,
                        workspace
                            .author_session()
                            .ok_or_else(super::collaboration::runtime::stale)?,
                    )
                };
                let local = state.6.local()?;
                let staging = local.join(format!("package-merge-{}", uuid::Uuid::new_v4()));
                let mut owned = super::collaboration::Owned::new();
                owned.dir(&staging)?;
                let imported = exchange::import_exchange(
                    Path::new(&source),
                    &staging,
                    &cancel,
                    Limits::default(),
                    |phase, completed| {
                        if last.elapsed() >= Duration::from_millis(100) {
                            last = Instant::now();
                            let _ = on_event.send(ExchangeEvent::Progress {
                                task_id: worker_id.clone(),
                                phase: phase.into(),
                                completed,
                            });
                        }
                    },
                );
                owned.inventory(&staging)?;
                let imported = imported?;
                if imported.authors.is_empty() {
                    return Err(AppError::invalid(
                        "合并导入需要新版音频标注包；旧分享文件请作为独立项目导入",
                    ));
                }
                check_capture(&state, expected, &nonce)?;
                let repo = Arc::new(exchange::merge_package(
                    &repo,
                    &actor,
                    &imported,
                    &local.join("exchange-pcm"),
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
                )?);
                let catalog_source = {
                    let current = state
                        .0
                        .lock()
                        .map_err(|_| super::collaboration::runtime::unavailable())?;
                    current
                        .as_ref()
                        .ok_or_else(super::collaboration::runtime::stale)?
                        .workspace()?
                        .catalog_source()
                };
                let catalog = catalog_source.prepare(repo.clone())?;
                let remote = repo.snapshot()?;
                let mut current = state
                    .0
                    .lock()
                    .map_err(|_| super::collaboration::runtime::unavailable())?;
                check_current(&current, &Some(expected.clone()), true)?;
                let p = current
                    .as_mut()
                    .ok_or_else(super::collaboration::runtime::stale)?;
                let mut runtime = state
                    .6
                    .current
                    .lock()
                    .map_err(|_| super::collaboration::runtime::unavailable())?;
                let mut layers = runtime
                    .layers
                    .clone()
                    .ok_or_else(super::collaboration::runtime::stale)?;
                layers.adopt_prepared_catalog(&catalog)?;
                p.adopt_prepared_catalog(
                    &expected.project_id,
                    expected.expected_revision,
                    catalog,
                )?;
                layers.update(remote)?;
                runtime.layers = Some(layers);
                runtime.repo = Some(repo.clone());
                drop(runtime);
                let path = repo.root().to_string_lossy().into_owned();
                let opened = info_shared(p, &state.6)?;
                return Ok(Some((path, Some(opened))));
            }
            let parent = parent
                .as_ref()
                .ok_or_else(|| AppError::invalid("请选择新项目存放位置"))?;
            let imported = super::collaboration::exchange_default::prepare(
                Path::new(&source),
                Path::new(&parent),
                &state.6.local()?,
                &state.6.selected_profile()?,
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
    use crate::commands::collaboration::defaults::purge_tests::Fixture;
    fn expected(f: &Fixture) -> ExpectedProject {
        let e = f.expected();
        ExpectedProject {
            runtime_nonce: Some(e.runtime_nonce),
            project_id: e.project_id,
            expected_revision: e.expected_revision,
        }
    }
    #[test]
    fn partial_preview_limits_media_and_authors_then_imports_an_independent_snapshot() {
        use annotator_core::collaboration::{profiles::Profile, LayerPayload};
        let f = Fixture::new();
        let bob = Profile::new("Bob").unwrap();
        let session = f.repo.adopt(&bob).unwrap();
        f.repo
            .publish(
                &session,
                None,
                &LayerPayload::from_document(&f.document).unwrap(),
            )
            .unwrap();
        let e = expected(&f);
        let selected = f.document.media[0].id.clone();
        let preview = tauri::async_runtime::block_on(preview_selected(
            &f.state,
            e.clone(),
            true,
            false,
            Some(ExportSelection {
                media_ids: vec![selected.clone()],
                author_ids: vec![bob.author_id.clone()],
                audio_only: false,
            }),
        ))
        .unwrap();
        assert_eq!(preview.media_paths.len(), 1);
        let capture = accepted(&f.state, &e, &preview.token, true).unwrap();
        assert_eq!(capture.authors.len(), 1);
        assert_eq!(capture.authors[0].identity.author_id, bob.author_id);
        assert!(capture.authors[0]
            .payload
            .annotations
            .iter()
            .all(|a| a.region.media_id == selected));
        let target = f.root.join("partial.zip");
        capture
            .write(&target, &AtomicBool::new(false), |_, _| {})
            .unwrap();
        std::fs::create_dir(f.root.join("imports")).unwrap();
        std::fs::create_dir(f.root.join("receiver-local")).unwrap();
        let prepared = super::super::collaboration::exchange_default::prepare(
            &target,
            &f.root.join("imports"),
            &f.root.join("receiver-local"),
            &Profile::new("Receiver").unwrap(),
            None,
            &AtomicBool::new(false),
            |_, _| {},
        )
        .unwrap();
        let super::super::collaboration::exchange_default::PreparedImport::Ready(prepared) =
            prepared
        else {
            panic!("bundle must be self contained")
        };
        assert_eq!(prepared.repo.manifest().media.len(), 1);
        let authors = prepared.repo.snapshot().unwrap().authors;
        assert!(authors
            .iter()
            .any(|a| a.identity.display_name == "Bob（导入）"));
        assert!(authors.iter().all(|a| a.layer.as_ref().is_none_or(|l| l
            .payload
            .annotations
            .iter()
            .all(|a| a.region.media_id == selected))));
    }
    #[test]
    fn preview_uses_loaded_catalog_and_reads_only_selected_authors() {
        use annotator_core::collaboration::{profiles::Profile, LayerPayload};
        let f = Fixture::new();
        let e = expected(&f);
        let other = Profile::new("Not exported").unwrap();
        let actor = f.repo.adopt(&other).unwrap();
        f.repo
            .publish(
                &actor,
                None,
                &LayerPayload::from_document(&f.document).unwrap(),
            )
            .unwrap();
        let record = f
            .root
            .join("source/catalog")
            .join(format!("{}.json", f.document.media[1].id));
        let before = std::fs::read(&record).unwrap();
        std::fs::write(
            &record,
            b"unrelated record must not be read for partial export",
        )
        .unwrap();
        let layer = f
            .root
            .join("source/annotations")
            .join(&other.author_id)
            .join("00000000000000000001.json");
        std::fs::write(&layer, b"unrelated author layer must not be read").unwrap();
        let selection = ExportSelection {
            media_ids: vec![f.document.media[0].id.clone()],
            author_ids: vec![f.actor.identity().author_id.clone()],
            audio_only: false,
        };
        let result = tauri::async_runtime::block_on(preview_selected(
            &f.state,
            e,
            true,
            true,
            Some(selection),
        ));
        std::fs::write(record, before).unwrap();
        assert!(result.is_ok(), "{:#?}", result.err());
    }
    #[test]
    fn late_preview_cannot_replace_a_newer_native_acceptance_token() {
        use std::sync::mpsc;
        let f = Fixture::new();
        let e = expected(&f);
        let (ready, seen) = mpsc::channel();
        let (resume, wait) = mpsc::channel();
        *f.state.6.hook.lock().unwrap() = Some(Box::new(move || {
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        }));
        let state = f.state.clone();
        let first = e.clone();
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(preview_selected(&state, first, true, true, None))
        });
        seen.recv_timeout(Duration::from_secs(5)).unwrap();
        let newer = tauri::async_runtime::block_on(preview_selected(
            &f.state,
            e.clone(),
            true,
            false,
            None,
        ))
        .unwrap();
        resume.send(()).unwrap();
        assert_eq!(
            worker.join().unwrap().err().unwrap().code,
            ErrorCode::Cancelled
        );
        assert!(accepted(&f.state, &e, &newer.token, true).is_ok());
    }
    #[test]
    fn partial_preview_refuses_stale_selection_and_audio_zip_needs_no_authors() {
        let f = Fixture::new();
        let e = expected(&f);
        let selection = ExportSelection {
            media_ids: vec![uuid::Uuid::new_v4().to_string()],
            author_ids: vec![],
            audio_only: true,
        };
        assert!(tauri::async_runtime::block_on(preview_selected(
            &f.state,
            e.clone(),
            true,
            true,
            Some(selection)
        ))
        .is_err());
        let selection = ExportSelection {
            media_ids: vec![f.document.media[0].id.clone()],
            author_ids: vec![],
            audio_only: true,
        };
        let preview = tauri::async_runtime::block_on(preview_selected(
            &f.state,
            e.clone(),
            true,
            true,
            Some(selection),
        ))
        .unwrap();
        let capture = accepted(&f.state, &e, &preview.token, true).unwrap();
        let target = f.root.join("audio-only.zip");
        capture
            .write(&target, &AtomicBool::new(false), |_, _| {})
            .unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(target).unwrap()).unwrap();
        assert!(zip.by_name("manifest.json").is_err());
    }
    #[test]
    fn export_converges_retirement_and_exports_only_survivors_from_pending_cleanup() {
        let f = Fixture::new();
        let old = expected(&f);
        f.retire();
        let error = tauri::async_runtime::block_on(preview(&f.state, old, true, true))
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::RevisionConflict);
        let e = expected(&f);
        let p = tauri::async_runtime::block_on(preview(&f.state, e.clone(), true, true)).unwrap();
        let capture = accepted(&f.state, &e, &p.token, true).unwrap();
        let target = f.root.join("survivors.zip");
        capture
            .write(&target, &AtomicBool::new(false), |_, _| {})
            .unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&target).unwrap()).unwrap();
        let paths: Vec<_> = archive.file_names().map(str::to_owned).collect();
        assert_eq!(capture.document.media.len(), 1);
        assert_eq!(capture.document.media[0].id, f.document.media[1].id);
        assert!(!paths
            .iter()
            .any(|p| p.contains("maintenance") || p.contains("state/")));
        assert!(paths.iter().any(|p| p == "audio/Empty/"));
        let mut bytes = vec![];
        std::io::Read::read_to_end(
            &mut archive
                .by_name(&capture.plan.media_paths[&f.document.media[1].id])
                .unwrap(),
            &mut bytes,
        )
        .unwrap();
        assert_eq!(
            bytes,
            std::fs::read(f.root.join("source").join(&f.document.media[1].source_ref)).unwrap()
        );
        let mut manifest = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("manifest.json").unwrap(),
            &mut manifest,
        )
        .unwrap();
        assert!(!manifest.contains(&f.document.media[0].id));
        assert!(!manifest.contains("sourceRef"));
        assert!(f
            .root
            .join("source")
            .join(&f.document.media[0].source_ref)
            .exists());
    }
    #[test]
    fn accepted_export_rejects_generation_change_even_when_revisions_match() {
        let f = Fixture::new();
        // The captured export already excludes recycled A. Deliberately give
        // the new generation the same valid mutable-head counters: those
        // counters alone must never identify the source entry.
        f.repo
            .apply_recycle_controlled(
                &f.actor,
                0,
                annotator_core::collaboration::recycle::RecycleOperation {
                    operation_id: uuid::Uuid::new_v4().to_string(),
                    media_ids: vec![f.document.media[0].id.clone()],
                    trash: true,
                },
                &AtomicBool::new(false),
                || Ok(()),
            )
            .unwrap();
        let e = expected(&f);
        let p = tauri::async_runtime::block_on(preview(&f.state, e.clone(), false, true)).unwrap();
        let organization_revision = f.repo.read_organization().unwrap().revision;
        let recycle_revision = f.repo.read_recycle().unwrap().revision;
        let purge = f
            .repo
            .preview_purge(
                &f.actor,
                "test",
                &uuid::Uuid::new_v4().to_string(),
                annotator_core::collaboration::purge::transaction::PurgeSelection::All,
            )
            .unwrap();
        f.repo
            .commit_purge(&f.actor, "test", &purge, &AtomicBool::new(false))
            .unwrap();
        let entry: serde_json::Value = serde_json::from_slice(
            &std::fs::read(f.root.join("source/collaboration.json")).unwrap(),
        )
        .unwrap();
        let generation = f
            .root
            .join("source/state")
            .join(entry["metadataGeneration"].as_str().unwrap());
        for (name, revision) in [
            ("organization.json", organization_revision),
            ("recycle.json", recycle_revision),
        ] {
            let path = generation.join(name);
            let mut head: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            head["revision"] = serde_json::json!(revision);
            std::fs::write(path, serde_json::to_vec(&head).unwrap()).unwrap();
        }
        let fresh =
            annotator_core::collaboration::CollaborationRepository::open(&f.root.join("source"))
                .unwrap();
        assert_eq!(
            fresh.read_organization().unwrap().revision,
            organization_revision
        );
        assert_eq!(fresh.read_recycle().unwrap().revision, recycle_revision);
        assert_eq!(
            accepted(&f.state, &e, &p.token, false).err().unwrap().code,
            ErrorCode::RevisionConflict
        );
    }
    #[test]
    fn export_worker_rejects_purge_after_acceptance_before_writing() {
        let f = Fixture::new();
        let e = expected(&f);
        let p = tauri::async_runtime::block_on(preview(&f.state, e.clone(), true, true)).unwrap();
        let capture = accepted(&f.state, &e, &p.token, true).unwrap();
        f.retire();
        let target = f.root.join("stale.zip");
        assert_eq!(
            capture
                .write(&target, &AtomicBool::new(false), |_, _| {})
                .unwrap_err()
                .code,
            ErrorCode::RevisionConflict
        );
        assert!(!target.exists());
    }
    #[test]
    fn export_purge_during_archive_build_completes_and_prevents_final_publication() {
        let f = Fixture::new();
        let e = expected(&f);
        let p = tauri::async_runtime::block_on(preview(&f.state, e.clone(), true, true)).unwrap();
        let capture = accepted(&f.state, &e, &p.token, true).unwrap();
        let target = f.root.join("racing.zip");
        let mut retired = false;
        let result = capture.write(&target, &AtomicBool::new(false), |phase, _| {
            if phase == "复制原始媒体" && !retired {
                // Real commit must progress while the ZIP is still being built.
                f.retire();
                retired = true;
            }
        });
        assert!(retired);
        assert_eq!(result.unwrap_err().code, ErrorCode::RevisionConflict);
        assert!(!target.exists());
        assert!(!std::fs::read_dir(&f.root).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".exchange-")));
    }
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
    #[test]
    fn native_export_preview_rejects_stale_bindings_and_freezes_accepted_output() {
        use annotator_core::collaboration::organization::OrganizationOperation;
        let root = std::env::temp_dir().join(format!("export-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("project")).unwrap();
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        tauri::async_runtime::block_on(crate::commands::collaboration::defaults::create(
            &state,
            root.join("project").to_string_lossy().into(),
            "Preview".into(),
        ))
        .unwrap();
        let expected = {
            let current = state.0.lock().unwrap();
            let d = current.as_ref().unwrap().snapshot().unwrap().document;
            ExpectedProject {
                project_id: d.project_id,
                expected_revision: d.revision,
                runtime_nonce: Some(state.6.current.lock().unwrap().nonce.clone()),
            }
        };
        let probe = state.clone();
        *state.6.hook.lock().unwrap() = Some(Box::new(move || {
            assert!(
                probe.0.try_lock().is_ok(),
                "path planning held private state"
            );
        }));
        let preview =
            tauri::async_runtime::block_on(super::preview(&state, expected.clone(), true, true))
                .unwrap();
        println!(
            "EXPORT_PREVIEW_IPC={}",
            serde_json::to_string(&preview).unwrap()
        );
        let repo = state.6.current.lock().unwrap().repo.clone().unwrap();
        let actor = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .workspace()
            .unwrap()
            .author_session()
            .unwrap();
        let head = repo
            .apply_organization(
                &actor,
                0,
                OrganizationOperation::CreateFolder {
                    id: uuid::Uuid::new_v4().to_string(),
                    parent_id: None,
                    name: "CON".into(),
                },
            )
            .unwrap();
        assert_eq!(
            super::accepted(&state, &expected, &preview.token, true)
                .err()
                .unwrap()
                .code,
            ErrorCode::RevisionConflict
        );
        let preview =
            tauri::async_runtime::block_on(super::preview(&state, expected.clone(), true, true))
                .unwrap();
        assert!(preview.changes.iter().any(|c| c.kind == "folder"));
        let captured = super::accepted(&state, &expected, &preview.token, true).unwrap();
        repo.apply_organization(
            &actor,
            head.revision,
            OrganizationOperation::RenameFolder {
                id: head.folders[0].id.clone(),
                name: "Later".into(),
            },
        )
        .unwrap();
        let target = root.join("frozen.zip");
        exchange::export_bundle_with_plan(
            &captured.document,
            &captured.plan,
            &captured.root,
            &target,
            &AtomicBool::new(false),
            Limits::default(),
            |_, _| {},
        )
        .unwrap();
        let archive = zip::ZipArchive::new(std::fs::File::open(&target).unwrap()).unwrap();
        assert!(archive.file_names().any(|p| p == "audio/_CON/"));
        assert!(!archive.file_names().any(|p| p.contains("Later")));
        drop(archive);
        let fresh =
            tauri::async_runtime::block_on(super::preview(&state, expected.clone(), false, true))
                .unwrap();
        let mut wrong = expected.clone();
        wrong.expected_revision += 1;
        assert!(super::accepted(&state, &wrong, &fresh.token, false).is_err());
        wrong = expected.clone();
        wrong.runtime_nonce = Some(uuid::Uuid::new_v4().to_string());
        assert!(super::accepted(&state, &wrong, &fresh.token, false).is_err());
        let current = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document;
        state
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .apply_change(
                &current.project_id,
                current.revision,
                annotator_core::model::Change::AddCategory {
                    category: annotator_core::model::Category {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "Changed".into(),
                        color: "#aabbcc".into(),
                    },
                },
            )
            .unwrap();
        assert!(super::accepted(&state, &expected, &fresh.token, false).is_err());
        drop((actor, repo, state, captured));
        std::fs::remove_dir_all(root).unwrap();
    }
}
