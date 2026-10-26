mod model;
mod repository;
mod validation;
pub use model::*;
pub(crate) use repository::{encode, read};
pub const MAX_ORGANIZATION_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_FOLDERS: usize = 10_000;
