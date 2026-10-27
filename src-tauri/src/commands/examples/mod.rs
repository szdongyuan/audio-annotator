use crate::state::AppState;
use annotator_core::{
    error::{AppError, Result},
    examples::{Entry, Library, Repository, Scope},
    project::LocalProject,
};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use tauri::State;
pub mod preview;
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Owner {
    nonce: String,
    project: String,
    actor: Option<String>,
    generation: u64,
}
fn stale() -> AppError {
    super::collaboration::runtime::stale()
}
fn actor(project: &LocalProject, selected: &Option<String>) -> Option<String> {
    match project.workspace() {
        Ok(w) => w.actor().map(|a| a.author_id.clone()),
        Err(_) => selected.clone(),
    }
}
pub(crate) fn capture(
    state: &AppState,
    nonce: &str,
    project_id: &str,
) -> Result<(Owner, Repository)> {
    // Ordinary projects also use the selected UUID profile, but never their project directory for private storage.
    let ordinary = state
        .0
        .lock()
        .map_err(|_| stale())?
        .as_ref()
        .is_some_and(|p| !p.is_shared());
    if ordinary && state.6.selected.lock().map_err(|_| stale())?.is_none() {
        state.6.selected_profile()?;
    }
    let owner = capture_owner(state, nonce, project_id)?;
    let repo = owner.with_project(state, |project| {
        Repository::new(
            project.root(),
            &state.6.local()?,
            project_id,
            owner.actor.clone(),
        )
    })?;
    Ok((owner, repo))
}
/// Memory-only capture for issuing an opening intent before its worker is queued.
pub(crate) fn capture_owner(state: &AppState, nonce: &str, project_id: &str) -> Result<Owner> {
    let project = state.0.lock().map_err(|_| stale())?;
    let project = project.as_ref().ok_or_else(stale)?;
    let runtime = state.6.current.lock().map_err(|_| stale())?;
    if runtime.nonce != nonce || project.snapshot()?.document.project_id != project_id {
        return Err(stale());
    }
    let selected = state.6.selected.lock().map_err(|_| stale())?;
    Ok(Owner {
        nonce: nonce.into(),
        project: project_id.into(),
        actor: actor(project, &selected),
        generation: state.1.lock().map_err(|_| stale())?.generation(),
    })
}

