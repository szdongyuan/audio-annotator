//! Lifecycle-bound native permanent deletion capabilities.
use super::collaboration::{operations::converge_retirement, runtime};
use crate::state::AppState;
use annotator_core::{
    collaboration::purge::{
        journal::{PurgeBlockReason, PurgeRetained},
        transaction::PurgeSelection,
    },
    collaboration::{AuthorSession, CollaborationRepository, PublicationCapture},
    error::{AppError, ErrorCode, Result},
    media::identity::check_cancel,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

/// Local inventory populated by blocking workers, never by the status serializer.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceSnapshot {
    pub total: usize,
    pub items: Vec<MaintenanceItem>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceItem {
    pub operation_id: String,
    pub status: String,
    pub committed: bool,
    pub cleanup_pending_count: Option<usize>,
    pub cleanup_failed_count: Option<usize>,
    pub deleted_audio_bytes: Option<u64>,
}
pub(crate) fn maintenance(repo: &CollaborationRepository) -> Result<MaintenanceSnapshot> {
    use annotator_core::collaboration::purge::cleanup::MaintenanceStatus;
    let operations = repo.purge_maintenance_operations()?;
    let items: Vec<_> = operations
        .into_iter()
        .filter(|o| {
            matches!(
                o.status,
                MaintenanceStatus::Accepted
                    | MaintenanceStatus::Preparing
                    | MaintenanceStatus::RollbackPending
                    | MaintenanceStatus::CommittedPendingCleanup
            )
        })
        .map(|o| MaintenanceItem {
            operation_id: o.operation_id,
            status: match o.status {
                MaintenanceStatus::Accepted => "accepted",
                MaintenanceStatus::Preparing => "preparing",
                MaintenanceStatus::RollbackPending => "rollback-pending",
                MaintenanceStatus::CommittedPendingCleanup => "committed-pending-cleanup",
                _ => unreachable!(),
            }
            .into(),
            committed: o.committed,
            cleanup_pending_count: o.cleanup.as_ref().map(|s| s.pending_count),
            cleanup_failed_count: o.cleanup.as_ref().map(|s| s.failed_count),
            deleted_audio_bytes: o.cleanup.map(|s| s.deleted_audio_bytes),
        })
        .collect();
    Ok(MaintenanceSnapshot {
        total: items.len(),
        items: items.into_iter().take(50).collect(),
    })
}
/// Opening a writable session proves that this process owns no old publication
/// worker. Continue one operation / fifty cleanup items; never run for readonly.
pub(crate) fn resume_on_open(
    repo: &CollaborationRepository,
    actor: &AuthorSession,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    use annotator_core::collaboration::purge::cleanup::MaintenanceStatus;
    let operations = repo.purge_maintenance_operations()?;
    if let Some(operation) = operations.iter().find(|o| {
        o.legacy_attempt
            && matches!(
                o.status,
                MaintenanceStatus::Preparing | MaintenanceStatus::RollbackPending
            )
    }) {
        check_cancel(cancel)?;
        repo.recover_legacy_upgrade_drained(&operation.operation_id, actor)?;
    }
    if let Some(operation) = operations
        .iter()
        .find(|o| o.committed && o.cleanup.as_ref().is_some_and(|s| !s.complete))
    {
        check_cancel(cancel)?;
        repo.acknowledge_purge_staging_drained(actor, &operation.operation_id)?;
        repo.retry_purge_cleanup_controlled(actor, &operation.operation_id, 50, cancel, |_, _| {
            Ok(())
        })?;
    }
    Ok(())
}
fn store_maintenance(
    state: &AppState,
    args: &OperationArgs,
    inventory: MaintenanceSnapshot,
) -> Result<()> {
    let current = state.0.lock().map_err(|_| runtime::unavailable())?;
    let mut r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
    if r.nonce == args.runtime_nonce
        && current.as_ref().is_some_and(|p| {
            p.workspace()
                .is_ok_and(|w| w.manifest().project_id == args.project_id)
        })
    {
        r.purge_maintenance = inventory;
    }
    Ok(())
}
fn diagnostic(state: &AppState, args: &OperationArgs, error: AppError) -> Result<()> {
    let current = state.0.lock().map_err(|_| runtime::unavailable())?;
    let mut r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
    if r.nonce == args.runtime_nonce
        && current.as_ref().is_some_and(|p| {
            p.workspace()
                .is_ok_and(|w| w.manifest().project_id == args.project_id)
        })
    {
        r.error = Some(error);
    }
    Ok(())
}
fn committed_error(mut error: AppError, args: &OperationArgs) -> AppError {
    error.details = Some(
        serde_json::json!({"purgeCommitted":true,"operationId":args.operation_id,"projectId":args.project_id,"runtimeNonce":args.runtime_nonce,"cause":error.details}),
    );
    error
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewArgs {
    pub runtime_nonce: String,
    pub project_id: String,
    pub operation_id: String,
    pub selection: PurgeSelection,
    pub offset: usize,
    pub limit: usize,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitArgs {
    pub runtime_nonce: String,
    pub project_id: String,
    pub operation_id: String,
    pub preview_id: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationArgs {
    pub runtime_nonce: String,
    pub project_id: String,
    pub operation_id: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageArgs {
    pub runtime_nonce: String,
    pub project_id: String,
    pub operation_id: String,
    pub offset: usize,
    pub limit: usize,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub media_id: String,
    pub display_name: String,
    pub reason: Option<PurgeBlockReason>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgePreview {
    pub preview_id: String,
    pub operation_id: String,
    pub project_id: String,
    pub runtime_nonce: String,
    pub requested_count: usize,
    pub eligible_count: usize,
    pub retained_count: usize,
    pub other_author_retained_count: usize,
    pub audio_bytes: u64,
    pub requires_format_upgrade: bool,
    pub items: Vec<PreviewItem>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub operation_id: String,
    pub project_id: String,
    pub runtime_nonce: String,
    pub status: String,
    pub removed_ids: Vec<String>,
    pub retained: Vec<PurgeRetained>,
    pub deleted_audio_bytes: u64,
    pub cleanup_pending_count: usize,
    pub cleanup_failed_count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub cleanup_id: String,
    pub media_id: Option<String>,
    pub display_name: String,
    pub kind: annotator_core::collaboration::purge::cleanup::CleanupKind,
    pub status: String,
    pub error: Option<AppError>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeCleanupPage {
    pub operation_id: String,
    pub project_id: String,
    pub runtime_nonce: String,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub items: Vec<CleanupItem>,
}
pub struct Capability {
    id: String,
    selection: PurgeSelection,
    native: annotator_core::collaboration::purge::transaction::PurgePreview,
    projection: PurgePreview,
}
#[derive(Default)]
pub struct Capabilities {
    entries: HashMap<String, Arc<Capability>>,
}
impl Capabilities {
    pub(crate) fn cancel(&mut self, operation: &str) {
        self.entries.remove(operation);
    }
}

fn uuid(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).is_ok_and(|v| !v.is_nil() && v.to_string() == value) {
        Ok(())
    } else {
        Err(AppError::invalid("Invalid canonical purge UUID"))
    }
}
fn pagination(offset: usize, limit: usize) -> Result<()> {
    if (1..=50).contains(&limit) && offset <= 9_007_199_254_740_991 {
        Ok(())
    } else {
        Err(AppError::invalid(
            "Purge page limit must be 1..50 and offset a safe integer",
        ))
    }
}
struct Capture {
    repo: Arc<CollaborationRepository>,
    actor: Option<Arc<AuthorSession>>,
    expected: runtime::Expected,
}
fn capture(state: &AppState, nonce: &str, project_id: &str, write: bool) -> Result<Capture> {
    uuid(nonce)?;
    uuid(project_id)?;
    let current = state.0.lock().map_err(|_| runtime::unavailable())?;
    let p = current.as_ref().ok_or_else(runtime::stale)?;
    let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
    let w = p.workspace()?;
    if r.nonce != nonce || w.manifest().project_id != project_id {
        return Err(runtime::stale());
    }
    if write && p.recovery().is_some() {
        return Err(AppError::invalid(
            "Resolve project recovery before permanent deletion",
        ));
    }
    let actor = w.author_session();
    if write && actor.is_none() {
        return Err(AppError::invalid(
            "Permanent deletion requires a writable author",
        ));
    }
    let revision = if write {
        p.snapshot()?.document.revision
    } else {
        w.envelope().document.revision
    };
    Ok(Capture {
        repo: r.repo.clone().ok_or_else(runtime::stale)?,
        actor,
        expected: runtime::Expected {
            runtime_nonce: nonce.into(),
            project_id: project_id.into(),
            expected_revision: revision,
        },
    })
}
fn same_actor(c: &Capture, actor: &Arc<AuthorSession>) -> Result<()> {
    if c.actor
        .as_ref()
        .is_some_and(|live| Arc::ptr_eq(live, actor))
    {
        Ok(())
    } else {
        Err(runtime::stale())
    }
}
// Frontend lifecycle admission flushes accepted input and saves before entering.
// This native single-flight worker drains durable publication and refuses dirty
// or failed local state; it never silently drops accepted edits.
fn drain(state: &AppState, c: &Capture) -> Result<()> {
    let publication = {
        let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let p = current.as_mut().ok_or_else(runtime::stale)?;
        let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
        c.expected.check(p, &r, true)?;
        p.workspace_mut()?.prepare_publication()?
    };
    let ack = publication.map(PublicationCapture::publish).transpose()?;
    let mut current = state.0.lock().map_err(|_| runtime::unavailable())?;
    let p = current.as_mut().ok_or_else(runtime::stale)?;
    let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
    c.expected.check(p, &r, true)?;
    if let Some(ack) = ack {
        p.workspace_mut()?.acknowledge(ack)?;
    }
    Ok(())
}
fn stored_page(cap: &Capability, offset: usize, limit: usize) -> PurgePreview {
    let mut page = cap.projection.clone();
    page.items = page.items.into_iter().skip(offset).take(limit).collect();
    page
}
pub(crate) async fn preview(state: &AppState, mut args: PreviewArgs) -> Result<PurgePreview> {
    uuid(&args.operation_id)?;
    pagination(args.offset, args.limit)?;
    if let PurgeSelection::Selected(ids) = &mut args.selection {
        ids.sort();
    }
    let permit = state.6.begin(args.operation_id.clone())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let c = capture(&state, &args.runtime_nonce, &args.project_id, true)?;
        let actor = c.actor.clone().ok_or_else(runtime::stale)?;
        if let Some(cap) = state
            .6
            .purge
            .lock()
            .map_err(|_| runtime::unavailable())?
            .entries
            .get(&args.operation_id)
            .cloned()
        {
            if cap.selection != args.selection
                || cap.native.runtime() != args.runtime_nonce
                || cap.native.project_id() != args.project_id
                || cap.native.actor_id() != actor.identity().author_id
            {
                return Err(runtime::stale());
            }
            return Ok(stored_page(&cap, args.offset, args.limit));
        }
        if args.offset != 0 {
            return Err(AppError::invalid("Start purge preview at offset zero"));
        }
        drain(&state, &c)?;
        check_cancel(&_permit.cancel)?;
        let native = c.repo.preview_purge(
            &actor,
            &args.runtime_nonce,
            &args.operation_id,
            args.selection.clone(),
        )?;
        let mut audio_bytes = 0u64;
        let items = native
            .requested_ids()
            .iter()
            .map(|id| {
                let reason = native
                    .retained()
                    .iter()
                    .find(|r| &r.media_id == id)
                    .map(|r| r.reason);
                let media = native.media().iter().find(|m| &m.id == id);
                if reason.is_none() {
                    audio_bytes = audio_bytes.saturating_add(media.map_or(0, |m| m.byte_length));
                }
                PreviewItem {
                    media_id: id.clone(),
                    display_name: media.map_or_else(|| id.clone(), |m| m.display_name.clone()),
                    reason,
                }
            })
            .collect();
        if audio_bytes > 9_007_199_254_740_991 {
            return Err(AppError::invalid("Purge byte count exceeds safe integer"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let projection = PurgePreview {
            preview_id: id.clone(),
            operation_id: args.operation_id.clone(),
            project_id: args.project_id.clone(),
            runtime_nonce: args.runtime_nonce.clone(),
            requested_count: native.requested_ids().len(),
            eligible_count: native.eligible_count(),
            retained_count: native.retained().len(),
            other_author_retained_count: native
                .retained()
                .iter()
                .filter(|r| r.reason == PurgeBlockReason::OtherAuthorAnnotation)
                .count(),
            audio_bytes,
            requires_format_upgrade: native.source_format() == 5 && native.eligible_count() > 0,
            items,
        };
        let cap = Arc::new(Capability {
            id,
            selection: args.selection,
            native,
            projection,
        });
        #[cfg(test)]
        {
            let hook = state.6.after_io.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        // Install the capability while holding the same instance guard used by
        // project replacement. A separate validation followed by insertion can
        // otherwise put an old capability into the replacement service.
        let current = state.0.lock().map_err(|_| runtime::unavailable())?;
        let project = current.as_ref().ok_or_else(runtime::stale)?;
        let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
        c.expected.check(project, &r, true)?;
        if project.recovery().is_some()
            || !project
                .workspace()?
                .author_session()
                .is_some_and(|live| Arc::ptr_eq(&live, &actor))
        {
            return Err(runtime::stale());
        }
        #[cfg(test)]
        state.6.run_hook();
        let mut store = state.6.purge.lock().map_err(|_| runtime::unavailable())?;
        // Cancel sets the flag before removing from this same store. Either it
        // prevents insertion here or removes our entry after we release the lock.
        check_cancel(&_permit.cancel)?;
        if store.entries.len() >= 16 {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "Too many native purge previews; reopen the project",
            ));
        }
        store.entries.insert(args.operation_id, cap.clone());
        Ok(stored_page(&cap, args.offset, args.limit))
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
fn outcome(
    args: &OperationArgs,
    result: annotator_core::collaboration::purge::transaction::PurgeResult,
    summary: Option<annotator_core::collaboration::purge::cleanup::CleanupSummary>,
) -> PurgeResult {
    let status = if !result.committed {
        "no-eligible-items"
    } else if summary.as_ref().is_some_and(|s| s.complete) {
        "complete"
    } else {
        "committed-pending-cleanup"
    };
    PurgeResult {
        operation_id: args.operation_id.clone(),
        project_id: args.project_id.clone(),
        runtime_nonce: args.runtime_nonce.clone(),
        status: status.into(),
        removed_ids: result.removed_ids,
        retained: result.retained,
        deleted_audio_bytes: summary.as_ref().map_or(0, |s| s.deleted_audio_bytes),
        cleanup_pending_count: summary.as_ref().map_or(0, |s| s.pending_count),
        cleanup_failed_count: summary.as_ref().map_or(0, |s| s.failed_count),
    }
}
pub(crate) async fn commit(state: &AppState, args: CommitArgs) -> Result<PurgeResult> {
    uuid(&args.operation_id)?;
    uuid(&args.preview_id)?;
    let permit = state.6.begin(args.operation_id.clone())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = capture(&state, &args.runtime_nonce, &args.project_id, true)?;
        let actor = c.actor.clone().ok_or_else(runtime::stale)?;
        let cap = state
            .6
            .purge
            .lock()
            .map_err(|_| runtime::unavailable())?
            .entries
            .get(&args.operation_id)
            .cloned()
            .ok_or_else(|| AppError::invalid("Unknown native purge preview"))?;
        if cap.id != args.preview_id
            || cap.native.actor_id() != actor.identity().author_id
            || cap.native.runtime() != args.runtime_nonce
            || cap.native.project_id() != args.project_id
        {
            return Err(runtime::stale());
        }
        drain(&state, &c)?;
        let result = c.repo.commit_purge_guarded_controlled(
            &actor,
            &args.runtime_nonce,
            &cap.native,
            &permit.cancel,
            |_| Ok(()),
            |_| Ok(()),
            || {
                #[cfg(test)]
                state.6.run_hook();
                check_cancel(&permit.cancel)?;
                let current = state.0.lock().map_err(|_| runtime::unavailable())?;
                let p = current.as_ref().ok_or_else(runtime::stale)?;
                let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
                c.expected.check(p, &r, true)?;
                if p.recovery().is_some()
                    || !p
                        .workspace()?
                        .author_session()
                        .is_some_and(|live| Arc::ptr_eq(&live, &actor))
                {
                    return Err(runtime::stale());
                }
                drop(r);
                Ok(current)
            },
        )?;
        #[cfg(test)]
        {
            let hook = state.6.after_io.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
        let op = OperationArgs {
            runtime_nonce: args.runtime_nonce,
            project_id: args.project_id,
            operation_id: args.operation_id,
        };
        if !result.committed {
            store_maintenance(&state, &op, maintenance(&c.repo)?)?;
            return Ok(outcome(&op, result, None));
        }
        // Never roll back an acknowledged entry switch, including late cancel or
        // replacement. Only the original current instance receives new authority.
        let fresh =
            CollaborationRepository::open(c.repo.root()).map_err(|e| committed_error(e, &op))?;
        let installed = (|| {
            let binding = {
                let current = state.0.lock().map_err(|_| runtime::unavailable())?;
                let r = state.6.current.lock().map_err(|_| runtime::unavailable())?;
                if r.nonce != op.runtime_nonce {
                    None
                } else {
                    let p = current.as_ref().ok_or_else(runtime::stale)?;
                    let document = p.snapshot()?.document;
                    if document.project_id != op.project_id {
                        return Err(runtime::stale());
                    }
                    // Fence workers immediately, even if private projection I/O
                    // later fails. This operation already has permanent authority.
                    state.retire_media_resources(&result.removed_ids)?;
                    state.3.retire_media(&result.removed_ids);
                    Some(runtime::Expected {
                        runtime_nonce: r.nonce.clone(),
                        project_id: document.project_id,
                        expected_revision: document.revision,
                    })
                }
            };
            if let Some(binding) = binding {
                converge_retirement(&state, &binding)?;
            }
            Ok(())
        })();
        let maintenance_result = installed.and_then(|_| {
            fresh.acknowledge_purge_staging_drained(&actor, &op.operation_id)?;
            if !permit.cancel.load(std::sync::atomic::Ordering::Acquire) {
                fresh.retry_purge_cleanup_controlled(
                    &actor,
                    &op.operation_id,
                    50,
                    &permit.cancel,
                    |_, _| Ok(()),
                )?;
            }
            Ok(())
        });
        // External postcommit I/O can fail or be cancelled. Preserve the receipt,
        // persist/return outstanding work and retain the diagnostic for this
        // instance. Never turn these failures into a rollback or an empty result.
        if let Some(error) = result
            .maintenance_error
            .clone()
            .or_else(|| maintenance_result.err())
        {
            diagnostic(&state, &op, committed_error(error, &op))?;
        }
        let summary = fresh
            .purge_cleanup_summary(&op.operation_id)
            .map_err(|e| committed_error(e, &op))?;
        store_maintenance(
            &state,
            &op,
            maintenance(&fresh).map_err(|e| committed_error(e, &op))?,
        )?;
        Ok(outcome(&op, result, Some(summary)))
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
pub(crate) async fn retry(state: &AppState, args: OperationArgs) -> Result<PurgeResult> {
    uuid(&args.operation_id)?;
    let permit = state.6.begin(args.operation_id.clone())?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = capture(&state, &args.runtime_nonce, &args.project_id, true)?;
        let actor = c.actor.clone().ok_or_else(runtime::stale)?;
        drain(&state, &c)?;
        converge_retirement(&state, &c.expected)?;
        let repo = CollaborationRepository::open(c.repo.root())?;
        let result = repo
            .purge_committed_result(&args.operation_id)?
            .ok_or_else(|| AppError::invalid("Operation has no committed purge receipt"))?;
        repo.acknowledge_purge_staging_drained(&actor, &args.operation_id)?;
        let attempt = repo.retry_purge_cleanup_controlled(
            &actor,
            &args.operation_id,
            50,
            &permit.cancel,
            |_, _| {
                let live = capture(&state, &args.runtime_nonce, &args.project_id, true)?;
                same_actor(&live, &actor)
            },
        );
        if let Err(error) = attempt {
            diagnostic(&state, &args, committed_error(error, &args))?;
        }
        let summary = repo.purge_cleanup_summary(&args.operation_id)?;
        store_maintenance(&state, &args, maintenance(&repo)?)?;
        Ok(outcome(&args, result, Some(summary)))
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
pub(crate) async fn page(state: &AppState, args: PageArgs) -> Result<PurgeCleanupPage> {
    uuid(&args.operation_id)?;
    pagination(args.offset, args.limit)?;
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = capture(&state, &args.runtime_nonce, &args.project_id, false)?;
        let page = c
            .repo
            .purge_cleanup_page(&args.operation_id, args.offset, args.limit)?;
        let inventory = maintenance(&c.repo)?;
        capture(&state, &args.runtime_nonce, &args.project_id, false)?;
        store_maintenance(
            &state,
            &OperationArgs {
                runtime_nonce: args.runtime_nonce.clone(),
                project_id: args.project_id.clone(),
                operation_id: args.operation_id.clone(),
            },
            inventory,
        )?;
        Ok(PurgeCleanupPage {
            operation_id: args.operation_id,
            project_id: args.project_id,
            runtime_nonce: args.runtime_nonce,
            total: page.total,
            offset: page.offset,
            limit: page.limit,
            items: page
                .items
                .into_iter()
                .map(|i| CleanupItem {
                    cleanup_id: i.cleanup_id,
                    media_id: i.media_id,
                    display_name: i.display_name,
                    kind: i.kind,
                    status: if i.error.is_some() {
                        "failed"
                    } else {
                        "pending"
                    }
                    .into(),
                    error: i.error,
                })
                .collect(),
        })
    })
    .await
    .map_err(|_| runtime::unavailable())?
}
#[tauri::command]
pub async fn purge_preview(
    state: tauri::State<'_, AppState>,
    args: PreviewArgs,
) -> Result<PurgePreview> {
    preview(&state, args).await
}
#[tauri::command]
pub async fn purge_commit(
    state: tauri::State<'_, AppState>,
    args: CommitArgs,
) -> Result<PurgeResult> {
    commit(&state, args).await
}
#[tauri::command]
pub async fn purge_retry_cleanup(
    state: tauri::State<'_, AppState>,
    args: OperationArgs,
) -> Result<PurgeResult> {
    retry(&state, args).await
}
#[tauri::command]
pub async fn purge_cleanup_page(
    state: tauri::State<'_, AppState>,
    args: PageArgs,
) -> Result<PurgeCleanupPage> {
    page(&state, args).await
}
#[cfg(test)]
mod tests;
