use annotator_core::{
    collaboration::*,
    error::{AppError, ErrorCode, Result},
    project::LocalProject,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

type JobSlot = Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>;

pub struct Service {
    pub current: Mutex<Runtime>,
    job: JobSlot,
    local: Mutex<Option<PathBuf>>,
    #[cfg(test)]
    pub hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    pub after_io: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            current: Mutex::new(Runtime::default()),
            job: Arc::new(Mutex::new(None)),
            local: Mutex::new(None),
            #[cfg(test)]
            hook: Mutex::new(None),
            #[cfg(test)]
            after_io: Mutex::new(None),
        }
    }
}
pub struct Runtime {
    pub nonce: String,
    pub repo: Option<Arc<CollaborationRepository>>,
    pub layers: Option<RememberedLayers>,
    pub error: Option<AppError>,
    pub updated: Option<u64>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            nonce: uuid::Uuid::new_v4().to_string(),
            repo: None,
            layers: None,
            error: None,
            updated: None,
        }
    }
}
pub struct Permit {
    id: String,
    slot: JobSlot,
    pub cancel: Arc<AtomicBool>,
}
impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut job) = self.slot.lock() {
            if job.as_ref().is_some_and(|(id, _)| id == &self.id) {
                *job = None;
            }
        }
    }
}
impl Service {
    #[cfg(test)]
    pub fn run_hook(&self) {
        let hook = self.hook.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
    }
    pub fn set_local(&self, local: PathBuf) -> Result<()> {
        std::fs::create_dir_all(&local)
            .map_err(|_| AppError::invalid("Cannot create private data directory"))?;
        *self.local.lock().map_err(|_| unavailable())? = Some(local);
        Ok(())
    }
    pub fn local(&self) -> Result<PathBuf> {
        self.local
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(|| AppError::invalid("Private data directory unavailable"))
    }
    pub fn begin(&self, id: String) -> Result<Permit> {
        let mut slot = self.job.lock().map_err(|_| unavailable())?;
        if slot.is_some() {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "Collaboration job already running",
            ));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *slot = Some((id.clone(), cancel.clone()));
        Ok(Permit {
            id,
            slot: self.job.clone(),
            cancel,
        })
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        if let Some((current, cancel)) = &*self.job.lock().map_err(|_| unavailable())? {
            if current == id {
                cancel.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }
    pub fn busy(&self) -> bool {
        self.job.lock().map(|j| j.is_some()).unwrap_or(true)
    }
    pub fn retire(&self) {
        if let Ok(slot) = self.job.lock() {
            if let Some((_, cancel)) = &*slot {
                cancel.store(true, Ordering::Relaxed);
            }
        }
        if let Ok(mut runtime) = self.current.lock() {
            *runtime = Runtime::default();
        }
    }
    pub fn install(&self, repo: Option<Arc<CollaborationRepository>>) -> Result<()> {
        let mut runtime = self.current.lock().map_err(|_| unavailable())?;
        *runtime = Runtime {
            layers: repo
                .as_ref()
                .map(|r| RememberedLayers::new(r.manifest().clone())),
            repo,
            ..Runtime::default()
        };
        Ok(())
    }
}
pub fn unavailable() -> AppError {
    AppError::invalid("Collaboration service unavailable")
}
pub fn stale() -> AppError {
    AppError::new(
        ErrorCode::RevisionConflict,
        "Project or collaboration identity changed",
    )
}
pub fn check_mutation(
    project: &LocalProject,
    service: &Service,
    nonce: Option<&str>,
) -> Result<()> {
    if project.is_shared() || nonce.is_some() {
        let runtime = service.current.lock().map_err(|_| unavailable())?;
        if nonce != Some(runtime.nonce.as_str()) {
            return Err(stale());
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expected {
    pub runtime_nonce: String,
    pub project_id: String,
    pub expected_revision: u64,
}
impl Expected {
    pub fn check(&self, project: &LocalProject, runtime: &Runtime, saved: bool) -> Result<()> {
        let d = project.snapshot()?.document;
        if runtime.nonce != self.runtime_nonce
            || d.project_id != self.project_id
            || d.revision != self.expected_revision
        {
            return Err(stale());
        }
        if saved && project.persisted_revision() != d.revision {
            return Err(AppError::new(
                ErrorCode::SaveFailed,
                "Save the current project first",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub format_version: u32,
    pub runtime_nonce: String,
    pub project_id: Option<String>,
    pub shared: bool,
    pub actor: Option<AuthorIdentity>,
    pub preferences: Option<PlaybackPreferences>,
    pub pending: bool,
    pub recovery_required: bool,
    pub busy: bool,
    pub last_success_ms: Option<u64>,
    pub error: Option<AppError>,
    pub snapshot: Option<CollaborationSnapshot>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub runtime_nonce: String,
    pub actor: Option<AuthorIdentity>,
    pub preferences: Option<PlaybackPreferences>,
}
pub fn status(project: Option<&LocalProject>, service: &Service) -> Result<Status> {
    let r = service.current.lock().map_err(|_| unavailable())?;
    let workspace = project.and_then(|p| p.workspace().ok());
    Ok(Status {
        format_version: 1,
        runtime_nonce: r.nonce.clone(),
        project_id: project
            .and_then(|p| p.snapshot().ok().map(|s| s.document.project_id))
            .or_else(|| workspace.map(|w| w.manifest().project_id.clone())),
        shared: workspace.is_some(),
        actor: workspace.and_then(|w| w.actor().cloned()),
        preferences: workspace.map(|w| w.preferences().clone()),
        pending: workspace.is_some_and(|w| w.actor().is_some() && w.envelope().pending.is_some()),
        recovery_required: project.is_some_and(|p| p.recovery().is_some()),
        busy: service.busy(),
        last_success_ms: r.updated,
        error: workspace
            .and_then(|w| w.sync_error().cloned())
            .or_else(|| r.error.clone()),
        snapshot: r.layers.as_ref().map(|l| l.snapshot().clone()),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn retired_jobs_keep_the_single_flight_slot_until_the_worker_exits() {
        let runtime = super::Service::default();
        let first = runtime.begin("first".into()).unwrap();
        runtime.retire();
        assert!(runtime.begin("second".into()).is_err());
        drop(first);
        assert!(runtime.begin("second".into()).is_ok());
    }
}