impl Owner {
    pub(crate) fn check(&self, state: &AppState) -> Result<()> {
        self.with_current(state, || Ok(()))
    }
    pub(crate) fn with_current<T>(
        &self,
        state: &AppState,
        f: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.with_project(state, |_| f())
    }
    fn with_project<T>(
        &self,
        state: &AppState,
        f: impl FnOnce(&LocalProject) -> Result<T>,
    ) -> Result<T> {
        let project = state.0.lock().map_err(|_| stale())?;
        let p = project.as_ref().ok_or_else(stale)?;
        let runtime = state.6.current.lock().map_err(|_| stale())?;
        let selected = state.6.selected.lock().map_err(|_| stale())?;
        if runtime.nonce != self.nonce
            || p.snapshot()?.document.project_id != self.project
            || actor(p, &selected) != self.actor
            || state.1.lock().map_err(|_| stale())?.generation() != self.generation
        {
            return Err(stale());
        }
        f(p)
    }
}
fn entry(repo: &Repository, scope: Scope, creator: &str, sample: &str) -> Result<Entry> {
    repo.get(scope, creator, sample)
}
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| AppError::invalid("示例任务中断"))?
}
#[tauri::command]
pub async fn examples_list(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    scope: Scope,
) -> Result<Library> {
    let state = state.inner().clone();
    blocking(move || {
        let (owner, repo) = capture(&state, &runtime_nonce, &project_id)?;
        let list = repo.list(scope)?;
        owner.check(&state)?;
        Ok(list)
    })
    .await
}
#[tauri::command]
pub async fn examples_import(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    scope: Scope,
    path: String,
    name: String,
    expected_revision: u64,
) -> Result<Entry> {
    let state = state.inner().clone();
    blocking(move || {
        import_owned(
            &state,
            &runtime_nonce,
            &project_id,
            scope,
            Path::new(&path),
            &name,
            expected_revision,
        )
    })
    .await
}
fn import_owned(
    state: &AppState,
    nonce: &str,
    project: &str,
    scope: Scope,
    path: &Path,
    name: &str,
    revision: u64,
) -> Result<Entry> {
    let _permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    let (owner, repo) = capture(state, nonce, project)?;
    let pending = repo.prepare(scope, path, name)?;
    #[cfg(test)]
    state.6.run_hook();
    owner.with_current(state, || repo.commit(pending, revision))
}
#[tauri::command]
pub async fn examples_from_project(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    scope: Scope,
    media_id: String,
    name: String,
    expected_revision: u64,
) -> Result<Entry> {
    let state = state.inner().clone();
    blocking(move || {
        let _permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
        let (owner, repo) = capture(&state, &runtime_nonce, &project_id)?;
        let (descriptor, root) = owner.with_current(&state, || Ok(())).and_then(|_| {
            let p = state.0.lock().map_err(|_| stale())?;
            let p = p.as_ref().ok_or_else(stale)?;
            let document = p.snapshot()?.document;
            if document.project_id != owner.project {
                return Err(stale());
            }
            let media = document
                .media
                .into_iter()
                .find(|m| m.id == media_id)
                .ok_or_else(|| AppError::invalid("未知项目音频"))?;
            Ok((media, p.root().to_path_buf()))
        })?;
        let source = Path::new(&descriptor.source_ref);
        let source = if source.is_absolute() {
            source.to_path_buf()
        } else {
            root.join(source)
        };
        annotator_core::collaboration::atomic::safe_existing(&source)?;
        if annotator_core::media::identity::fingerprint(&source, &Default::default(), |_| {})?
            != descriptor.sha256
        {
            return Err(AppError::invalid("项目音频已改变"));
        }
        let pending = repo.prepare(scope, &source, &name)?;
        owner.with_current(&state, || repo.commit(pending, expected_revision))
    })
    .await
}
#[tauri::command]
pub async fn examples_rename(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    scope: Scope,
    creator_id: String,
    sample_id: String,
    name: String,
    expected_revision: u64,
) -> Result<Entry> {
    let state = state.inner().clone();
    blocking(move || {
        let (owner, repo) = capture(&state, &runtime_nonce, &project_id)?;
        let e = entry(&repo, scope, &creator_id, &sample_id)?;
        owner.with_current(&state, || repo.rename(&e, &name, expected_revision))
    })
    .await
}
#[tauri::command]
pub async fn examples_remove(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    scope: Scope,
    creator_id: String,
    sample_id: String,
    expected_revision: u64,
) -> Result<()> {
    let state = state.inner().clone();
    blocking(move || {
        let (owner, repo) = capture(&state, &runtime_nonce, &project_id)?;
        let e = entry(&repo, scope, &creator_id, &sample_id)?;
        owner.with_current(&state, || repo.remove(&e, expected_revision))
    })
    .await
}
#[tauri::command]
pub async fn examples_copy(
    state: State<'_, AppState>,
    runtime_nonce: String,
    project_id: String,
    scope: Scope,
    creator_id: String,
    sample_id: String,
    target_scope: Scope,
    expected_revision: u64,
) -> Result<Entry> {
    let state = state.inner().clone();
    blocking(move || {
        let _permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
        let (owner, repo) = capture(&state, &runtime_nonce, &project_id)?;
        let e = entry(&repo, scope, &creator_id, &sample_id)?;
        let source = repo.resolve(&e)?;
        let mut pending = repo.prepare(target_scope, &source, &e.name)?;
        pending.set_original_filename(&e.original_filename);
        #[cfg(test)]
        state.6.run_hook();
        owner.with_current(&state, || repo.commit(pending, expected_revision))
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn setup() -> (AppState, PathBuf, String, String) {
        let root = std::env::temp_dir().join(format!("native-examples-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("project")).unwrap();
        let local = root.join("local");
        let state = AppState::default();
        state.6.set_local(local).unwrap();
        *state.0.lock().unwrap() =
            Some(LocalProject::create(&root.join("project"), "Main".into()).unwrap());
        let id = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document
            .project_id;
        let nonce = state.6.current.lock().unwrap().nonce.clone();
        (state, root, id, nonce)
    }
    #[test]
    fn authority_binds_project_nonce_and_identity_without_changing_document() {
        let (state, root, project, nonce) = setup();
        let before = state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap();
        let (owner, _) = capture(&state, &nonce, &project).unwrap();
        assert!(capture(&state, "stale", &project).is_err());
        assert!(capture(&state, &nonce, &uuid::Uuid::new_v4().to_string()).is_err());
        *state.6.selected.lock().unwrap() = Some(uuid::Uuid::new_v4().to_string());
        assert!(owner.check(&state).is_err());
        assert_eq!(
            before,
            state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .snapshot()
                .unwrap()
        );
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;
    #[test]
    fn project_actor_and_nonce_changes_during_copy_never_commit() {
        for kind in ["nonce", "actor", "project"] {
            let (state, root, project, nonce) = super::tests::setup();
            let (_, repo) = capture(&state, &nonce, &project).unwrap();
            let changed = state.clone();
            let replacement = root.join("other");
            *state.6.hook.lock().unwrap() = Some(Box::new(move || match kind {
                "nonce" => {
                    changed.6.current.lock().unwrap().nonce = uuid::Uuid::new_v4().to_string()
                }
                "actor" => {
                    *changed.6.selected.lock().unwrap() = Some(uuid::Uuid::new_v4().to_string())
                }
                _ => {
                    std::fs::create_dir(&replacement).unwrap();
                    *changed.0.lock().unwrap() =
                        Some(LocalProject::create(&replacement, "Other".into()).unwrap());
                }
            }));
            let source =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio/mono16.wav");
            assert!(
                import_owned(&state, &nonce, &project, Scope::Private, &source, "OK1", 0).is_err()
            );
            assert!(repo.list(Scope::Private).unwrap().entries.is_empty());
            let mut wave_files = 0;
            let base = root.join("local/example-libraries").join(&project);
            for actor in std::fs::read_dir(base).unwrap() {
                for item in std::fs::read_dir(actor.unwrap().path()).unwrap() {
                    if item.unwrap().path().extension().is_some_and(|e| e == "wav") {
                        wave_files += 1;
                    }
                }
            }
            assert_eq!(wave_files, 0);
            drop(state);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
