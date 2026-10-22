use crate::model::ProjectDocument;

#[derive(Default)]
pub(super) struct History {
    pub undo: Vec<ProjectDocument>,
    pub redo: Vec<ProjectDocument>,
    last_merge: Option<(String, String)>,
}
impl History {
    pub fn record(&mut self, before: ProjectDocument, merge: Option<(String, String)>) {
        if merge.is_none() || merge != self.last_merge {
            self.undo.push(before);
        }
        self.last_merge = merge;
        self.redo.clear();
    }
    pub fn break_merge(&mut self) {
        self.last_merge = None;
    }
}
