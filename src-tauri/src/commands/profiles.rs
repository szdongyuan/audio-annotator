//! Global identity commands. Durable selection and editor replacement share one guarded commit.
use super::{
    collaboration::{
        runtime::{self, Runtime},
        Transition,
    },
    project::info_with_status,
};
use crate::state::AppState;
use annotator_core::{
    collaboration::{
        profiles::{Profile, ProfileSnapshot},
        RememberedLayers,
    },
    error::{AppError, ErrorCode, Result},
    media::identity::check_cancel,
    project::LocalProject,
};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};
use tauri::State;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectExpectation {
    pub project_id: String,
    pub expected_revision: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expected {
    pub store_revision: u64,
    pub runtime_nonce: String,
    #[serde(deserialize_with = "required_nullable")]
    pub project: Option<ProjectExpectation>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub store_revision: u64,
    pub selected_author_id: String,
    pub profiles: Vec<Profile>,
    pub runtime_nonce: String,
    pub project: Option<ProjectExpectation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub profiles: Snapshot,
    pub transition: Option<Transition>,
    pub status: Option<runtime::Status>,
    pub warning: Option<AppError>,
    pub profile: Option<Profile>,
    pub already_exists: bool,
}
pub enum Action {
    Create(String),
    Rename {
        author_id: String,
        display_name: String,
    },
    Import(Option<String>),
    Export {
        author_id: String,
        path: Option<String>,
    },
    Select(String),
}
fn required_nullable<'de, D, T>(d: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d)
}
fn project_expectation(project: Option<&LocalProject>) -> Result<Option<ProjectExpectation>> {
    project
        .map(|p| {
            let d = p.snapshot()?.document;
            Ok(ProjectExpectation {
                project_id: d.project_id,
                expected_revision: d.revision,
            })
        })
        .transpose()
}
impl Expected {
    pub fn check(&self, project: Option<&LocalProject>, runtime: &Runtime) -> Result<()> {
        if self.runtime_nonce != runtime.nonce || self.project != project_expectation(project)? {
            return Err(runtime::stale());
        }
        Ok(())
    }
}
fn snapshot(
    saved: ProfileSnapshot,
    selected: String,
    runtime: &Runtime,
    project: Option<&LocalProject>,
) -> Result<Snapshot> {
    Ok(Snapshot {
        store_revision: saved.revision,
        selected_author_id: selected,
        profiles: saved.profiles,
        runtime_nonce: runtime.nonce.clone(),
        project: project_expectation(project)?,
    })
}
pub async fn list(state: &AppState) -> Result<Snapshot> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Initialize the process identity before taking authority locks. This helper
        // locks selected internally, so its result is not the snapshot's selected UUID.
        state.6.selected_profile()?;
        #[cfg(test)]
        {
            let hook = state.6.list_after_identity.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        // Match selection's commit order and retain all three guards through the
        // store read and DTO capture. A list cannot combine A's UUID with B's revision
        // and runtime, including projects where selection does not change the nonce.
        let current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
        let selected = state
            .6
            .selected
            .lock()
            .map_err(|_| runtime::unavailable())?;
        let saved = state.6.profile_store()?.snapshot()?;
        let author_id = selected.as_ref().ok_or_else(runtime::stale)?;
        if !saved.profiles.iter().any(|p| &p.author_id == author_id) {
            return Err(runtime::stale());
        }
        snapshot(saved, author_id.clone(), &runtime, current.as_ref())
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
fn response(profiles: Snapshot) -> Response {
    Response {
        profiles,
        transition: None,
        status: None,
        warning: None,
        profile: None,
        already_exists: false,
    }
}
pub async fn perform(
    state: &AppState,
    expected: Expected,
    operation_id: String,
    action: Action,
) -> Result<Response> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err(AppError::invalid("Invalid profile operation ID"));
    }
    let permit = state.6.begin(operation_id)?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let active = state.6.selected_profile()?;
        let store = state.6.profile_store()?;
        let saved = store.snapshot()?;
        if saved.revision != expected.store_revision {
            return Err(runtime::stale());
        }
        let (repo, session) = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            expected.check(current.as_ref(), &runtime)?;
            let session = current
                .as_ref()
                .and_then(|p| p.workspace().ok())
                .and_then(|w| w.author_session());
            if matches!(&action, Action::Select(id) if id!=&active.author_id) && session.is_some() {
                let p = current.as_ref().ok_or_else(runtime::stale)?;
                if p.persisted_revision() != p.snapshot()?.document.revision {
                    return Err(AppError::new(
                        ErrorCode::SaveFailed,
                        "Save the current project first",
                    ));
                }
                let w = p.workspace()?;
                if w.envelope().pending.is_some()
                    || w.sync_error().is_some()
                    || p.recovery().is_some()
                {
                    return Err(AppError::new(
                        ErrorCode::SaveFailed,
                        "Finish publication or recovery before switching identity",
                    ));
                }
            }
            (runtime.repo.clone(), session)
        };
        #[cfg(test)]
        state.6.run_hook();
        check_cancel(&permit.cancel)?;
        if let Action::Select(id) = &action {
            let profile = saved
                .profiles
                .iter()
                .find(|p| &p.author_id == id)
                .cloned()
                .ok_or_else(|| AppError::invalid("Profile does not exist"))?;
            let mut next = if id != &active.author_id && session.is_some() {
                let repo = repo.as_ref().ok_or_else(runtime::stale)?;
                let actor = Arc::new(repo.adopt(&profile)?);
                let project =
                    LocalProject::open_shared(repo.clone(), Some(actor), &state.6.local()?)?;
                // Fail preparation before the persistent commit, including an unreadable recovery snapshot.
                project.snapshot()?;
                Some(project)
            } else {
                None
            };
            #[cfg(test)]
            {
                if let Some(hook) = state.6.after_io.lock().unwrap().take() {
                    hook();
                }
            }
            let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let mut runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            expected.check(current.as_ref(), &runtime)?;
            let mut selected = state
                .6
                .selected
                .lock()
                .map_err(|_| runtime::unavailable())?;
            let mut sources = state.6.sources.lock().map_err(|_| runtime::unavailable())?;
            let prepared = state
                .6
                .prepared
                .lock()
                .map_err(|_| runtime::unavailable())?;
            let mut media = state.1.lock().map_err(|_| runtime::unavailable())?;
            let mut folders = state.5.lock().map_err(|_| runtime::unavailable())?;
            if id != &active.author_id
                && (sources.active()
                    || !prepared.is_empty()
                    || media.has_pending_work()
                    || folders.has_pending_work()
                    || state.6.preparing()?)
            {
                return Err(AppError::new(
                    ErrorCode::ResourceLimit,
                    "Finish or release media import before switching identity",
                ));
            }
            let replacement = next.as_ref().map(|_| Runtime {
                repo: repo.clone(),
                layers: repo
                    .as_ref()
                    .map(|r| RememberedLayers::new(r.manifest().clone())),
                ..Runtime::default()
            });
            let target_runtime = replacement.as_ref().unwrap_or(&runtime);
            let target_project = next.as_ref().or(current.as_ref());
            let mut result = response(snapshot(
                saved.clone(),
                id.clone(),
                target_runtime,
                target_project,
            )?);
            if let Some(project) = next.as_ref() {
                let status = runtime::status_for_runtime(Some(project), target_runtime, false)?;
                let opened = info_with_status(project, &status);
                result.transition = Some(Transition { opened, status });
            }
            check_cancel(&permit.cancel)?;
            // All fallible installation/snapshot work and locks are above this durable commit.
            if id == &active.author_id {
                store.check_revision(expected.store_revision)?;
            }
            if id != &active.author_id {
                let committed = store.select_for_process(expected.store_revision, id)?;
                result.profiles.store_revision = committed.revision;
                result.profiles.profiles = committed.profiles;
                *selected = Some(id.clone());
            }
            if let Some(replacement) = replacement {
                sources.reset();
                media.reset();
                folders.reset();
                state.3.reset();
                state.2.scheduler.reset();
                *runtime = replacement;
                *current = next.take();
            }
            return Ok(result);
        }
        let imported = match &action {
            Action::Import(Some(path)) => Some(
                annotator_core::collaboration::profiles::read_transfer(Path::new(path))?,
            ),
            _ => None,
        };
        if let Action::Export {
            author_id,
            path: Some(path),
        } = &action
        {
            let result = {
                let current = state.0.lock().map_err(|_| runtime::unavailable())?;
                let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
                expected.check(current.as_ref(), &runtime)?;
                check_cancel(&permit.cancel)?;
                let (saved, bytes) = store.capture_export(expected.store_revision, author_id)?;
                (
                    response(snapshot(
                        saved,
                        active.author_id,
                        &runtime,
                        current.as_ref(),
                    )?),
                    bytes,
                )
            };
            // Picker destinations may be NAS paths. No live project mutex during file publication.
            annotator_core::collaboration::atomic::publish_new(
                Path::new(path),
                &result.1,
                None,
                Some(&permit.cancel),
            )?;
            return Ok(result.0);
        }
        // Local metadata writes are serialized with runtime replacement, without NAS I/O.
        let (mut result, renamed) = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            expected.check(current.as_ref(), &runtime)?;
            check_cancel(&permit.cancel)?;
            let mut result = response(snapshot(
                saved,
                active.author_id.clone(),
                &runtime,
                current.as_ref(),
            )?);
            let mut renamed = None;
            let committed = match action {
                Action::Create(name) => {
                    let m = store.create(expected.store_revision, &name)?;
                    result.profile = Some(m.profile);
                    m.snapshot
                }
                Action::Rename {
                    author_id,
                    display_name,
                } => {
                    let m = store.rename(expected.store_revision, &author_id, &display_name)?;
                    renamed = Some(m.profile.clone());
                    result.profile = Some(m.profile);
                    m.snapshot
                }
                Action::Import(Some(_)) => {
                    let m = store.import_profile(
                        expected.store_revision,
                        imported.ok_or_else(runtime::stale)?,
                    )?;
                    result.profile = Some(m.profile);
                    result.already_exists = m.already_exists;
                    m.snapshot
                }
                Action::Export { path: Some(_), .. } => unreachable!(),
                Action::Import(None) | Action::Export { path: None, .. } => {
                    store.check_revision(expected.store_revision)?
                }
                Action::Select(_) => unreachable!(),
            };
            result.profiles.store_revision = committed.revision;
            result.profiles.profiles = committed.profiles;
            (result, renamed)
        };
        if let Some(profile) = renamed.filter(|p| p.author_id == active.author_id) {
            if let (Some(repo), Some(session)) = (repo, session) {
                // The local rename is committed. NAS display refresh is best effort and does not replace the editor.
                if let Err(error) = check_cancel(&permit.cancel)
                    .and_then(|_| repo.refresh_author(&session, &profile))
                {
                    let mut warning =
                        AppError::new(error.code, "昵称已保存在本机，项目显示名称未更新");
                    warning.details = Some(serde_json::json!({"cause":error}));
                    result.warning = Some(warning);
                }
                let display_refresh = (|| -> Result<Option<runtime::Status>> {
                    let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
                    let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
                    if expected.check(current.as_ref(), &runtime).is_err() {
                        return Ok(None);
                    }
                    if let Some(p) = current.as_mut() {
                        p.workspace_mut()?.refresh_actor_display(&profile);
                    }
                    Ok(Some(runtime::status_for_runtime(
                        current.as_ref(),
                        &runtime,
                        false,
                    )?))
                })();
                match display_refresh {
                    Ok(status) => result.status = status,
                    Err(error) => {
                        let mut warning =
                            AppError::new(error.code, "昵称已保存在本机，项目显示名称未更新");
                        warning.details = Some(serde_json::json!({"cause":error}));
                        result.warning = Some(warning);
                    }
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}

#[tauri::command]
pub async fn profile_list(state: State<'_, AppState>) -> Result<Snapshot> {
    list(&state).await
}
#[tauri::command]
pub async fn profile_create(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
    display_name: String,
) -> Result<Response> {
    perform(&state, expected, operation_id, Action::Create(display_name)).await
}
#[tauri::command]
pub async fn profile_rename(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
    author_id: String,
    display_name: String,
) -> Result<Response> {
    perform(
        &state,
        expected,
        operation_id,
        Action::Rename {
            author_id,
            display_name,
        },
    )
    .await
}
#[tauri::command]
pub async fn profile_select(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
    author_id: String,
) -> Result<Response> {
    perform(&state, expected, operation_id, Action::Select(author_id)).await
}
#[tauri::command]
pub async fn profile_import(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
    path: Option<String>,
) -> Result<Response> {
    perform(&state, expected, operation_id, Action::Import(path)).await
}
#[tauri::command]
pub async fn profile_export(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
    author_id: String,
    path: Option<String>,
) -> Result<Response> {
    perform(
        &state,
        expected,
        operation_id,
        Action::Export { author_id, path },
    )
    .await
}

#[cfg(test)]
mod tests;
