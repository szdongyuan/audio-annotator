//! Pure placement planning; publication authority remains in the native scan task.
use super::*;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OrganizationMode {
    SourcePath,
    #[default]
    Flat,
    Template,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrganizationConfig {
    #[serde(deserialize_with = "crate::model::required_nullable")]
    pub target_folder_id: Option<String>,
    pub mode: OrganizationMode,
    pub wrap_source: bool,
    pub strip_components: Vec<String>,
    pub template: String,
}
impl Default for OrganizationConfig {
    fn default() -> Self {
        Self {
            target_folder_id: None,
            mode: OrganizationMode::Flat,
            wrap_source: false,
            strip_components: vec![],
            template: "{source}/{relativeDir}".into(),
        }
    }
}
pub(super) fn name(value: &str, folder: bool) -> Result<()> {
    if value.is_empty()
        || value.chars().count() > if folder { 128 } else { 255 }
        || value.len() > if folder { 512 } else { 1024 }
        || value
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        || value == "."
        || value == ".."
        || (folder && value.trim() != value)
    {
        return Err(AppError::invalid("生成目录或原始文件名无效或过长"));
    }
    Ok(())
}
impl OrganizationConfig {
    pub fn validate(&self, mode: Mode) -> Result<()> {
        if let Some(id) = &self.target_folder_id {
            let parsed =
                uuid::Uuid::parse_str(id).map_err(|_| AppError::invalid("无效目标目录"))?;
            if parsed.is_nil() || parsed.to_string() != *id {
                return Err(AppError::invalid("无效目标目录"));
            }
        }
        if self.strip_components.len() > 32 || self.template.len() > 4096 {
            return Err(limit());
        }
        for part in &self.strip_components {
            name(part, true)?;
        }
        // Reject unsupported templates before touching a source, including dormant settings.
        if self
            .template
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && self.template.as_bytes().get(1..3) == Some(b":/")
        {
            return Err(AppError::invalid("目录模板不能是绝对路径"));
        }
        let parts: Vec<_> = self.template.split('/').collect();
        if parts.is_empty() || parts.len() > 16 {
            return Err(AppError::invalid("目录模板超过 16 层"));
        }
        for part in parts {
            if part.starts_with('{') && part.ends_with('}') {
                if ![
                    "{source}",
                    "{relativeDir}",
                    "{record}",
                    "{date}",
                    "{result}",
                    "{faultType}",
                    "{model}",
                    "{route}",
                ]
                .contains(&part)
                    || (mode == Mode::Generic && !["{source}", "{relativeDir}"].contains(&part))
                {
                    return Err(AppError::invalid("当前解析器不支持目录模板字段"));
                }
            } else {
                if part.contains(['{', '}']) {
                    return Err(AppError::invalid("模板字段必须占据完整目录段"));
                }
                name(part, true)?;
            }
        }
        Ok(())
    }
    pub(super) fn plan(
        &self,
        source: &str,
        path: &str,
        route: Option<&super::jingcheng::Route>,
    ) -> Result<(Vec<String>, Vec<String>)> {
        let relative: Vec<String> = path
            .rsplit_once('/')
            .map(|(p, _)| {
                p.split('/')
                    .filter(|s| {
                        !self
                            .strip_components
                            .iter()
                            .any(|strip| strip.to_lowercase() == s.to_lowercase())
                    })
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let mut missing = vec![];
        let mut parts = match self.mode {
            OrganizationMode::Flat => vec![],
            OrganizationMode::SourcePath => {
                let mut p = vec![];
                if self.wrap_source {
                    p.push(source.into());
                }
                p.extend(relative.clone());
                p
            }
            OrganizationMode::Template => {
                let mut p = vec![];
                for token in self.template.split('/') {
                    if route.is_some_and(|r| r.invalid_fields.contains(&token)) {
                        return Err(AppError::invalid(format!("目录字段 {token} 无效或过长")));
                    }
                    if token == "{relativeDir}" {
                        p.extend(relative.clone());
                        continue;
                    }
                    let optional =
                        |value: Option<&str>, fallback: &str, missing: &mut Vec<String>| {
                            value
                                .filter(|v| !v.trim().is_empty())
                                .map(|v| v.trim().replace(['/', '\\'], "_"))
                                .unwrap_or_else(|| {
                                    missing.push(format!("缺少 {}，使用 {}", token, fallback));
                                    fallback.into()
                                })
                        };
                    p.push(match token {
                        "{source}" => source.into(),
                        "{record}" => {
                            optional(route.map(|r| r.record.as_str()), "记录未知", &mut missing)
                        }
                        "{date}" => optional(
                            route.and_then(|r| r.date.as_deref()),
                            "日期未知",
                            &mut missing,
                        ),
                        "{result}" => optional(
                            route.and_then(|r| r.result.as_deref()),
                            "未分类",
                            &mut missing,
                        ),
                        "{faultType}" => optional(
                            route.and_then(|r| r.fault_type.as_deref()),
                            "未分类",
                            &mut missing,
                        ),
                        "{model}" => optional(
                            route.and_then(|r| r.model.as_deref()),
                            "型号未知",
                            &mut missing,
                        ),
                        "{route}" => match route.map(|r| r.position) {
                            Some(1) => "第一路".into(),
                            Some(2) => "第二路".into(),
                            _ => return Err(AppError::invalid("缺少逻辑路线")),
                        },
                        literal => literal.into(),
                    });
                }
                p
            }
        };
        if parts.len() > 16 {
            return Err(AppError::invalid("生成目录超过 16 层"));
        }
        for part in &parts {
            name(part, true)?;
        }
        parts.shrink_to_fit();
        Ok((parts, missing))
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSummary {
    pub index: usize,
    pub parent_index: Option<usize>,
    pub name: String,
    pub media_count: usize,
}
