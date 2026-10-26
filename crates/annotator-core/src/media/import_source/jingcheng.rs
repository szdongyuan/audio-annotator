use super::*;
use std::collections::{HashMap, HashSet};
#[derive(Deserialize)]
struct Manifest {
    schema: String,
    audio: Audio,
    run: Option<serde_json::Value>,
    outcome: Option<serde_json::Value>,
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
#[derive(Clone, Debug)]
pub(super) struct Route {
    pub position: u32,
    pub record: String,
    pub date: Option<String>,
    pub result: Option<String>,
    pub fault_type: Option<String>,
    pub model: Option<String>,
    pub invalid_fields: Vec<&'static str>,
}
pub(super) fn routes(
    entries: &[Entry],
    source: usize,
    result: &mut ScanResult,
    mut read: impl FnMut(&Entry) -> Result<Vec<u8>>,
    recursive: bool,
) -> Result<HashMap<String, Route>> {
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
        for (audio, route) in assignments {
            let position = route.position;
            if position > 2 || position == 0 {
                result.issue(source, &audio, "精成预设仅支持逻辑位置 1、2");
                continue;
            }
            if !names.contains(&audio.to_lowercase()) {
                result.issue(source, &audio, "清单音频缺失");
                continue;
            }
            routes.insert(audio.to_lowercase(), route);
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
fn parse(bytes: &[u8], path: &str) -> Result<Vec<(String, Route)>> {
    let m: Manifest =
        serde_json::from_slice(bytes).map_err(|e| invalid(format!("精成清单无效：{e}")))?;
    if m.schema != "jingcheng-run-export-record/v2" || m.audio.channels.is_empty() {
        return Err(invalid("不支持或为空的精成清单"));
    }
    let directory = path
        .rsplit_once('/')
        .map(|(p, _)| format!("{p}/"))
        .unwrap_or_default();
    let mut invalid_fields = vec![];
    let date = raw_field(&m.run, "accepted_at")
        .map(str::trim)
        .filter(|s| s.len() <= 128)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.format("%Y-%m-%d").to_string());
    let record = bounded_field(
        Some(
            directory
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(""),
        ),
        "{record}",
        false,
        &mut invalid_fields,
    )
    .unwrap_or_default();
    let result = bounded_field(
        raw_field(&m.outcome, "result"),
        "{result}",
        true,
        &mut invalid_fields,
    );
    let fault_type = bounded_field(
        raw_field(&m.outcome, "fault_type"),
        "{faultType}",
        true,
        &mut invalid_fields,
    );
    let model = bounded_field(
        raw_field(&m.run, "model"),
        "{model}",
        true,
        &mut invalid_fields,
    );
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
        resolved.push((
            format!("{directory}audio/{basename}"),
            Route {
                position: channel.position,
                record: record.clone(),
                date: date.clone(),
                result: result.clone(),
                fault_type: fault_type.clone(),
                model: model.clone(),
                invalid_fields: invalid_fields.clone(),
            },
        ));
    }
    Ok(resolved)
}

fn raw_field<'a>(object: &'a Option<serde_json::Value>, key: &str) -> Option<&'a str> {
    object.as_ref()?.get(key)?.as_str()
}
fn bounded_field(
    value: Option<&str>,
    token: &'static str,
    trim: bool,
    invalid: &mut Vec<&'static str>,
) -> Option<String> {
    let value = value?;
    let value = if trim { value.trim() } else { value };
    if value.is_empty() {
        return None;
    }
    // Bound retained route metadata before allocating/cloning it for logical channels.
    if value.len() > 512 || value.chars().count() > 128 {
        invalid.push(token);
        return None;
    }
    let value = value.replace(['/', '\\'], "_");
    if super::organization::name(&value, true).is_err() {
        invalid.push(token);
        return None;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    #[test]
    fn optional_metadata_is_bounded_before_retaining_routes() {
        let bytes=serde_json::to_vec(&serde_json::json!({"schema":"jingcheng-run-export-record/v2","audio":{"channels":[{"position":1,"path":"audio/CH2.wav"}]},"run":{"model":"m".repeat(200_000)},"outcome":{"result":"NG","fault_type":"f".repeat(200_000)}})).unwrap();
        let routes = super::parse(&bytes, "record/manifest.json").unwrap();
        assert!(routes[0]
            .1
            .model
            .as_ref()
            .is_none_or(|value| value.len() <= 512));
        assert!(routes[0]
            .1
            .fault_type
            .as_ref()
            .is_none_or(|value| value.len() <= 512));
    }
}
