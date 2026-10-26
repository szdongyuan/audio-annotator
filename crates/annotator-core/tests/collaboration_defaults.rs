#![cfg(windows)]
mod support;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier},
};
use support::selected;
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
fn stable_identity_is_plain_metadata_and_distinct_between_roots() {
    let first = Temp::new();
    let second = Temp::new();
    let a = selected(&first.0).unwrap();
    let b = selected(&first.0).unwrap();
    let c = selected(&second.0).unwrap();
    assert_eq!(a.author_id, b.author_id);
    assert_ne!(a.author_id, c.author_id);
    assert!(a.display_name.starts_with("本机身份 · "));
    let bytes = fs::read(first.0.join("profiles.json")).unwrap();
    assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
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
                selected(&path).unwrap().author_id.to_owned()
            })
        })
        .collect();
    let names: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(names.iter().all(|n| n == &names[0]));
    assert_eq!(names[0], selected(&root.0).unwrap().author_id);
}
#[test]
fn corrupt_identity_is_never_replaced() {
    for corrupt in [vec![], b"plain secret".to_vec(), vec![0; 16385]] {
        let root = Temp::new();
        let path = root.0.join("profiles.json");
        fs::write(&path, &corrupt).unwrap();
        assert!(selected(&root.0).is_err());
        assert_eq!(fs::read(&path).unwrap(), corrupt);
    }
    let root = Temp::new();
    selected(&root.0).unwrap();
    let path = root.0.join("profiles.json");
    let mut bytes = fs::read(&path).unwrap();
    let end = bytes.len() - 1;
    bytes[end] ^= 1;
    fs::write(&path, &bytes).unwrap();
    assert!(selected(&root.0).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
}
