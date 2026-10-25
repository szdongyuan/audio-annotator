#![cfg(windows)]
use annotator_core::collaboration::LocalIdentity;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier},
};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("local-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn stable_identity_is_encrypted_and_distinct_between_roots() {
    let first = Temp::new();
    let second = Temp::new();
    let a = LocalIdentity::load_or_create(&first.0).unwrap();
    let b = LocalIdentity::load_or_create(&first.0).unwrap();
    let c = LocalIdentity::load_or_create(&second.0).unwrap();
    assert_eq!(a.login_name(), b.login_name());
    assert_ne!(a.login_name(), c.login_name());
    assert!(a.login_name().starts_with("@local:"));
    assert!(a.display_name().starts_with("本机作者 · "));
    let bytes = fs::read(first.0.join("local-identity.dpapi")).unwrap();
    assert!(!bytes
        .windows(a.login_name().len())
        .any(|w| w == a.login_name().as_bytes()));
    assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_err());
}
#[test]
fn concurrent_initialization_returns_one_persisted_identity() {
    let root = Temp::new();
    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let path = root.0.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                LocalIdentity::load_or_create(&path)
                    .unwrap()
                    .login_name()
                    .to_owned()
            })
        })
        .collect();
    let names: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(names.iter().all(|n| n == &names[0]));
    assert_eq!(
        names[0],
        LocalIdentity::load_or_create(&root.0).unwrap().login_name()
    );
}
#[test]
fn corrupt_or_undecryptable_identity_is_never_replaced() {
    for corrupt in [vec![], b"plain secret".to_vec(), vec![0; 16385]] {
        let root = Temp::new();
        let path = root.0.join("local-identity.dpapi");
        fs::write(&path, &corrupt).unwrap();
        assert!(LocalIdentity::load_or_create(&root.0).is_err());
        assert_eq!(fs::read(&path).unwrap(), corrupt);
    }
    let root = Temp::new();
    LocalIdentity::load_or_create(&root.0).unwrap();
    let path = root.0.join("local-identity.dpapi");
    let mut bytes = fs::read(&path).unwrap();
    let end = bytes.len() - 1;
    bytes[end] ^= 1;
    fs::write(&path, &bytes).unwrap();
    assert!(LocalIdentity::load_or_create(&root.0).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
}
