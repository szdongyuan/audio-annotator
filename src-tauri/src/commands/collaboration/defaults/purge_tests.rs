use super::*;
use annotator_core::collaboration::{
    organization::OrganizationOperation, purge::transaction::PurgeSelection,
    recycle::RecycleOperation,
};
use std::path::PathBuf;

pub(crate) struct Fixture {
    pub root: PathBuf,
    pub state: AppState,
    pub repo: Arc<CollaborationRepository>,
    pub actor: Arc<AuthorSession>,
    pub identity: profiles::Profile,
    pub document: annotator_core::model::ProjectDocument,
}
pub(crate) fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("purge-copy-{}", id()));
        for d in ["source", "target", "local", "copy-local"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        let identity = profiles::Profile::new("Alice").unwrap();
        let (repo, actor) =
            CollaborationRepository::create_default(&root.join("source"), "Copy", &identity)
                .unwrap();
        repo.apply_organization(
            &actor,
            0,
            OrganizationOperation::CreateFolder {
                id: id(),
                parent_id: None,
                name: "Empty".into(),
            },
        )
        .unwrap();
        let audio =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio/mono16.wav");
        for _ in 0..2 {
            let p = repo
                .prepare_media(&audio, &root.join("pcm"), &AtomicBool::new(false))
                .unwrap();
            repo.append_media(&actor, &p, &AtomicBool::new(false))
                .unwrap();
        }
        let repo = Arc::new(repo.reload_catalog().unwrap());
        let actor = Arc::new(actor);
        let project =
            LocalProject::open_shared(repo.clone(), Some(actor.clone()), &root.join("local"))
                .unwrap();
        let document = project.snapshot().unwrap().document;
        let state = AppState::default();
        state.6.set_local(root.join("local")).unwrap();
        state.6.install(Some(repo.clone())).unwrap();
        *state.0.lock().unwrap() = Some(project);
        Self {
            root,
            state,
            repo,
            actor,
            identity,
            document,
        }
    }
    pub fn retire(&self) {
        self.repo
            .apply_recycle_controlled(
                &self.actor,
                0,
                RecycleOperation {
                    operation_id: id(),
                    media_ids: vec![self.document.media[0].id.clone()],
                    trash: true,
                },
                &AtomicBool::new(false),
                || Ok(()),
            )
            .unwrap();
        let p = self
            .repo
            .preview_purge(&self.actor, "test", &id(), PurgeSelection::All)
            .unwrap();
        self.repo
            .commit_purge(&self.actor, "test", &p, &AtomicBool::new(false))
            .unwrap();
    }
    pub fn expected(&self) -> runtime::Expected {
        let d = self
            .state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .snapshot()
            .unwrap()
            .document;
        runtime::Expected {
            runtime_nonce: self.state.6.current.lock().unwrap().nonce.clone(),
            project_id: d.project_id,
            expected_revision: d.revision,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.state.0.lock().unwrap().take();
        self.state.6.retire();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn save_as_rejects_stale_revision_then_copies_only_surviving_private_scope() {
    let f = Fixture::new();
    {
        let mut current = f.state.0.lock().unwrap();
        let p = current.as_mut().unwrap();
        let d = p.snapshot().unwrap().document;
        p.apply_change(
            &d.project_id,
            d.revision,
            annotator_core::model::Change::UpdateMediaNote {
                media_id: d.media[1].id.clone(),
                note: "Private survivor".into(),
                merge_key: None,
            },
        )
        .unwrap();
        p.workspace_mut()
            .unwrap()
            .set_hidden_media_ids(d.media.iter().map(|m| m.id.clone()).collect())
            .unwrap();
        let mut preferences = annotator_core::collaboration::PlaybackPreferences::default();
        preferences.volume = 0.42;
        preferences
            .media_monitor_gain_db
            .insert(d.media[0].id.clone(), Some(-5.0));
        preferences
            .media_monitor_gain_db
            .insert(d.media[1].id.clone(), Some(7.0));
        p.workspace_mut()
            .unwrap()
            .save_preferences(preferences)
            .unwrap();
    }
    // A newly published catalog item is outside the accepted private scope.
    let audio =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/audio/mono16.wav");
    let pending = f
        .repo
        .prepare_media(&audio, &f.root.join("pcm"), &AtomicBool::new(false))
        .unwrap();
    f.repo
        .append_media(&f.actor, &pending, &AtomicBool::new(false))
        .unwrap();
    let expected = f.expected();
    f.retire();
    let result = tauri::async_runtime::block_on(save_as(
        &f.state,
        Some(expected.runtime_nonce),
        f.root.join("target").to_string_lossy().into(),
        expected.project_id,
        expected.expected_revision,
    ));
    assert!(result.is_err());
    assert_eq!(
        result.err().unwrap().code,
        annotator_core::error::ErrorCode::RevisionConflict
    );
    assert_eq!(fs::read_dir(f.root.join("target")).unwrap().count(), 0);
    let expected = f.expected();
    tauri::async_runtime::block_on(save_as(
        &f.state,
        Some(expected.runtime_nonce),
        f.root.join("target").to_string_lossy().into(),
        expected.project_id,
        expected.expected_revision,
    ))
    .unwrap();
    let repo = CollaborationRepository::open(&f.root.join("target")).unwrap();
    assert_eq!(repo.manifest().format_version, 5);
    assert_eq!(repo.manifest().media.len(), 1);
    assert_eq!(repo.manifest().media[0].id, f.document.media[1].id);
    assert_eq!(repo.read_organization().unwrap().folders[0].name, "Empty");
    {
        let current = f.state.0.lock().unwrap();
        let p = current.as_ref().unwrap();
        assert_eq!(
            p.snapshot().unwrap().document.media[0].note,
            "Private survivor"
        );
        let w = p.workspace().unwrap();
        assert_eq!(w.hidden_media_ids(), &[f.document.media[1].id.clone()]);
        assert_eq!(w.preferences().volume, 0.42);
        assert!(!w
            .preferences()
            .media_monitor_gain_db
            .contains_key(&f.document.media[0].id));
        assert_eq!(
            w.preferences().media_monitor_gain_db[&f.document.media[1].id],
            Some(7.0)
        );
    }
    for name in ["maintenance", "state"] {
        assert!(!f.root.join("target").join(name).exists());
    }
    assert!(f
        .root
        .join("source")
        .join(&f.document.media[0].source_ref)
        .exists());
}

#[test]
fn copy_rejects_purge_after_media_copy_before_target_publication() {
    let f = Fixture::new();
    let mut retired = false;
    let result = copy(
        &f.document,
        &f.root.join("source"),
        &f.root.join("target"),
        &f.root.join("copy-local"),
        &f.identity,
        &AtomicBool::new(false),
        |phase, _| {
            if phase == "publishManifest" && !retired {
                f.retire();
                retired = true;
            }
        },
    );
    assert!(retired);
    assert!(result.is_err(), "copy published a retired source snapshot");
    assert_eq!(fs::read_dir(f.root.join("target")).unwrap().count(), 0);
}
