//! Project-independent identity metadata. Profiles carry no credentials or project state.
mod store;
mod transfer;

pub use store::{
    ImportResult, ProfileMutation, ProfileSnapshot, ProfileStore, STORE_FILE_NAME, STORE_KIND,
};
pub use transfer::{encode_transfer, parse_transfer, read_transfer, TRANSFER_KIND};

use super::validation::{require, uuid};
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

pub const MAX_PROFILES: usize = 128;
pub const MAX_STORE_BYTES: usize = 1024 * 1024;
pub const MAX_TRANSFER_BYTES: usize = 4096;
pub const PROFILE_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "RawProfile")]
pub struct Profile {
    pub author_id: String,
    pub display_name: String,
    pub created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProfile {
    author_id: String,
    display_name: String,
    created_at: String,
}
impl TryFrom<RawProfile> for Profile {
    type Error = AppError;
    fn try_from(raw: RawProfile) -> Result<Self> {
        let profile = Self {
            author_id: raw.author_id,
            display_name: normalize_name(&raw.display_name)?,
            created_at: raw.created_at,
        };
        profile.validate()?;
        Ok(profile)
    }
}

pub(crate) fn normalize_name(value: &str) -> Result<String> {
    require(
        !value.chars().any(char::is_control),
        "Nickname contains control characters",
    )?;
    let value = value.trim();
    require(
        (1..=64).contains(&value.chars().count()) && value.len() <= 256,
        "Nickname must contain 1–64 characters and at most 256 UTF-8 bytes",
    )?;
    Ok(value.to_owned())
}

impl Profile {
    pub fn new(display_name: &str) -> Result<Self> {
        Ok(Self {
            author_id: uuid::Uuid::new_v4().to_string(),
            display_name: normalize_name(display_name)?,
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        })
    }
    pub fn validate(&self) -> Result<()> {
        uuid(&self.author_id)?;
        require(
            normalize_name(&self.display_name)? == self.display_name,
            "Nickname is not trimmed",
        )?;
        require(
            self.created_at.ends_with('Z')
                && chrono::DateTime::parse_from_rfc3339(&self.created_at).is_ok(),
            "Invalid UTC profile timestamp",
        )
    }
}
