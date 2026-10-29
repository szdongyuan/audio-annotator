//! Stable on-disk protocol values. New projects continue to use format 5.
pub const GENERATION_COLLABORATION_FORMAT: u32 = 6;
pub const GENERATION_KIND: &str = "audio-annotator-metadata-generation";
pub const PURGE_JOURNAL_KIND: &str = "audio-annotator-purge-journal";
pub const PURGE_REQUEST_KIND: &str = "audio-annotator-purge-request";
pub const LEGACY_UPGRADE_KIND: &str = "audio-annotator-legacy-upgrade";
pub const LEGACY_FENCE_KIND: &str = "audio-annotator-legacy-upgrade-fence";
pub fn supported_catalog_format(version: u32) -> bool {
    matches!(version, 5 | GENERATION_COLLABORATION_FORMAT)
}
