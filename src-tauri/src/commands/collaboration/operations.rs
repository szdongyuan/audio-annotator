use super::runtime::{self, Expected, Status};
use crate::{
    commands::project::{info_shared, OpenProject},
    state::AppState,
};
use annotator_core::{
    collaboration::*,
    error::{AppError, ErrorCode, Result},
    media::identity::check_cancel,
    project::LocalProject,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

pub fn reset_resources(state: &AppState) -> Result<()> {
    state.3.reset();
    state.1.lock().map_err(|_| runtime::unavailable())?.reset();
    state.5.lock().map_err(|_| runtime::unavailable())?.reset();
    state.2.scheduler.reset();
    Ok(())
}

pub async fn open(state: &AppState, path: String) -> Result<OpenProject> {
    let state = state.clone();
    let permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let nonce = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            if current.is_some() {
                return Err(runtime::stale());
            }
            state
                .6
                .current
                .lock()
                .map_err(|_| runtime::unavailable())?
                .nonce
                .clone()
        };
        let path = Path::new(&path);
        let known_entry = [
            "collaboration.json",
            "project.json",
            "recovery.json",
            "project.json.bak",
        ]
        .iter()
        .any(|name| path.file_name().is_some_and(|n| n == *name));
        if path.is_file() && !known_entry {
            return Err(AppError::invalid("Choose a project entry file"));
        }
        let root = if !path.is_dir() && known_entry {
            path.parent().ok_or_else(runtime::stale)?
        } else {
            path
        };
        let shared = path.file_name().is_some_and(|n| n == "collaboration.json")
            || (path.is_dir() && root.join("collaboration.json").exists());
        let repo = if shared {
            Some(Arc::new(CollaborationRepository::open(root)?))
        } else {
            None
        };
        let project = match &repo {
            Some(repo) => LocalProject::open_shared(repo.clone(), None, &state.6.local()?)?,
            None => {
                let canonical = root
                    .canonicalize()
                    .map_err(|_| AppError::invalid("Invalid project directory"))?;
                if canonical
                    .ancestors()
                    .any(|p| p.join("collaboration.json").exists())
                {
                    return Err(AppError::invalid("Open the collaboration entry file"));
                }
                annotator_core::project::FileStore::preflight_open(root)?;
                LocalProject::open(root)?
            }
        };
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        check_cancel(&_permit.cancel)?;
        if current.is_some()
            || state
                .6
                .current
                .lock()
                .map_err(|_| runtime::unavailable())?
                .nonce
                != nonce
        {
            return Err(runtime::stale());
        }
        reset_resources(&state)?;
        state.6.install(repo)?;
        let opened = info_shared(&project, &state.6)?;
        *current = Some(project);
        Ok(opened)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}

#[tauri::command]
pub async fn collaboration_status(state: State<'_, AppState>) -> Result<Status> {
    status(&state).await
}
pub async fn status(state: &AppState) -> Result<Status> {
    let service = state.6.clone();
    state
        .run(move |s| runtime::status(s.as_ref(), &service))
        .await
}

