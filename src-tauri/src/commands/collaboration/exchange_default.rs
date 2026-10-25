use super::{
    creation::{Owned, PreparedCopy},
    defaults, runtime,
};
use annotator_core::{
    collaboration::atomic,
    error::{AppError, Result},
    exchange::{self, Limits, Manifest},
    media::identity::{check_cancel, fingerprint, SourceStamp},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, io::Read, path::Path, sync::atomic::AtomicBool};
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBinding {
    pub media_id: String,
    pub path: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBindings {
    pub source_sha256: String,
    pub media: Vec<SourceBinding>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredMedia {
    pub id: String,
    pub display_name: String,
    pub sha256: String,
    pub byte_length: u64,
    pub sample_rate: u32,
    pub frame_count: u64,
    pub channel_count: u8,
    pub channel_layout: Option<Vec<String>>,
}
pub(crate) enum PreparedImport {
    SourcesRequired {
        source_sha256: String,
        media: Vec<RequiredMedia>,
    },
    Ready(Box<PreparedCopy>),
}
pub(crate) fn prepare(
    source: &Path,
    parent: &Path,
    local: &Path,
    bindings: Option<SourceBindings>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&str, u64),
) -> Result<PreparedImport> {
    atomic::safe_existing(parent)?;
    let parent = parent.canonicalize().map_err(|_| runtime::unavailable())?;
    if parent
        .ancestors()
        .any(|p| p.join("collaboration.json").exists() || p.join("project.json").exists())
    {
        return Err(AppError::invalid("Import outside an existing project"));
    }
    let stamp = SourceStamp::read(source)?;
    let source_sha256 = fingerprint(source, cancel, |_| {})?;
    let mut file = fs::File::open(source).map_err(|_| runtime::unavailable())?;
    let mut magic = [0u8; 2];
    let n = file.read(&mut magic).map_err(|_| runtime::unavailable())?;
    let bundle = n == 2 && &magic == b"PK";
    if let Some(bindings) = &bindings {
        if bindings.source_sha256 != source_sha256 {
            return Err(AppError::invalid(
                "Exchange source changed; inspect it again",
            ));
        }
    }
    if !bundle {
        let mut bytes = vec![];
        fs::File::open(source)
            .map_err(|_| runtime::unavailable())?
            .take(Limits::default().manifest_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| runtime::unavailable())?;
        if bytes.len() as u64 > Limits::default().manifest_bytes {
            return Err(AppError::invalid("Exchange manifest exceeds limit"));
        }
        let manifest = Manifest::parse(&bytes, false)?;
        stamp.verify(source)?;
        if bindings.is_none() && !manifest.media.is_empty() {
            return Ok(PreparedImport::SourcesRequired {
                source_sha256,
                media: manifest
                    .media
                    .into_iter()
                    .map(|m| RequiredMedia {
                        id: m.id,
                        display_name: m.display_name,
                        sha256: m.sha256,
                        byte_length: m.byte_length,
                        sample_rate: m.sample_rate,
                        frame_count: m.frame_count,
                        channel_count: m.channel_count,
                        channel_layout: m.channel_layout,
                    })
                    .collect(),
            });
        }
    } else if bindings.is_some() {
        return Err(AppError::invalid(
            "Bundle import does not accept source bindings",
        ));
    }
    check_cancel(cancel)?;
    // The legacy exchange reader is confined inside an exclusive hidden native staging root.
    let staging = parent.join(format!(".native-import-{}", uuid::Uuid::new_v4()));
    let mut owned = Owned::new();
    owned.dir(&staging)?;
    let result =
        exchange::import_exchange(source, &staging, cancel, Limits::default(), &mut progress);
    owned.inventory(&staging)?;
    let mut imported = result?;
    stamp.verify(source)?;
    if fingerprint(source, cancel, |_| {})? != source_sha256 {
        return Err(AppError::invalid("Exchange source changed during import"));
    }
    if let Some(bindings) = bindings {
        if bindings.media.len() != imported.document.media.len() || bindings.media.len() > 4096 {
            return Err(AppError::invalid(
                "Provide exactly one file for every required medium",
            ));
        }
        let mut seen = HashSet::new();
        for binding in bindings.media {
            if !seen.insert(binding.media_id.clone()) {
                return Err(AppError::invalid("Duplicate media source binding"));
            }
            let media = imported
                .document
                .media
                .iter_mut()
                .find(|m| m.id == binding.media_id)
                .ok_or_else(|| AppError::invalid("Unknown media binding"))?;
            let path = Path::new(&binding.path);
            if !path.is_absolute() {
                return Err(AppError::invalid("Audio source path must be absolute"));
            }
            media.source_ref = binding.path;
        }
    }
    let target = parent.join(format!("imported-{}", uuid::Uuid::new_v4()));
    // The PreparedCopy owns its outer directory too, so a failed authority check removes only it.
    let mut target_owner = Owned::new();
    target_owner.dir(&target)?;
    let mut prepared = defaults::copy(
        &imported.document,
        &imported.path,
        &target,
        local,
        cancel,
        &mut progress,
    )?;
    prepared.owned.own_parent(target);
    target_owner.keep();
    Ok(PreparedImport::Ready(Box::new(prepared)))
}
#[cfg(test)]
mod tests {
    use super::*;
    use annotator_core::{
        media::decode::decode,
        model::{Change, ProjectDocument},
        project::LocalProject,
    };
    #[test]
    fn annotation_sources_are_required_then_verified_before_default_publication() {
        let root = std::env::temp_dir().join(format!("exchange-default-{}", uuid::Uuid::new_v4()));
        for d in ["source", "imports", "local"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let mut project = LocalProject::create(&root.join("source"), "Original".into()).unwrap();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/audio/mono16.wav")
            .canonicalize()
            .unwrap();
        let decoded = decode(&path, &root.join("pcm"), &cancel, |_, _| {}).unwrap();
        let d: ProjectDocument = project.snapshot().unwrap().document;
        let d = project
            .apply_change(
                &d.project_id,
                d.revision,
                Change::ImportMedia {
                    media: decoded.descriptor.clone(),
                },
            )
            .unwrap()
            .document;
        let json = root.join("share.json");
        annotator_core::exchange::export_annotations(
            &d,
            &json,
            &cancel,
            annotator_core::exchange::Limits::default(),
            |_, _| {},
        )
        .unwrap();
        let needs = prepare(
            &json,
            &root.join("imports"),
            &root.join("local"),
            None,
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let PreparedImport::SourcesRequired {
            source_sha256,
            media,
        } = needs
        else {
            panic!("must require audio")
        };
        assert_eq!(media.len(), 1);
        assert_eq!(std::fs::read_dir(root.join("imports")).unwrap().count(), 0);
        let bindings = SourceBindings {
            source_sha256,
            media: vec![SourceBinding {
                media_id: d.media[0].id.clone(),
                path: path.to_string_lossy().into(),
            }],
        };
        let mut wrong_digest = bindings.clone();
        wrong_digest.source_sha256 = "0".repeat(64);
        assert!(prepare(
            &json,
            &root.join("imports"),
            &root.join("local"),
            Some(wrong_digest),
            &cancel,
            |_, _| {}
        )
        .is_err());
        let mut wrong_audio = bindings.clone();
        wrong_audio.media[0].path = path
            .parent()
            .unwrap()
            .join("six.flac")
            .to_string_lossy()
            .into();
        assert!(prepare(
            &json,
            &root.join("imports"),
            &root.join("local"),
            Some(wrong_audio),
            &cancel,
            |_, _| {}
        )
        .is_err());
        assert_eq!(fs::read_dir(root.join("imports")).unwrap().count(), 0);
        let cancelled = AtomicBool::new(false);
        assert!(prepare(
            &json,
            &root.join("imports"),
            &root.join("local"),
            Some(bindings.clone()),
            &cancelled,
            |phase, _| {
                if phase == "copyMedia" {
                    cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            }
        )
        .is_err());
        assert_eq!(fs::read_dir(root.join("imports")).unwrap().count(), 0);
        let PreparedImport::Ready(prepared) = prepare(
            &json,
            &root.join("imports"),
            &root.join("local"),
            Some(bindings),
            &cancel,
            |_, _| {},
        )
        .unwrap() else {
            panic!("must complete")
        };
        let (copy, repo) = prepared.commit();
        assert_eq!(repo.manifest().format_version, 2);
        assert_eq!(repo.manifest().media[0].id, d.media[0].id);
        assert!(copy.snapshot().unwrap().document.edits.is_empty());
        let bundle = root.join("share.zip");
        exchange::export_bundle(
            &d,
            project.root(),
            &bundle,
            &cancel,
            Limits::default(),
            |_, _| {},
        )
        .unwrap();
        let PreparedImport::Ready(bundle_prepared) = prepare(
            &bundle,
            &root.join("imports"),
            &root.join("local"),
            None,
            &cancel,
            |_, _| {},
        )
        .unwrap() else {
            panic!("bundle must be complete")
        };
        assert_eq!(bundle_prepared.repo.manifest().format_version, 2);
        let unadopted = bundle_prepared.repo.root().to_path_buf();
        drop(bundle_prepared);
        assert!(!unadopted.exists());
        assert_eq!(fs::read_dir(root.join("imports")).unwrap().count(), 1);
        drop((copy, repo, project, decoded));
        std::fs::remove_dir_all(root).unwrap();
    }
}
