mod export;
mod import;
mod limits;
mod manifest;
mod merge;
mod path_plan;
mod subset;
use crate::error::{AppError, ErrorCode};
pub use export::{
    export_annotations, export_annotations_controlled, export_annotations_with_plan, export_bundle,
    export_bundle_controlled, export_bundle_with_plan, export_selected_controlled,
};
pub use import::{import_exchange, ImportedProject};
pub use limits::Limits;
pub use manifest::{Manifest, PortableAuthor};
pub use merge::{import_authors, merge_package};
pub use path_plan::{
    capture_organization, root_organization, ExportPathPlan, PathChange, SharedSourceAuthority,
};
pub use subset::{select_document, select_organization, select_payload};
fn io(error: std::io::Error) -> AppError {
    let mut e = AppError::new(ErrorCode::SaveFailed, format!("交换文件读写失败：{error}"));
    e.retryable = true;
    e
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidArchive, message)
}
fn limit() -> AppError {
    AppError::new(ErrorCode::ResourceLimit, "交换文件超过资源上限")
}
fn zip_error(error: zip::result::ZipError) -> AppError {
    invalid(format!("ZIP 无效或不受支持：{error}"))
}
