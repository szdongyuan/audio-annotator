//! Native authority, metadata generations and permanent recycle deletion.
mod authority;
pub mod cleanup;
pub mod generation;
pub mod journal;
pub mod legacy;
mod model;
mod policy;
pub mod projection;
pub mod transaction;

pub use model::{Eligibility, PurgeAuthority};
pub use policy::classify_media;
