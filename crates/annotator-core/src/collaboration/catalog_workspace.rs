//! Additive catalog projection preserves private content and exact publication payloads.
use super::{validation::require, CollaborationManifest, LayerPayload};
use crate::{error::Result, model::ProjectDocument};

pub(crate) fn validate_extension(
    old: &CollaborationManifest,
    new: &CollaborationManifest,
) -> Result<()> {
    require(
        old.kind == new.kind
            && old.format_version == new.format_version
            && old.project_id == new.project_id
            && old.name == new.name
            && old.created_at == new.created_at,
        "Catalog project identity changed",
    )?;
    require(
        old.media.iter().all(|m| new.media.iter().any(|n| n == m)),
        "Previously loaded catalog media changed or disappeared",
    )?;
    require(
        old.format_version == crate::collaboration::CURRENT_COLLABORATION_FORMAT || old == new,
        "Legacy catalog is immutable",
    )
}

pub(crate) fn extend_document(
    document: &mut ProjectDocument,
    manifest: &CollaborationManifest,
) -> Result<()> {
    document.validate()?;
    require(
        document.project_id == manifest.project_id
            && document.name == manifest.name
            && document.created_at == manifest.created_at,
        "Private catalog identity mismatch",
    )?;
    require(
        manifest.format_version == crate::collaboration::CURRENT_COLLABORATION_FORMAT
            || document.media.len() == manifest.media.len(),
        "Legacy catalog is immutable",
    )?;
    for local in &document.media {
        require(
            manifest.media.iter().any(|public| {
                local.id == public.id
                    && local.display_name == public.display_name
                    && crate::media::registry::same_identity(local, &public.descriptor())
            }),
            "Private media catalog changed",
        )?;
    }
    // UUID sorting is not insertion order. Look up every identity instead of zipping a prefix.
    let mut media = Vec::with_capacity(manifest.media.len());
    for public in &manifest.media {
        if let Some(local) = document.media.iter().find(|m| m.id == public.id) {
            media.push(local.clone());
        } else {
            media.push(public.descriptor());
            document
                .analysis
                .insert(public.id.clone(), Default::default());
            document
                .playback_mix
                .insert(public.id.clone(), Default::default());
        }
    }
    document.media = media;
    document.validate()
}

/// Comparison only: never normalize a confirmed, pending, or admitted payload in storage.
pub(crate) fn equivalent(
    a: &LayerPayload,
    b: &LayerPayload,
    manifest: &CollaborationManifest,
) -> Result<bool> {
    if manifest.format_version != crate::collaboration::CURRENT_COLLABORATION_FORMAT {
        return Ok(a == b);
    }
    Ok(a.project(manifest)? == b.project(manifest)?)
}
