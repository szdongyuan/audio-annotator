use super::*;
use std::collections::{HashMap, HashSet};
#[derive(Deserialize)]
struct Manifest {
    schema: String,
    audio: Audio,
}
#[derive(Deserialize)]
struct Audio {
    channels: Vec<Channel>,
}
#[derive(Deserialize)]
struct Channel {
    position: u32,
    path: String,
}
pub(super) fn routes(
    entries: &[Entry],
    source: usize,
    result: &mut ScanResult,
    mut read: impl FnMut(&Entry) -> Result<Vec<u8>>,
    recursive: bool,
) -> Result<HashMap<String, u32>> {
    let names: HashSet<_> = entries.iter().map(|e| e.path.to_lowercase()).collect();
    let mut routes = HashMap::new();
    for entry in entries.iter().filter(|e| {
        super::discovery::manifest_path(&e.path) && (recursive || !e.path.contains('/'))
    }) {
        let path = &entry.path;
        let parsed = parse(&read(entry)?, path);
        let assignments = match parsed {
            Ok(a) => a,
            Err(e) => {
                result.issue(source, path, e.message);
                continue;
            }
        };
        for (audio, position) in assignments {
            if position > 2 || position == 0 {
                result.issue(source, &audio, "精成预设仅支持逻辑位置 1、2");
                continue;
            }
            if !names.contains(&audio.to_lowercase()) {
                result.issue(source, &audio, "清单音频缺失");
                continue;
            }
            routes.insert(audio.to_lowercase(), position);
        }
    }
    for entry in entries {
        if ["wav", "flac", "mp3"]
            .iter()
            .any(|ext| entry.path.to_lowercase().ends_with(&format!(".{ext}")))
            && !routes.contains_key(&entry.path.to_lowercase())
        {
            result.issue(source, &entry.path, "没有有效且唯一的精成录音清单映射");
        }
    }
    Ok(routes)
}
fn parse(bytes: &[u8], path: &str) -> Result<Vec<(String, u32)>> {
    let m: Manifest =
        serde_json::from_slice(bytes).map_err(|e| invalid(format!("精成清单无效：{e}")))?;
    if m.schema != "jingcheng-run-export-record/v2" || m.audio.channels.is_empty() {
        return Err(invalid("不支持或为空的精成清单"));
    }
    let directory = path
        .rsplit_once('/')
        .map(|(p, _)| format!("{p}/"))
        .unwrap_or_default();
    let mut positions = HashSet::new();
    let mut physical = HashSet::new();
    let mut resolved = vec![];
    for channel in m.audio.channels {
        super::archive::safe_path(&channel.path)?;
        if channel.path.starts_with('/')
            || channel.path.contains(['\\', ':', '\0'])
            || channel
                .path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return Err(invalid("清单音频路径不安全"));
        }
        let parts: Vec<_> = channel.path.split('/').collect();
        if parts.len() < 2 || parts[parts.len() - 2] != "audio" {
            return Err(invalid("清单路径必须以 audio/文件名 结尾"));
        }
        let basename = parts.last().unwrap();
        if !positions.insert(channel.position) || !physical.insert(basename.to_lowercase()) {
            return Err(invalid("清单逻辑位置或物理音频重复"));
        }
        resolved.push((format!("{directory}audio/{basename}"), channel.position));
    }
    Ok(resolved)
}
