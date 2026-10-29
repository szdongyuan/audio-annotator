use super::PurgeAuthority;
use crate::{
    collaboration::{
        validation::{hash, require},
        AuthorSession, CollaborationRepository,
    },
    error::{AppError, ErrorCode, Result},
};

impl CollaborationRepository {
    /// Capture all native authors against the current catalog, including media and
    /// authors not adopted or displayed by this client. No renderer author list is used.
    pub fn purge_authority(&self, session: &AuthorSession) -> Result<PurgeAuthority> {
        self.session_authority(session)?;
        let current = self.reload_catalog()?;
        let recycle = current.read_recycle()?;
        let snapshot = current.complete_author_snapshot()?;
        require(
            recycle.trashed.iter().all(|item| {
                current
                    .manifest
                    .media
                    .iter()
                    .any(|media| media.id == item.media_id)
            }),
            "Recycle references unknown media",
        )?;
        let after = current.reload_catalog()?;
        let after_recycle = after.read_recycle()?;
        let state = serde_json::to_vec(&(
            &current.manifest_hash,
            &current.manifest,
            &current.catalog_revision,
            &current.organization,
            &recycle,
            &snapshot,
        ))
        .map_err(|_| AppError::invalid("Cannot hash purge authority"))?;
        if after.catalog_revision != current.catalog_revision
            || after.organization != current.organization
            || serde_json::to_vec(&after_recycle)
                .map_err(|_| AppError::invalid("Cannot compare recycle authority"))?
                != serde_json::to_vec(&recycle)
                    .map_err(|_| AppError::invalid("Cannot compare recycle authority"))?
        {
            return Err(AppError::new(
                ErrorCode::RevisionConflict,
                "Shared state changed while reading purge authority; retry",
            ));
        }
        current.session_authority(session)?;
        Ok(PurgeAuthority {
            actor_id: session.identity().author_id.clone(),
            state_digest: hash(&state),
            snapshot,
            recycle,
        })
    }
}
