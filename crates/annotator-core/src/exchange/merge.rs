//! Package imports are additive snapshots, isolated from live authors' writable layers.
use super::{ImportedProject, PortableAuthor};
use crate::{
    collaboration::{profiles::Profile, AuthorSession, CollaborationRepository, LayerPayload},
    error::{AppError, Result},
    media::{identity::check_cancel, registry::same_identity},
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::atomic::AtomicBool};

fn imported_id(project: &str, author: &str) -> String {
    let hash = Sha256::digest(format!("audio-annotator-import-v1/{project}/{author}"));
    let mut bytes: [u8; 16] = hash[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 15) | 0x80;
    bytes[8] = (bytes[8] & 63) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// Original author UUIDs stay in the portable manifest. Separate deterministic
/// snapshot UUIDs prevent an import from publishing over a live author's work.
pub fn import_authors(
    repo: &CollaborationRepository,
    source_project: &str,
    authors: &[PortableAuthor],
    media_map: &HashMap<String, String>,
    cancel: &AtomicBool,
) -> Result<()> {
    for author in authors {
        check_cancel(cancel)?;
        let profile = Profile {
            author_id: imported_id(source_project, &author.identity.author_id),
            display_name: format!(
                "{}（导入）",
                author
                    .identity
                    .display_name
                    .chars()
                    .take(60)
                    .collect::<String>()
            ),
            created_at: author.identity.created_at.clone(),
        };
        let session = repo.adopt(&profile)?;
        let head = repo.read_author(&profile.author_id)?;
        let mut incoming = author.payload.clone();
        for a in &mut incoming.annotations {
            a.region.media_id = media_map
                .get(&a.region.media_id)
                .ok_or_else(|| AppError::invalid("Missing imported media mapping"))?
                .clone();
        }
        for m in &mut incoming.media_labels {
            m.media_id = media_map
                .get(&m.media_id)
                .ok_or_else(|| AppError::invalid("Missing imported media mapping"))?
                .clone();
        }
        // Content-deduplicated source media can map multiple labels to one target.
        let mut payload = head.as_ref().map(|h| h.payload.clone()).unwrap_or_default();
        append_payload(&mut payload, incoming)?;
        payload.project(repo.manifest())?;
        if head.as_ref().is_none_or(|h| h.payload != payload) {
            repo.publish_controlled(
                &session,
                head.as_ref().map(|h| h.checkpoint()).as_ref(),
                &payload,
                None,
                Some(cancel),
            )?;
        }
    }
    Ok(())
}

fn append_payload(target: &mut LayerPayload, mut incoming: LayerPayload) -> Result<()> {
    let mut categories = HashMap::new();
    for c in incoming.categories {
        let source_id = c.id.clone();
        let existing = target
            .categories
            .iter()
            .find(|old| old.id == c.id || old.name.trim() == c.name.trim());
        let id = existing.map(|c| c.id.clone()).unwrap_or_else(|| {
            let id = c.id.clone();
            target.categories.push(c);
            id
        });
        categories.insert(source_id, id);
    }
    for a in &mut incoming.annotations {
        for id in &mut a.category_ids {
            *id = categories
                .get(id)
                .ok_or_else(|| AppError::invalid("Imported label references an unknown category"))?
                .clone();
        }
    }
    for m in &mut incoming.media_labels {
        for id in m
            .category_ids
            .iter_mut()
            .chain(m.channel_category_ids.iter_mut().flatten())
        {
            *id = categories
                .get(id)
                .ok_or_else(|| AppError::invalid("Imported label references an unknown category"))?
                .clone();
        }
    }
    for a in incoming.annotations {
        if !target.annotations.iter().any(|old| old.id == a.id) {
            target.annotations.push(a);
        }
    }
    for m in incoming.media_labels {
        if let Some(old) = target
            .media_labels
            .iter_mut()
            .find(|old| old.media_id == m.media_id)
        {
            if old.note.is_empty() {
                old.note = m.note;
            }
            for (old, new) in old.channel_notes.iter_mut().zip(m.channel_notes) {
                if old.is_empty() {
                    *old = new;
                }
            }
            for id in m.category_ids {
                if !old.category_ids.contains(&id) {
                    old.category_ids.push(id);
                }
            }
            for (old, new) in old
                .channel_category_ids
                .iter_mut()
                .zip(m.channel_category_ids)
            {
                for id in new {
                    if !old.contains(&id) {
                        old.push(id);
                    }
                }
            }
        } else {
            target.media_labels.push(m);
        }
    }
    Ok(())
}

/// Media is copied and verified through the same catalog API as ordinary import.
/// Each committed batch survives failure and a retry skips it by content identity.
pub fn merge_package(
    repo: &CollaborationRepository,
    actor: &AuthorSession,
    imported: &ImportedProject,
    cache: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64),
) -> Result<CollaborationRepository> {
    let mut repo = repo.reload_catalog()?;
    let folders: HashMap<_, _> = imported
        .organization
        .folders
        .iter()
        .map(|f| (f.id.as_str(), f))
        .collect();
    let members: HashMap<_, _> = imported
        .organization
        .media
        .iter()
        .map(|m| (m.media_id.as_str(), m))
        .collect();
    let mut media_map = HashMap::new();
    for chunk in imported.document.media.chunks(128) {
        check_cancel(cancel)?;
        let capture = repo.capture_media_placement(None)?;
        let mut prepared = vec![];
        for media in chunk {
            if let Some(existing) = repo.manifest().media.iter().find(|m| m.id == media.id) {
                if !same_identity(media, &existing.descriptor()) {
                    return Err(AppError::invalid(
                        "音频 UUID 与现有项目内容冲突，未覆盖已有音频",
                    ));
                }
                media_map.insert(media.id.clone(), existing.id.clone());
                continue;
            }
            if let Some(existing) = repo
                .manifest()
                .media
                .iter()
                .find(|m| same_identity(media, &m.descriptor()))
            {
                media_map.insert(media.id.clone(), existing.id.clone());
                continue;
            }
            // Keep distinct IDs within a bundle; only deduplicate against committed target media.
            let member = members[media.id.as_str()];
            let mut segments = vec![];
            let mut parent = member.folder_id.as_deref();
            while let Some(id) = parent {
                let f = folders[id];
                segments.push(f.name.clone());
                parent = f.parent_id.as_deref();
            }
            segments.reverse();
            let placement = capture.seal(segments, member.original_filename.clone())?;
            let source = Path::new(&media.source_ref);
            let source = if source.is_absolute() {
                source.to_path_buf()
            } else {
                imported.path.join(source)
            };
            prepared.push(repo.prepare_media_copy_with_placement(
                &source,
                cache,
                cancel,
                media,
                placement,
                &mut progress,
            )?);
            media_map.insert(media.id.clone(), media.id.clone());
        }
        if !prepared.is_empty() {
            repo = repo.append_media_batch_interleaved(
                actor,
                &prepared.iter().collect::<Vec<_>>(),
                cancel,
                None,
                || Ok(()),
            )?;
        }
    }
    import_authors(
        &repo,
        &imported.source_project_id,
        &imported.authors,
        &media_map,
        cancel,
    )?;
    Ok(repo)
}
