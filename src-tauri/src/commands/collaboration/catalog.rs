use super::{
    operations::Transition,
    runtime::{self, Expected, Service},
};
use crate::{commands::project::info_shared, state::AppState};
use annotator_core::{
    collaboration::*,
    error::{AppError, Result},
    media::{
        decode::DecodedMedia,
        identity::{check_cancel, SourceStamp},
    },
    model::MediaDescriptor,
    project::ProjectSnapshot,
};
use std::sync::Arc;

pub struct PendingMedia {
    nonce: String,
    task: String,
    prepared: Arc<RetainedMedia>,
}
struct RetainedMedia {
    prepared: PreparedCatalogMedia,
    _source: Option<annotator_core::media::import_source::StagedAudio>,
}
impl std::ops::Deref for RetainedMedia {
    type Target = PreparedCatalogMedia;
    fn deref(&self) -> &Self::Target {
        &self.prepared
    }
}
pub fn store_prepared(
    service: &Service,
    nonce: &str,
    task: &str,
    prepared: PreparedCatalogMedia,
) -> Result<MediaDescriptor> {
    store_prepared_source(service, nonce, task, prepared, None)
}
pub fn store_prepared_source(
    service: &Service,
    nonce: &str,
    task: &str,
    prepared: PreparedCatalogMedia,
    source: Option<annotator_core::media::import_source::StagedAudio>,
) -> Result<MediaDescriptor> {
    let runtime = service.current.lock().map_err(|_| runtime::unavailable())?;
    if runtime.nonce != nonce {
        return Err(runtime::stale());
    }
    let mut pending = service
        .prepared
        .lock()
        .map_err(|_| runtime::unavailable())?;
    if service
        .prepared_count
        .load(std::sync::atomic::Ordering::Acquire)
        >= 256
    {
        return Err(AppError::new(
            annotator_core::error::ErrorCode::ResourceLimit,
            "Too many prepared media",
        ));
    }
    let descriptor = prepared.decoded().descriptor.clone();
    if pending.contains_key(&descriptor.id) {
        return Err(AppError::invalid("Prepared UUID already registered"));
    }
    service
        .prepared_count
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    pending.insert(
        descriptor.id.clone(),
        PendingMedia {
            nonce: nonce.into(),
            task: task.into(),
            prepared: Arc::new(RetainedMedia {
                prepared,
                _source: source,
            }),
        },
    );
    Ok(descriptor)
}
pub fn release(service: &Service, task: &str, media: &str) -> Result<()> {
    let mut pending = service
        .prepared
        .lock()
        .map_err(|_| runtime::unavailable())?;
    if pending.get(media).is_some_and(|p| p.task == task) {
        if let Some(item) = pending.remove(media) {
            service.dispose(item);
        }
    }
    Ok(())
}
pub fn can_import(project: &annotator_core::project::LocalProject) -> bool {
    !project.is_shared()
        || project.workspace().is_ok_and(|w| {
            w.manifest().format_version
                == annotator_core::collaboration::CURRENT_COLLABORATION_FORMAT
                && w.actor().is_some()
        })
}
pub async fn import(
    state: &AppState,
    expected: Expected,
    descriptor: MediaDescriptor,
) -> Result<ProjectSnapshot> {
    let permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || import_worker(state, expected, descriptor, permit))
        .await
        .map_err(|_| runtime::unavailable())?
}
pub async fn import_batch(
    state: &AppState,
    expected: Expected,
    descriptors: Vec<MediaDescriptor>,
) -> Result<ProjectSnapshot> {
    let permit = state.6.begin(uuid::Uuid::new_v4().to_string())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_batch_worker(state, expected, descriptors, permit)
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
fn import_worker(
    state: AppState,
    expected: Expected,
    descriptor: MediaDescriptor,
    permit: runtime::Permit,
) -> Result<ProjectSnapshot> {
    import_batch_worker(state, expected, vec![descriptor], permit)
}
fn import_batch_worker(
    state: AppState,
    expected: Expected,
    descriptors: Vec<MediaDescriptor>,
    permit: runtime::Permit,
) -> Result<ProjectSnapshot> {
    if descriptors.is_empty()
        || descriptors.len() > 256
        || descriptors
            .iter()
            .map(|m| &m.id)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != descriptors.len()
    {
        return Err(AppError::invalid("Invalid prepared batch"));
    }
    let (repo, actor, prepared) = {
        let current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let p = current.as_ref().ok_or_else(runtime::stale)?;
        let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
        let snapshot = p.snapshot()?;
        if r.nonce != expected.runtime_nonce || snapshot.document.project_id != expected.project_id
        {
            return Err(runtime::stale());
        }
        if !p.is_shared() || !can_import(p) {
            return Err(AppError::invalid("Shared media import is unavailable"));
        }
        let pending = state
            .6
            .prepared
            .lock()
            .map_err(|_| runtime::unavailable())?;
        let mut prepared = Vec::new();
        for descriptor in &descriptors {
            let item = pending.get(&descriptor.id).ok_or_else(runtime::stale)?;
            if item.nonce != expected.runtime_nonce
                || item.prepared.decoded().descriptor != *descriptor
            {
                return Err(AppError::invalid("Prepared media identity mismatch"));
            }
            prepared.push(item.prepared.clone());
        }
        if prepared.iter().all(|item| {
            snapshot.document.media.iter().any(|m| {
                m.id == item.media().id
                    && annotator_core::media::registry::same_identity(m, &item.media().descriptor())
            })
        }) {
            return Ok(snapshot);
        }
        expected.check(p, &r, false)?;
        (
            r.repo.clone().ok_or_else(runtime::stale)?,
            p.workspace()?.author_session().ok_or_else(runtime::stale)?,
            prepared,
        )
    };
    #[cfg(test)]
    state.6.run_hook();
    let before_commit = || {
        let current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let p = current.as_ref().ok_or_else(runtime::stale)?;
        expected.check(
            p,
            &*state.6.current.lock().map_err(|_| runtime::unavailable())?,
            false,
        )
    };
    let publication = if prepared.len() == 1 {
        repo.append_media_with_catalog_interleaved(
            &actor,
            &prepared[0],
            &permit.cancel,
            None,
            before_commit,
        )
        .map(|(_, repo)| repo)
    } else {
        let items: Vec<&PreparedCatalogMedia> = prepared.iter().map(|m| &m.prepared).collect();
        repo.append_media_batch_interleaved(&actor, &items, &permit.cancel, None, before_commit)
    };
    let committed_catalog = match publication {
        Ok(repo) => repo,
        Err(error) => match repo.reload_catalog() {
            Ok(current)
                if prepared
                    .iter()
                    .all(|item| current.manifest().media.iter().any(|m| m == item.media())) =>
            {
                current
            }
            _ => return Err(error),
        },
    };
    #[cfg(test)]
    {
        let hook = state.6.after_io.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
    }
    let adopted = (|| {
        let next = Arc::new(committed_catalog);
        let mut decoded = Vec::new();
        for item in &prepared {
            let committed = item.media();
            let source = repo.root().join(&committed.source_ref);
            decoded.push(Arc::new(DecodedMedia {
                descriptor: committed.descriptor(),
                source_path: source.clone(),
                stamp: SourceStamp::read(&source)?,
                pcm: item.decoded().pcm.clone(),
            }));
        }
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let p = current.as_mut().ok_or_else(runtime::stale)?;
        let mut runtime = state.6.current.lock().map_err(|_| runtime::unavailable())?;
        let before = p.snapshot()?.document;
        if runtime.nonce != expected.runtime_nonce || before.project_id != expected.project_id {
            return Err(runtime::stale());
        }
        let mut layers = runtime.layers.clone().ok_or_else(runtime::stale)?;
        layers.adopt_catalog(next.manifest().clone())?;
        let snapshot =
            p.adopt_shared_catalog(&expected.project_id, before.revision, next.clone())?;
        runtime.layers = Some(layers);
        runtime.repo = Some(next);
        runtime.catalog_pending = !runtime.deferred.is_empty();
        runtime.error = None;
        let mut tasks = state.1.lock().map_err(|_| runtime::unavailable())?;
        for media in decoded {
            tasks.registry.insert(media);
        }
        state.3.changed(&before, &snapshot.document);
        Ok(snapshot)
    })();
    adopted.map_err(|mut error: AppError| {
        error.retryable = true;
        error.details = Some(serde_json::json!({
            "catalogCommitted": true, "catalogAdoptionRequired": true,
            "mediaId": if prepared.len()==1 {Some(&prepared[0].media().id)} else {None},
            "mediaIds": prepared.iter().map(|m| &m.media().id).collect::<Vec<_>>()
        }));
        if let Ok(mut runtime) = state.6.current.lock() {
            if runtime.nonce == expected.runtime_nonce {
                runtime.catalog_pending = true;
                runtime.error = Some(error.clone());
            }
        }
        error
    })
}

/// Keep last verified display payloads for valid heads that require a later catalog.
/// Deferred payloads themselves are reread on adoption, not duplicated in long-lived state.
pub(super) fn retain_deferred(
    previous: Option<&RememberedLayers>,
    remote: &mut CatalogSnapshot,
) -> Vec<String> {
    let ids: Vec<_> = remote
        .deferred_authors
        .iter()
        .map(|l| l.author_id.clone())
        .collect();
    for author in &mut remote.snapshot.authors {
        if ids.contains(&author.identity.author_id) {
            author.layer = previous
                .and_then(|layers| {
                    layers
                        .snapshot()
                        .authors
                        .iter()
                        .find(|a| a.identity.author_id == author.identity.author_id)
                })
                .and_then(|a| a.layer.clone());
        }
    }
    ids
}

pub async fn adopt(
    state: &AppState,
    expected: Expected,
    operation_id: String,
) -> Result<Transition> {
    let permit = state.6.begin(operation_id)?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (repo, mut layers) = {
            let current = state.0.lock().map_err(|_| runtime::unavailable())?;
            let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
            expected.check(current.as_ref().ok_or_else(runtime::stale)?, &r, true)?;
            (
                r.repo.clone().ok_or_else(runtime::stale)?,
                r.layers.clone().ok_or_else(runtime::stale)?,
            )
        };
        let next = Arc::new(repo.reload_catalog()?);
        #[cfg(test)]
        state.6.run_hook();
        let mut remote = next.snapshot_with_catalog()?;
        let deferred = retain_deferred(Some(&layers), &mut remote);
        // Validate the complete proposed display state off the application lock and before
        // any durable/private adoption. Failure leaves live documents, history and layers intact.
        layers.adopt_catalog(next.manifest().clone())?;
        layers.update(remote.snapshot)?;
        check_cancel(&permit.cancel)?;
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let p = current.as_mut().ok_or_else(runtime::stale)?;
        let mut r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
        expected.check(p, &r, true)?;
        let before = p.snapshot()?.document;
        let snapshot = p.adopt_shared_catalog(
            &expected.project_id,
            expected.expected_revision,
            next.clone(),
        )?;
        r.layers = Some(layers);
        r.repo = Some(next);
        r.catalog_pending = remote.catalog_update_available;
        r.error = None;
        r.deferred = deferred;
        state.3.changed(&before, &snapshot.document);
        drop(r);
        drop(permit);
        Ok(Transition {
            opened: info_shared(p, &state.6)?,
            status: runtime::status(current.as_ref(), &state.6)?,
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn collaboration_adopt_catalog(
    state: tauri::State<'_, AppState>,
    expected: Expected,
    operation_id: String,
) -> Result<Transition> {
    adopt(&state, expected, operation_id).await
}
#[tauri::command]
pub async fn collaboration_hide_media(
    state: tauri::State<'_, AppState>,
    expected: Expected,
    media_id: String,
    hidden: bool,
) -> Result<runtime::Status> {
    let service = state.6.clone();
    state
        .run(move |s| {
            let p = s.as_mut().ok_or_else(runtime::stale)?;
            expected.check(
                p,
                &*service.current.lock().map_err(|_| runtime::unavailable())?,
                false,
            )?;
            p.workspace_mut()?.set_media_hidden(&media_id, hidden)?;
            runtime::status(s.as_ref(), &service)
        })
        .await
}

#[tauri::command]
pub async fn collaboration_hide_media_batch(
    state: tauri::State<'_, AppState>,
    expected: Expected,
    media_ids: Vec<String>,
    hidden: bool,
) -> Result<runtime::Status> {
    let service = state.6.clone();
    state
        .run(move |s| {
            let p = s.as_mut().ok_or_else(runtime::stale)?;
            expected.check(
                p,
                &*service.current.lock().map_err(|_| runtime::unavailable())?,
                false,
            )?;
            p.workspace_mut()?
                .set_media_hidden_batch(media_ids, hidden)?;
            runtime::status(s.as_ref(), &service)
        })
        .await
}
