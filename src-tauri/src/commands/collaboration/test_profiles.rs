use super::runtime::Expected;
use crate::{commands::profiles, state::AppState};
use annotator_core::{collaboration::profiles::*, error::Result};
#[path = "../../../../crates/annotator-core/tests/support/mod.rs"]
mod fixtures;
pub use fixtures::{profile, seed, write_manifest};
pub fn local_profile(state: &AppState, name: &str) -> Profile {
    let p = profile(name);
    let store = state.6.profile_store().unwrap();
    let temp = state
        .6
        .local()
        .unwrap()
        .join(format!("test-transfer-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&temp, encode_transfer(&p).unwrap()).unwrap();
    let result = store
        .import(store.snapshot().unwrap().revision, &temp)
        .unwrap();
    std::fs::remove_file(temp).unwrap();
    result.profile
}
pub async fn select_named(
    state: &AppState,
    expected: Expected,
    operation_id: String,
    name: Option<&str>,
) -> Result<profiles::Response> {
    let p = match name {
        Some(name) => local_profile(state, name),
        None => state.6.profile_store()?.snapshot()?.profiles[0].clone(),
    };
    let saved = state.6.profile_store()?.snapshot()?;
    profiles::perform(
        state,
        profiles::Expected {
            store_revision: saved.revision,
            runtime_nonce: expected.runtime_nonce,
            project: Some(profiles::ProjectExpectation {
                project_id: expected.project_id,
                expected_revision: expected.expected_revision,
            }),
        },
        operation_id,
        profiles::Action::Select(p.author_id),
    )
    .await
}
