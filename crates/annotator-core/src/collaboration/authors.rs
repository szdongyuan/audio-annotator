use super::{model::*, profiles::Profile, validation::*};
use crate::error::Result;

impl From<Profile> for AuthorIdentity {
    fn from(profile: Profile) -> Self {
        Self {
            author_id: profile.author_id,
            display_name: profile.display_name,
            created_at: profile.created_at,
        }
    }
}
impl AuthorRecord {
    pub fn parse(bytes: &[u8], project_id: &str) -> Result<Self> {
        let record: Self = decode(bytes, MAX_AUTHOR_BYTES, AUTHOR_KIND)?;
        uuid(&record.project_id)?;
        require(record.project_id == project_id, "Author project mismatch")?;
        Profile {
            author_id: record.identity.author_id.clone(),
            display_name: record.identity.display_name.clone(),
            created_at: record.identity.created_at.clone(),
        }
        .validate()?;
        Ok(record)
    }
}
