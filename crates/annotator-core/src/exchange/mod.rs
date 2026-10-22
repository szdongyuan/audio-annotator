mod export;
mod import;
mod limits;
mod manifest;
use crate::error::{AppError, ErrorCode};
pub use export::{export_annotations, export_bundle};
pub use import::{import_exchange, ImportedProject};
pub use limits::Limits;
pub use manifest::Manifest;
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
