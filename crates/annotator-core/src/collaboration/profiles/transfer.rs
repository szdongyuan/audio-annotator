//! Portable identity metadata has a distinct format and cannot contain project/private data.
use super::{Profile, MAX_TRANSFER_BYTES, PROFILE_FORMAT_VERSION};
use crate::{
    collaboration::validation::{limit, require},
    error::{AppError, ErrorCode, Result},
};
use serde::{Deserialize, Serialize};

pub const TRANSFER_KIND: &str = "annotator.portable-profile";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableProfile {
    kind: String,
    format_version: u32,
    profile: Profile,
}

pub fn parse_transfer(bytes: &[u8]) -> Result<Profile> {
    limit(bytes.len() <= MAX_TRANSFER_BYTES)?;
    // Deserialize from the original bytes so duplicate keys cannot be collapsed.
    let portable: PortableProfile = serde_json::from_slice(bytes)
        .map_err(|_| AppError::invalid("Invalid portable profile structure"))?;
    require(
        portable.kind == TRANSFER_KIND,
        "Invalid portable profile kind",
    )?;
    if portable.format_version != PROFILE_FORMAT_VERSION {
        return Err(AppError::new(
            ErrorCode::UnsupportedVersion,
            "Unsupported portable profile version",
        ));
    }
    portable.profile.validate()?;
    Ok(portable.profile)
}

pub fn encode_transfer(profile: &Profile) -> Result<Vec<u8>> {
    profile.validate()?;
    let bytes = serde_json::to_vec(&PortableProfile {
        kind: TRANSFER_KIND.into(),
        format_version: PROFILE_FORMAT_VERSION,
        profile: profile.clone(),
    })
    .map_err(|_| AppError::invalid("Cannot encode portable profile"))?;
    limit(bytes.len() <= MAX_TRANSFER_BYTES)?;
    Ok(bytes)
}

pub fn read_transfer(path: &std::path::Path) -> Result<Profile> {
    parse_transfer(&crate::collaboration::atomic::read(
        path,
        MAX_TRANSFER_BYTES,
    )?)
}
