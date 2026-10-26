use super::history::History;
use crate::{
    error::{AppError, ErrorCode, Result},
    model::*,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSnapshot {
    pub document: ProjectDocument,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Clone)]
pub struct ProjectSession {
    document: ProjectDocument,
    history: History,
}
impl ProjectSession {
    pub(super) fn adopt_catalog(
        &mut self,
        manifest: &crate::collaboration::CollaborationManifest,
    ) -> Result<()> {
        for document in std::iter::once(&mut self.document)
            .chain(&mut self.history.undo)
            .chain(&mut self.history.redo)
        {
            crate::collaboration::catalog_workspace::extend_document(document, manifest)?;
        }
        if self.document.revision >= validation::MAX_SAFE_INTEGER {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "Revision limit reached",
            ));
        }
        // Catalog growth is not a content edit. Keep timestamps equal to the saved
        // projection when there was no live draft before adoption.
        self.document.revision += 1;
        self.history.break_merge();
        Ok(())
    }
    pub(super) fn rebase_sources(&mut self, root: &std::path::Path) {
        for document in std::iter::once(&mut self.document)
            .chain(&mut self.history.undo)
            .chain(&mut self.history.redo)
        {
            for media in &mut document.media {
                if std::path::Path::new(&media.source_ref).is_relative() {
                    media.source_ref = root.join(&media.source_ref).to_string_lossy().into_owned();
                }
            }
        }
    }
    pub fn new(document: ProjectDocument) -> Result<Self> {
        document.validate()?;
        Ok(Self {
            document,
            history: History::default(),
        })
    }
    pub fn snapshot(&self) -> ProjectSnapshot {
        ProjectSnapshot {
            document: self.document.clone(),
            can_undo: !self.history.undo.is_empty(),
            can_redo: !self.history.redo.is_empty(),
        }
    }
    fn check_revision(&self, project_id: &str, revision: u64) -> Result<()> {
        if project_id != self.document.project_id {
            return Err(AppError::invalid("Unknown project"));
        }
        if revision != self.document.revision {
            let mut error = AppError::new(
                ErrorCode::RevisionConflict,
                "Project changed; refresh before editing",
            );
            error.entity_id = Some(project_id.into());
            error.details = Some(
                serde_json::json!({"expectedRevision":revision,"actualRevision":self.document.revision}),
            );
            return Err(error);
        }
        Ok(())
    }
    fn advance(&self, next: &mut ProjectDocument) -> Result<()> {
        if self.document.revision >= validation::MAX_SAFE_INTEGER {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "Revision limit reached",
            ));
        }
        next.revision = self.document.revision + 1;
        next.updated_at = now();
        // A clock adjustment must not make a valid document impossible to edit.
        if chrono::DateTime::parse_from_rfc3339(&next.updated_at).unwrap()
            < chrono::DateTime::parse_from_rfc3339(&self.document.updated_at).unwrap()
        {
            next.updated_at = self.document.updated_at.clone();
        }
        next.validate()
    }
    pub fn apply_change(
        &mut self,
        project_id: &str,
        expected_revision: u64,
        change: Change,
    ) -> Result<ProjectSnapshot> {
        self.check_revision(project_id, expected_revision)?;
        let mut next = self.document.clone();
        apply(&mut next, &change)?;
        self.advance(&mut next)?;
        if change.records_history() {
            self.history
                .record(self.document.clone(), change.merge_identity());
        }
        self.document = next;
        Ok(self.snapshot())
    }
    pub fn undo(&mut self, project_id: &str, expected_revision: u64) -> Result<ProjectSnapshot> {
        self.restore(project_id, expected_revision, false)
    }
    pub fn redo(&mut self, project_id: &str, expected_revision: u64) -> Result<ProjectSnapshot> {
        self.restore(project_id, expected_revision, true)
    }
    fn restore(&mut self, project_id: &str, revision: u64, redo: bool) -> Result<ProjectSnapshot> {
        self.check_revision(project_id, revision)?;
        let stack = if redo {
            &self.history.redo
        } else {
            &self.history.undo
        };
        let mut next = stack
            .last()
            .cloned()
            .ok_or_else(|| AppError::invalid("No history available"))?;
        // View/mix are persistent preferences, not content history. Restore a removed
        // medium's preferences from history; preserve current ones for surviving media.
        for media in &next.media {
            if let Some(mix) = self.document.playback_mix.get(&media.id) {
                next.playback_mix.insert(media.id.clone(), mix.clone());
            }
        }
        next.view_state = self.document.view_state.clone();
        clean_view(&mut next);
        self.advance(&mut next)?;
        if redo {
            self.history.redo.pop();
            self.history.undo.push(self.document.clone());
        } else {
            self.history.undo.pop();
            self.history.redo.push(self.document.clone());
        }
        self.history.break_merge();
        self.document = next;
        Ok(self.snapshot())
    }
}
fn find_mut<'a, T>(items: &'a mut [T], id: &str, key: impl Fn(&T) -> &str) -> Result<&'a mut T> {
    items
        .iter_mut()
        .find(|item| key(item) == id)
        .ok_or_else(|| AppError::invalid("Unknown entity"))
}
fn remove<T>(items: &mut Vec<T>, id: &str, key: impl Fn(&T) -> &str) -> Result<()> {
    let index = items
        .iter()
        .position(|item| key(item) == id)
        .ok_or_else(|| AppError::invalid("Unknown entity"))?;
    items.remove(index);
    Ok(())
}
fn clean_view(doc: &mut ProjectDocument) {
    doc.view_state
        .media
        .retain(|id, _| doc.media.iter().any(|m| &m.id == id));
    for selected in [
        &mut doc.view_state.active_media_id,
        &mut doc.view_state.compare_media_id,
    ] {
        if selected
            .as_ref()
            .is_some_and(|id| !doc.media.iter().any(|m| &m.id == id))
        {
            *selected = None;
        }
    }
    let max_duration = doc
        .media
        .iter()
        .map(MediaDescriptor::duration)
        .fold(0.0, f64::max);
    for (id, view) in &mut doc.view_state.media {
        let media = doc.media.iter().find(|m| &m.id == id).unwrap();
        let limit = if doc.view_state.linked_time {
            max_duration
        } else {
            media.duration()
        };
        view.end_seconds = view.end_seconds.min(limit);
        if view.start_seconds >= view.end_seconds {
            view.start_seconds = 0.0;
        }
    }
}
fn apply(doc: &mut ProjectDocument, change: &Change) -> Result<()> {
    match change {
        Change::ImportMedia { media } => {
            doc.media.push(media.clone());
            doc.analysis
                .insert(media.id.clone(), AnalysisSettings::default());
            doc.playback_mix
                .insert(media.id.clone(), PlaybackMix::default());
        }
        Change::RelinkMedia { media } => {
            let current = find_mut(&mut doc.media, &media.id, |m| &m.id)?;
            if !crate::media::registry::same_identity(current, media) {
                return Err(AppError::new(
                    ErrorCode::IdentityMismatch,
                    "所选文件与原音频指纹或元数据不匹配",
                ));
            }
            // Relinking never replaces newer notes or display names from an async result.
            current.source_ref = media.source_ref.clone();
        }
        Change::RemoveMedia { media_id } => {
            remove(&mut doc.media, media_id, |m| &m.id)?;
            doc.annotations.retain(|a| &a.region.media_id != media_id);
            doc.edits.retain(|e| &e.region.media_id != media_id);
            doc.analysis.remove(media_id);
            doc.playback_mix.remove(media_id);
            clean_view(doc);
        }
        Change::SetMediaCategory {
            media_id,
            category_id,
        } => {
            find_mut(&mut doc.media, media_id, |m| &m.id)?.category_id = category_id.clone();
        }
        Change::SetChannelCategory {
            media_id,
            channel_index,
            category_id,
        } => {
            *find_mut(&mut doc.media, media_id, |m| &m.id)?
                .channel_category_ids
                .get_mut(*channel_index as usize)
                .ok_or_else(|| AppError::invalid("Invalid channel"))? = category_id.clone();
        }
        Change::UpdateMediaNote { media_id, note, .. } => {
            find_mut(&mut doc.media, media_id, |m| &m.id)?.note = note.clone()
        }
        Change::UpdateChannelNote {
            media_id,
            channel_index,
            note,
            ..
        } => {
            let media = find_mut(&mut doc.media, media_id, |m| &m.id)?;
            *media
                .channel_notes
                .get_mut(*channel_index as usize)
                .ok_or_else(|| AppError::invalid("Invalid channel"))? = note.clone();
        }
        Change::UpdateAnnotationNote { id, note, .. } => {
            let annotation = find_mut(&mut doc.annotations, id, |a| &a.id)?;
            annotation.note = note.clone();
            annotation.updated_at = now().max(annotation.updated_at.clone());
        }
        Change::AddCategory { category } => {
            let mut c = category.clone();
            c.name = c.name.trim().into();
            doc.categories.push(c);
        }
        Change::UpdateCategory { category } => {
            let mut c = category.clone();
            c.name = c.name.trim().into();
            *find_mut(&mut doc.categories, &category.id, |c| &c.id)? = c;
        }
        Change::RemoveCategory { id } => {
            remove(&mut doc.categories, id, |c| &c.id)?;
            for media in &mut doc.media {
                for category in
                    std::iter::once(&mut media.category_id).chain(&mut media.channel_category_ids)
                {
                    if category.as_ref() == Some(id) {
                        *category = None;
                    }
                }
            }
            for annotation in &mut doc.annotations {
                if annotation.category_id.as_ref() == Some(id) {
                    annotation.category_id = None;
                }
            }
        }
        Change::AddAnnotation { annotation } => doc.annotations.push(annotation.clone()),
        Change::UpdateAnnotation { annotation } => {
            *find_mut(&mut doc.annotations, &annotation.id, |a| &a.id)? = annotation.clone()
        }
        Change::RemoveAnnotation { id } => remove(&mut doc.annotations, id, |a| &a.id)?,
        Change::AddEdit { edit } => doc.edits.push(edit.clone()),
        Change::UpdateEdit { edit } => {
            *find_mut(&mut doc.edits, &edit.id, |e| &e.id)? = edit.clone()
        }
        Change::RemoveEdit { id } => remove(&mut doc.edits, id, |e| &e.id)?,
        Change::SetEditEnabled { id, enabled } => {
            find_mut(&mut doc.edits, id, |e| &e.id)?.enabled = *enabled
        }
        Change::UpdateAnalysis { media_id, settings } => {
            doc.analysis.insert(media_id.clone(), settings.clone());
        }
        Change::UpdatePlaybackMix { media_id, mix } => {
            let mut mix = mix.clone();
            mix.solo_channels.sort_unstable();
            mix.solo_channels.dedup();
            mix.muted_channels.sort_unstable();
            mix.muted_channels.dedup();
            doc.playback_mix.insert(media_id.clone(), mix);
        }
        Change::UpdateViewState { view_state } => doc.view_state = view_state.clone(),
    }
    Ok(())
}
