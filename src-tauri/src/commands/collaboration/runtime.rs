use annotator_core::{
    collaboration::*,
    error::{AppError, ErrorCode, Result},
    project::LocalProject,
};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

type JobSlot = Arc<Mutex<Option<(String, Arc<AtomicBool>)>>>;

pub struct Service {
    pub current: Mutex<Runtime>,
    pub sources: Mutex<crate::commands::source_import::Registry>,
    pub prepared: Mutex<std::collections::HashMap<String, super::catalog::PendingMedia>>,
    pub prepared_count: Arc<AtomicUsize>,
    cleanup: Mutex<Option<std::sync::mpsc::Sender<super::catalog::PendingMedia>>>,
    cleanup_worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    job: JobSlot,
    preparation: JobSlot,
    local: Mutex<Option<PathBuf>>,
    #[cfg(test)]
    pub hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    pub after_io: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl Default for Service {
    fn default() -> Self {
        let prepared_count = Arc::new(AtomicUsize::new(0));
        let count = prepared_count.clone();
        let (sender, receiver) = std::sync::mpsc::channel::<super::catalog::PendingMedia>();
        // Queue ownership is bounded by prepared_count (256 across live + retired items).
        // Slow NAS cleanup never runs under application/runtime authority locks.
        let cleanup_worker = std::thread::spawn(move || {
            for item in receiver {
                drop(item);
                count.fetch_sub(1, Ordering::AcqRel);
            }
        });
        Self {
            prepared_count,
            sources: Mutex::new(Default::default()),
            cleanup: Mutex::new(Some(sender)),
            cleanup_worker: Mutex::new(Some(cleanup_worker)),
            current: Mutex::new(Runtime::default()),
            prepared: Mutex::new(std::collections::HashMap::new()),
            job: Arc::new(Mutex::new(None)),
            preparation: Arc::new(Mutex::new(None)),
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
    pub catalog_pending: bool,
    pub deferred: Vec<String>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            nonce: uuid::Uuid::new_v4().to_string(),
            repo: None,
            layers: None,
            error: None,
            updated: None,
            catalog_pending: false,
            deferred: vec![],
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
    pub fn dispose(&self, item: super::catalog::PendingMedia) {
        if let Ok(cleanup) = self.cleanup.lock() {
            if let Some(sender) = cleanup.as_ref() {
                // The dedicated worker only drops native resources and never panics.
                let _ = sender.send(item);
            }
        }
    }
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
            let mut error = AppError::new(
                ErrorCode::ResourceLimit,
                "Collaboration job already running",
            );
            error.retryable = true;
            error.details = Some(serde_json::json!({"operationBusy":true}));
            return Err(error);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *slot = Some((id.clone(), cancel.clone()));
        Ok(Permit {
            id,
            slot: self.job.clone(),
            cancel,
        })
    }
    /// Default NAS preparation has a separate lifetime-bound slot so Ready items may
    /// publish while the admitted batch is still decoding/copying subsequent media.
    pub fn begin_preparation(&self, id: String, cancel: Arc<AtomicBool>) -> Result<Permit> {
        let mut slot = self.preparation.lock().map_err(|_| unavailable())?;
        if slot.is_some() {
            let mut error = AppError::new(
                ErrorCode::ResourceLimit,
                "A previous media preparation worker is still running",
            );
            error.retryable = true;
            error.details =
                Some(serde_json::json!({"operationBusy":true,"operationKind":"mediaPreparation"}));
            return Err(error);
        }
        *slot = Some((id.clone(), cancel.clone()));
        Ok(Permit {
            id,
            slot: self.preparation.clone(),
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
        if let Ok(mut sources) = self.sources.lock() {
            sources.reset();
        }
        for job in [&self.job, &self.preparation] {
            if let Ok(slot) = job.lock() {
                if let Some((_, cancel)) = &*slot {
                    cancel.store(true, Ordering::Relaxed);
                }
            }
        }
        if let Ok(mut runtime) = self.current.lock() {
            *runtime = Runtime::default();
            if let Ok(mut prepared) = self.prepared.lock() {
                for (_, item) in prepared.drain() {
                    self.dispose(item);
                }
            }
        }
    }
    pub fn install(&self, repo: Option<Arc<CollaborationRepository>>) -> Result<()> {
        self.sources.lock().map_err(|_| unavailable())?.reset();
        let mut runtime = self.current.lock().map_err(|_| unavailable())?;
        for (_, item) in self.prepared.lock().map_err(|_| unavailable())?.drain() {
            self.dispose(item);
        }
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
impl Drop for Service {
    fn drop(&mut self) {
        // Service shutdown is outside authority locks; drain the disposal worker before returning.
        self.cleanup
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(worker) = self
            .cleanup_worker
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = worker.join();
        }
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
pub enum ProjectFlavor {
    Ordinary,
    LegacyShared,
    Default,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentityMode {
    Ordinary,
    Guest,
    Local,
    Account,
    ViewOnly,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub project_flavor: ProjectFlavor,
    pub identity_mode: IdentityMode,
    pub can_write_annotations: bool,
    pub can_import_media: bool,
    pub hidden_media_ids: Vec<String>,
    pub catalog_pending: bool,

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
    pub project_flavor: ProjectFlavor,
    pub identity_mode: IdentityMode,
    pub can_write_annotations: bool,
    pub can_import_media: bool,
    pub hidden_media_ids: Vec<String>,
    pub catalog_pending: bool,

    pub runtime_nonce: String,
    pub actor: Option<AuthorIdentity>,
    pub preferences: Option<PlaybackPreferences>,
}
pub fn status(project: Option<&LocalProject>, service: &Service) -> Result<Status> {
    let r = service.current.lock().map_err(|_| unavailable())?;
    let workspace = project.and_then(|p| p.workspace().ok());
    Ok(Status {
        project_flavor: match workspace {
            None => ProjectFlavor::Ordinary,
            Some(w) if w.manifest().format_version == 2 => ProjectFlavor::Default,
            _ => ProjectFlavor::LegacyShared,
        },
        identity_mode: match workspace {
            None => IdentityMode::Ordinary,
            Some(w) if w.is_view_only() => IdentityMode::ViewOnly,
            Some(w) => match w.actor() {
                None => IdentityMode::Guest,
                Some(a) if a.normalized_login.starts_with("@local:") => IdentityMode::Local,
                _ => IdentityMode::Account,
            },
        },
        can_write_annotations: project.is_some() && workspace.is_none_or(|w| !w.is_view_only()),
        can_import_media: project.is_some()
            && workspace.is_none_or(|w| w.manifest().format_version == 2 && w.actor().is_some()),
        hidden_media_ids: workspace
            .map(|w| w.hidden_media_ids().to_vec())
            .unwrap_or_default(),
        catalog_pending: r.catalog_pending,
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
