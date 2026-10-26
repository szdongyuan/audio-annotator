use super::*;
use crate::media::identity::check_cancel;
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::Path,
    sync::atomic::AtomicBool,
};

pub fn scan(
    config: &Config,
    cancel: &AtomicBool,
    limits: Limits,
    mut progress: impl FnMut(&Counts),
) -> Result<ScanResult> {
    config.validate()?;
    limits.validate()?;
    check_cancel(cancel)?;
    let mut result = ScanResult {
        counts: Counts::default(),
        issues: vec![],
        candidates: vec![],
        entries: vec![],
        sources: vec![],
        limits,
    };
    for (source_index, raw) in config.paths.iter().enumerate() {
        check_cancel(cancel)?;
        let raw = Path::new(raw);
        super::staging::safe_ancestors(raw)?;
        if reparse(&fs::symlink_metadata(raw).map_err(io)?) {
            return Err(AppError::invalid("导入源不能是链接或重解析点"));
        }
        let path = raw.canonicalize().map_err(io)?;
        let source_name = path
            .file_name()
            .and_then(|p| p.to_str())
            .ok_or_else(|| AppError::invalid("无效源路径"))?
            .to_owned();
        let mut source = Source {
            path: path.clone(),
            kind: config.kind,
            stamp: None,
            manifests: HashMap::new(),
        };
        let mut entries = vec![];
        match config.kind {
            SourceKind::Folder => {
                let mut stack = vec![(path.clone(), fs::read_dir(&path).map_err(io)?)];
                while let Some((directory, iterator)) = stack.last_mut() {
                    check_cancel(cancel)?;
                    let Some(entry) = iterator.next() else {
                        stack.pop();
                        continue;
                    };
                    checked(&mut result, limits)?;
                    progress(&result.counts);
                    check_cancel(cancel)?;
                    let entry = match entry {
                        Ok(e) => e,
                        Err(e) => {
                            result.issue(source_index, &directory.to_string_lossy(), e.to_string());
                            continue;
                        }
                    };
                    let full = entry.path();
                    let relative = full
                        .strip_prefix(&path)
                        .unwrap()
                        .to_str()
                        .ok_or_else(|| AppError::invalid("路径不是 Unicode"))?
                        .replace('\\', "/");
                    if relative.chars().count() > 4096 {
                        return Err(limit());
                    }
                    let metadata = match fs::symlink_metadata(&full) {
                        Ok(m) => m,
                        Err(e) => {
                            result.issue(source_index, &relative, e.to_string());
                            continue;
                        }
                    };
                    if reparse(&metadata) {
                        result.issue(source_index, &relative, "跳过链接或重解析点");
                        result.counts.skipped += 1;
                        continue;
                    }
                    if metadata.is_dir() {
                        if config.rules.recursive {
                            match fs::read_dir(&full) {
                                Ok(it) => stack.push((full, it)),
                                Err(e) => result.issue(source_index, &relative, e.to_string()),
                            }
                        }
                        continue;
                    }
                    if !metadata.is_file() {
                        continue;
                    }
                    let stamp = SourceStamp::read(&full)?;
                    entries.push(Entry {
                        path: relative,
                        size: metadata.len(),
                        zip_index: None,
                        stamp: Some(stamp),
                    });
                }
            }
            SourceKind::Zip => {
                source.stamp = Some(SourceStamp::read(&path)?);
                let mut file = File::open(&path).map_err(io)?;
                let count = super::archive::preflight(
                    &mut file,
                    limits.entries.saturating_sub(result.counts.checked),
                    cancel,
                )?;
                let mut archive = zip::ZipArchive::new(file).map_err(zip_error)?;
                if count != archive.len() {
                    return Err(invalid("重复 ZIP 条目"));
                }
                let mut effective_names = std::collections::HashSet::new();
                for i in 0..archive.len() {
                    check_cancel(cancel)?;
                    checked(&mut result, limits)?;
                    progress(&result.counts);
                    let file = archive.by_index(i).map_err(zip_error)?;
                    // Unicode Path extra fields can override the raw central name
                    // checked by preflight. Validate the library's final name too,
                    // including directories before they are omitted from candidates.
                    super::archive::safe_path(file.name())?;
                    if !effective_names.insert(file.name().trim_end_matches('/').to_lowercase()) {
                        return Err(invalid("ZIP 有效条目路径大小写重名"));
                    }
                    if file.is_dir() {
                        continue;
                    }
                    let name = file.name().to_owned();
                    entries.push(Entry {
                        path: name,
                        size: file.size(),
                        zip_index: Some(i),
                        stamp: None,
                    });
                }
                source.stamp.as_ref().unwrap().verify(&path)?;
            }
        }
        let mut names = std::collections::HashSet::new();
        for entry in &entries {
            if !names.insert(entry.path.to_lowercase()) {
                return Err(invalid("源条目大小写重名"));
            }
        }
        let routes = if config.rules.mode == Mode::Jingcheng {
            let mut archive = if config.kind == SourceKind::Zip {
                Some(zip::ZipArchive::new(File::open(&path).map_err(io)?).map_err(zip_error)?)
            } else {
                None
            };
            super::jingcheng::routes(
                &entries,
                source_index,
                &mut result,
                |entry| {
                    check_cancel(cancel)?;
                    if entry.size > limits.manifest_bytes {
                        return Err(limit());
                    }
                    if let Some(archive) = archive.as_mut() {
                        read_manifest(
                            archive
                                .by_index(entry.zip_index.unwrap())
                                .map_err(zip_error)?,
                            limits,
                            cancel,
                        )
                    } else {
                        let full = path.join(&entry.path);
                        super::staging::safe_ancestors(&full)?;
                        let stamp = entry.stamp.as_ref().unwrap();
                        stamp.verify(&full)?;
                        let bytes = read_manifest(File::open(&full).map_err(io)?, limits, cancel)?;
                        stamp.verify(&full)?;
                        source.manifests.insert(
                            entry
                                .path
                                .rsplit_once('/')
                                .map(|(p, _)| p)
                                .unwrap_or("")
                                .to_lowercase(),
                            (full, stamp.clone()),
                        );
                        Ok(bytes)
                    }
                },
                config.rules.recursive,
            )?
        } else {
            HashMap::new()
        };
        if let Some(stamp) = &source.stamp {
            stamp.verify(&path)?;
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        for entry in entries {
            check_cancel(cancel)?;
            let route = routes.get(&entry.path.to_lowercase()).copied();
            if !config.rules.matches(&entry.path)
                || (config.rules.mode == Mode::Jingcheng
                    && !route.is_some_and(|p| p == 1 || (p == 2 && config.rules.include_second)))
            {
                result.counts.skipped += 1;
                continue;
            }
            if entry.size > limits.audio_bytes || result.candidates.len() >= limits.candidates {
                return Err(limit());
            }
            result.counts.selected_bytes = result
                .counts
                .selected_bytes
                .checked_add(entry.size)
                .filter(|n| *n <= limits.selected_bytes)
                .ok_or_else(limit)?;
            result.candidates.push(Candidate {
                index: result.candidates.len(),
                source_index,
                source_name: source_name.clone(),
                relative_path: entry.path.clone(),
                display_name: display_name(&source_name, &entry.path),
                byte_length: entry.size,
                logical_position: route,
            });
            result.entries.push(entry);
        }
        result.sources.push(source);
        result.counts.candidates = result.candidates.len();
        progress(&result.counts);
    }
    check_cancel(cancel)?;
    Ok(result)
}
fn checked(result: &mut ScanResult, limits: Limits) -> Result<()> {
    result.counts.checked += 1;
    if result.counts.checked > limits.entries {
        return Err(limit());
    }
    Ok(())
}
pub(super) fn manifest_path(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|n| n.eq_ignore_ascii_case("manifest.json"))
}
fn read_manifest(mut reader: impl Read, limits: Limits, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let mut bytes = vec![];
    let mut buffer = [0; 65536];
    loop {
        check_cancel(cancel)?;
        let n = reader.read(&mut buffer).map_err(io)?;
        if n == 0 {
            break;
        }
        if bytes.len() as u64 + n as u64 > limits.manifest_bytes {
            return Err(limit());
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    Ok(bytes)
}
fn display_name(source: &str, path: &str) -> String {
    let name = format!("{source}/{path}");
    if name.chars().count() <= 1024 {
        return name;
    }
    let suffix: String = path
        .chars()
        .rev()
        .take(768)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("{}…/{suffix}", source.chars().take(240).collect::<String>())
}
