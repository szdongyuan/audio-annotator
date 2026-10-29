use super::{Result, ScanResult};
use std::collections::HashSet;

/// A complete project destination, compared using Unicode lowercase per component.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ImportPathKey {
    folders: Vec<String>,
    filename: String,
}

impl ImportPathKey {
    pub fn new(folders: &[String], filename: &str) -> Self {
        Self {
            folders: folders.iter().map(|s| s.to_lowercase()).collect(),
            filename: filename.to_lowercase(),
        }
    }
}

impl ScanResult {
    /// Before publishing the preview, exclude occupied destinations and retain
    /// only the first candidate per destination. Call after binding the target path.
    pub fn exclude_duplicate_paths(&mut self, occupied: &HashSet<ImportPathKey>) -> Result<()> {
        let mut seen = occupied.clone();
        let mut candidates = Vec::with_capacity(self.candidates.len());
        let mut entries = Vec::with_capacity(self.entries.len());
        for (mut candidate, entry) in self.candidates.drain(..).zip(self.entries.drain(..)) {
            let key = ImportPathKey::new(
                &candidate.resulting_folder_path,
                &candidate.original_filename,
            );
            if !seen.insert(key) {
                self.counts.skipped += 1;
                self.counts.duplicate_skipped += 1;
                self.counts.selected_bytes -= candidate.byte_length;
            } else {
                candidate.index = candidates.len();
                candidates.push(candidate);
                entries.push(entry);
            }
        }
        self.candidates = candidates;
        self.entries = entries;
        self.counts.candidates = self.candidates.len();
        self.rebuild_summary()
    }
}