// All share I/O belongs to this blocking worker, including the read after publication.
// A cancelled async caller does not release the permit while OS I/O is still running.
pub async fn refresh(state: &AppState, expected: Expected) -> Result<Status> {
    let permit = match state.6.begin(uuid::Uuid::new_v4().to_string()) {
        Ok(p) => p,
        Err(e) if e.code == ErrorCode::ResourceLimit => {
            let service = state.6.clone();
            return state
                .run(move |s| {
                    expected.check(
                        s.as_ref().ok_or_else(runtime::stale)?,
                        &*service.current.lock().map_err(|_| runtime::unavailable())?,
                        false,
                    )?;
                    runtime::status(s.as_ref(), &service)
                })
                .await;
        }
        Err(e) => return Err(e),
    };
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let permit = permit;
        let (repo, actor, capture, prior_sync_error) = {
            let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let project = current.as_mut().ok_or_else(runtime::stale)?;
            let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            expected.check(project, &runtime, false)?;
            let repo = runtime.repo.clone().ok_or_else(runtime::stale)?;
            let actor = project.workspace()?.actor().cloned();
            let prior_sync_error = project.workspace()?.sync_error().is_some();
            // An earlier sync error must not prevent the fresh read that can clear it.
            (
                repo,
                actor,
                project.workspace_mut()?.prepare_publication(),
                prior_sync_error,
            )
        };
        #[cfg(test)]
        state.6.run_hook();
        check_cancel(&permit.cancel)?;
        let prepare_error = prior_sync_error && capture.is_err();
        let publication = capture.and_then(|c| c.map(PublicationCapture::publish).transpose());
        let remote = repo.snapshot();
        #[cfg(test)]
        {
            let hook = state.6.after_io.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let project = current.as_mut().ok_or_else(runtime::stale)?;
        let mut runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
        if runtime.nonce != expected.runtime_nonce {
            return Err(runtime::stale());
        }
        check_cancel(&permit.cancel)?;
        runtime.error = None;
        match publication {
            Ok(Some(ack)) => {
                if let Err(e) = project.workspace_mut()?.acknowledge(ack) {
                    runtime.error = Some(e);
                }
            }
            Err(e) => runtime.error = Some(e),
            Ok(None) => (),
        }
        match remote {
            Ok(remote) => {
                // Reconcile only metadata when the read agrees with our new acknowledgement.
                // Never overwrite the live unsaved C using the envelope saved as B.
                if let Some(actor) = actor {
                    if let Some(own) = remote
                        .authors
                        .iter()
                        .find(|a| a.identity.author_id == actor.author_id)
                    {
                        if let Some(e) = &own.error {
                            runtime.error = Some(e.clone());
                        } else {
                            project
                                .workspace_mut()?
                                .observe_remote(own.layer.as_ref())?;
                            if prepare_error && project.workspace()?.sync_error().is_none() {
                                runtime.error = None;
                            }
                        }
                    } else {
                        runtime.error =
                            Some(AppError::invalid("Current account missing from share"));
                    }
                }
                if let Some(layers) = &mut runtime.layers {
                    layers.update(remote)?;
                }
                runtime.updated = Some(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                );
            }
            Err(e) => runtime.error = Some(e),
        }
        drop(runtime);
        drop(permit);
        runtime::status(current.as_ref(), &state.6)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn collaboration_refresh(
    state: State<'_, AppState>,
    expected: Expected,
) -> Result<Status> {
    refresh(&state, expected).await
}
#[tauri::command]
pub async fn collaboration_sync(state: State<'_, AppState>, expected: Expected) -> Result<Status> {
    refresh(&state, expected).await
}
pub fn schedule(state: AppState) {
    tauri::async_runtime::spawn(async move {
        let expected = {
            let current = match state.0.lock() {
                Ok(c) => c,
                Err(_) => return,
            };
            let Some(p) = current
                .as_ref()
                .filter(|p| p.is_shared() && p.recovery().is_none())
            else {
                return;
            };
            let Ok(snapshot) = p.snapshot() else {
                return;
            };
            let Ok(r) = state.6.current.lock() else {
                return;
            };
            Expected {
                runtime_nonce: r.nonce.clone(),
                project_id: snapshot.document.project_id,
                expected_revision: snapshot.document.revision,
            }
        };
        let _ = refresh(&state, expected).await;
    });
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IdentityAction {
    Register {
        login: String,
        display_name: String,
        password: String,
    },
    Login {
        login: String,
        password: String,
    },
    Logout,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub opened: OpenProject,
    pub status: Status,
}

pub async fn identity(
    state: &AppState,
    expected: Expected,
    operation_id: String,
    action: IdentityAction,
) -> Result<Transition> {
    let permit = state.6.begin(operation_id)?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let permit = permit;
        let repo = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let project = current.as_ref().ok_or_else(runtime::stale)?;
            let runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            expected.check(project, &runtime, true)?;
            runtime.repo.clone().ok_or_else(runtime::stale)?
        };
        #[cfg(test)]
        state.6.run_hook();
        check_cancel(&permit.cancel)?;
        let actor = match action {
            IdentityAction::Register {
                login,
                display_name,
                password,
            } => {
                repo.register(&login, &display_name, &password)?;
                check_cancel(&permit.cancel)?;
                Some(Arc::new(repo.login(&login, &password)?))
            }
            IdentityAction::Login { login, password } => {
                Some(Arc::new(repo.login(&login, &password)?))
            }
            IdentityAction::Logout => None,
        };
        check_cancel(&permit.cancel)?;
        let next = LocalProject::open_shared(repo.clone(), actor, &state.6.local()?)?;
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        expected.check(
            current.as_ref().ok_or_else(runtime::stale)?,
            &*state.6.current.lock().map_err(|_| runtime::unavailable())?,
            true,
        )?;
        check_cancel(&permit.cancel)?;
        reset_resources(&state)?;
        state.6.install(Some(repo))?;
        let opened = info_shared(&next, &state.6)?;
        *current = Some(next);
        drop(permit);
        Ok(Transition {
            opened,
            status: runtime::status(current.as_ref(), &state.6)?,
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn collaboration_identity(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
    action: IdentityAction,
) -> Result<Transition> {
    identity(&state, expected, operation_id, action).await
}
#[tauri::command]
pub fn collaboration_cancel(state: State<'_, AppState>, operation_id: String) -> Result<()> {
    state.6.cancel(&operation_id)
}

#[tauri::command]
pub async fn collaboration_preferences(
    state: State<'_, AppState>,
    expected: Expected,
    preferences: PlaybackPreferences,
) -> Result<Status> {
    let service = state.6.clone();
    state
        .run(move |s| {
            let p = s.as_mut().ok_or_else(runtime::stale)?;
            expected.check(
                p,
                &*service.current.lock().map_err(|_| runtime::unavailable())?,
                false,
            )?;
            p.workspace_mut()?.save_preferences(preferences)?;
            runtime::status(s.as_ref(), &service)
        })
        .await
}

pub async fn load_or_guest(
    state: &AppState,
    expected: Expected,
    operation_id: String,
    guest: bool,
) -> Result<Transition> {
    let permit = state.6.begin(operation_id)?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let permit = permit;
        let (repo, actor) = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let p = current.as_ref().ok_or_else(runtime::stale)?;
            let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            expected.check(p, &r, true)?;
            (
                r.repo.clone().ok_or_else(runtime::stale)?,
                p.workspace()?
                    .actor()
                    .cloned()
                    .ok_or_else(|| AppError::invalid("Sign in first"))?,
            )
        };
        check_cancel(&permit.cancel)?;
        let (payload, remote) = if guest {
            let cache = LocalProject::open_shared(repo.clone(), None, &state.6.local()?)?;
            (
                Some(LayerPayload::from_document(&cache.snapshot()?.document)?),
                None,
            )
        } else {
            (None, repo.read_author(&actor.author_id)?)
        };
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let p = current.as_mut().ok_or_else(runtime::stale)?;
        expected.check(
            p,
            &*state.6.current.lock().map_err(|_| runtime::unavailable())?,
            true,
        )?;
        check_cancel(&permit.cancel)?;
        if let Some(payload) = payload {
            p.publish_guest(&expected.project_id, expected.expected_revision, &payload)?;
        } else {
            p.load_shared_version(remote.as_ref())?;
            reset_resources(&state)?;
            state.6.install(Some(repo))?;
        }
        let opened = info_shared(p, &state.6)?;
        drop(permit);
        Ok(Transition {
            opened,
            status: runtime::status(current.as_ref(), &state.6)?,
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn collaboration_publish_guest(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
) -> Result<Transition> {
    load_or_guest(&state, expected, operation_id, true).await
}
#[tauri::command]
pub async fn collaboration_load_shared(
    state: State<'_, AppState>,
    expected: Expected,
    operation_id: String,
) -> Result<Transition> {
    load_or_guest(&state, expected, operation_id, false).await
}
