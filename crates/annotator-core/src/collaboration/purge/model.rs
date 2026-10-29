use super::policy;
use crate::collaboration::{recycle::Recycle, CollaborationSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    Allowed,
    OtherAuthorAnnotation,
    NotInRecycle,
}

/// Validated native source state, never a caller-constructed deletion permission.
/// Commit must recapture and validate authority at its own shared commit boundary.
/// No Deserialize, Clone, or public constructor.
pub struct PurgeAuthority {
    pub(super) actor_id: String,
    pub(super) state_digest: String,
    pub(super) snapshot: CollaborationSnapshot,
    pub(super) recycle: Recycle,
}

impl PurgeAuthority {
    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }
    pub fn project_id(&self) -> &str {
        &self.snapshot.project_id
    }
    pub fn state_digest(&self) -> &str {
        &self.state_digest
    }
    pub fn snapshot(&self) -> &CollaborationSnapshot {
        &self.snapshot
    }
    pub fn classify(&self, media_id: &str) -> Eligibility {
        policy::classify_layers(
            &self.actor_id,
            media_id,
            self.recycle
                .trashed
                .iter()
                .any(|item| item.media_id == media_id),
            self.snapshot.authors.iter().filter_map(|author| {
                author
                    .layer
                    .as_ref()
                    .map(|layer| (author.identity.author_id.as_str(), &layer.payload))
            }),
        )
    }
}
