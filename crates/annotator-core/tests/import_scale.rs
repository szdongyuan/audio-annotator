//! Explicit opt-in read-only measurements against external source data.
use std::{fs::File, io::BufReader, time::Instant};

#[test]
#[ignore = "requires ANNOTATOR_BENCH_ZIP; never writes to the source archive"]
fn measure_network_zip_directory_reads() {
    let path = std::env::var("ANNOTATOR_BENCH_ZIP").expect("explicit source required");
    for buffered in [false, true] {
        let start = Instant::now();
        let count = if buffered {
            zip::ZipArchive::new(BufReader::with_capacity(
                256 * 1024,
                File::open(&path).unwrap(),
            ))
            .unwrap()
            .len()
        } else {
            zip::ZipArchive::new(File::open(&path).unwrap())
                .unwrap()
                .len()
        };
        println!(
            "ZIP_DIRECTORY buffered={buffered} entries={count} elapsed_ms={}",
            start.elapsed().as_millis()
        );
    }
}

#[test]
#[ignore = "requires ANNOTATOR_BENCH_PROJECT; read-only existing project"]
fn measure_shared_catalog_open() {
    let path = std::env::var("ANNOTATOR_BENCH_PROJECT").expect("explicit project required");
    let start = Instant::now();
    let repo =
        annotator_core::collaboration::CollaborationRepository::open(std::path::Path::new(&path))
            .unwrap();
    println!(
        "CATALOG_OPEN media={} elapsed_ms={}",
        repo.manifest().media.len(),
        start.elapsed().as_millis()
    );
    let start = Instant::now();
    let current = repo.reload_catalog().unwrap();
    println!(
        "CATALOG_RELOAD media={} elapsed_ms={}",
        current.manifest().media.len(),
        start.elapsed().as_millis()
    );
}

#[test]
#[ignore = "requires ANNOTATOR_BENCH_ZIP; extracts only to a new owned temporary directory"]
fn measure_zip_staging_reuse() {
    use annotator_core::media::import_source::*;
    use std::{fs, sync::atomic::AtomicBool};
    let path = std::env::var("ANNOTATOR_BENCH_ZIP").expect("explicit source required");
    let cfg = Config {
        kind: SourceKind::Zip,
        paths: vec![path],
        rules: Rules::default(),
        organization: Default::default(),
    };
    let cancel = AtomicBool::new(false);
    let scan = scan(&cfg, &cancel, Limits::default(), |_| {}).unwrap();
    let root = std::env::temp_dir().join(format!("zip-staging-bench-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let count = scan.candidates().len().min(100);
    let mut before = Vec::new();
    let start = Instant::now();
    for index in 0..count {
        let item = scan.stage(index, &root, &cancel, |_| {}).unwrap();
        before.push(item.sha256.clone());
    }
    println!(
        "ZIP_STAGING reuse=false count={count} elapsed_ms={}",
        start.elapsed().as_millis()
    );
    let mut session = scan.staging_session();
    let start = Instant::now();
    for (index, expected) in before.iter().enumerate() {
        let item = session.stage(index, &root, &cancel, |_| {}).unwrap();
        assert_eq!(&item.sha256, expected);
    }
    println!(
        "ZIP_STAGING reuse=true count={count} elapsed_ms={}",
        start.elapsed().as_millis()
    );
    drop(session);
    fs::remove_dir(root).unwrap();
}
