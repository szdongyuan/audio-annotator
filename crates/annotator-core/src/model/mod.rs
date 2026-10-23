mod analysis;
mod annotation;
mod edit;
mod media;
mod project;
pub mod validation;
pub use analysis::*;
pub use annotation::*;
pub use edit::*;
pub use media::*;
pub use project::*;

// Nullable is distinct from missing in the versioned wire contract.
pub(crate) fn required_nullable<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(deserializer)
}
