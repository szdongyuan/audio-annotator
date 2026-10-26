use annotator_core::{
    collaboration::{profiles::Profile, *},
    error::ErrorCode,
};
use std::fs;

#[test]
fn profile_uuid_is_shared_across_projects_and_nickname_does_not_revoke_lease() {
    let root = std::env::temp_dir().join(format!("uuid-authors-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir(root.join("b")).unwrap();
    let mut profile = Profile::new("Alice").unwrap();
    let (a, session) =
        CollaborationRepository::create_default(&root.join("a"), "A", &profile).unwrap();
    let (b, second) =
        CollaborationRepository::create_default(&root.join("b"), "B", &profile).unwrap();
    assert_eq!(a.manifest().format_version, 5);
    assert_eq!(session.identity().author_id, profile.author_id);
    assert_eq!(second.identity().author_id, profile.author_id);
    assert_eq!(
        a.adopt(&profile).err().unwrap().code,
        ErrorCode::ProjectLocked
    );
    profile.display_name = "Renamed".into();
    a.refresh_author(&session, &profile).unwrap();
    a.publish(&session, None, &LayerPayload::default()).unwrap();
    assert_eq!(
        a.snapshot().unwrap().authors[0].identity.display_name,
        "Renamed"
    );
    let record =
        fs::read_to_string(root.join(format!("a/authors/{}.json", profile.author_id))).unwrap();
    assert!(!record.contains("password"));
    assert!(!record.contains("normalizedLogin"));
    assert!(!root.join("a/accounts").exists());
    drop((a, b, session, second));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn old_collaboration_versions_are_rejected_without_writes() {
    for version in [1, 2, 3, 4] {
        let root = std::env::temp_dir().join(format!("old-collab-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let bytes = format!("{{\"formatVersion\":{version}}}").into_bytes();
        fs::write(root.join("collaboration.json"), &bytes).unwrap();
        assert_eq!(
            CollaborationRepository::open(&root).err().unwrap().code,
            ErrorCode::UnsupportedVersion
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert_eq!(fs::read(root.join("collaboration.json")).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn maximum_portable_profile_fits_author_record_and_old_dpapi_is_untouched() {
    use annotator_core::collaboration::profiles::{encode_transfer, parse_transfer, ProfileStore};
    let root = std::env::temp_dir().join(format!("long-profile-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("project")).unwrap();
    fs::write(root.join("local-identity.dpapi"), b"old opaque bytes").unwrap();
    ProfileStore::load_or_create(&root).unwrap();
    assert_eq!(
        fs::read(root.join("local-identity.dpapi")).unwrap(),
        b"old opaque bytes"
    );
    let mut profile = Profile::new("Portable").unwrap();
    profile.created_at = "2026-10-26T00:00:00.1Z".into();
    let length = encode_transfer(&profile).unwrap().len();
    profile.created_at = format!("2026-10-26T00:00:00.{}Z", "1".repeat(4096 - length + 1));
    let bytes = encode_transfer(&profile).unwrap();
    assert_eq!(bytes.len(), 4096);
    let imported = parse_transfer(&bytes).unwrap();
    let (repo, actor) =
        CollaborationRepository::create_default(&root.join("project"), "Long timestamp", &imported)
            .unwrap();
    let author =
        fs::read(root.join(format!("project/authors/{}.json", profile.author_id))).unwrap();
    assert!(author.len() > 4096);
    assert_eq!(
        repo.snapshot().unwrap().authors[0].identity.created_at,
        profile.created_at
    );
    drop((repo, actor));
    fs::remove_dir_all(root).unwrap();
}
