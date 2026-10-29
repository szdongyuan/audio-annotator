use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Generic,
    Jingcheng,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    pub mode: Mode,
    pub recursive: bool,
    pub extensions: Vec<String>,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub include_second: bool,
    #[serde(default = "default_skip_duplicates")]
    pub skip_duplicates: bool,
}
fn default_skip_duplicates() -> bool {
    true
}
impl Default for Rules {
    fn default() -> Self {
        Self {
            mode: Mode::Generic,
            recursive: true,
            extensions: vec!["wav".into(), "flac".into(), "mp3".into()],
            include: vec!["**/*".into()],
            exclude: vec![],
            include_second: true,
            skip_duplicates: true,
        }
    }
}
impl Rules {
    pub fn validate(&self) -> Result<()> {
        if self.extensions.is_empty()
            || self.extensions.len() > 3
            || self.extensions.iter().any(|s| {
                !["wav", "flac", "mp3"]
                    .iter()
                    .any(|e| s.eq_ignore_ascii_case(e))
            })
            || self.include.is_empty()
            || self.include.len() + self.exclude.len() > 256
        {
            return Err(AppError::invalid("扩展名或规则数量无效"));
        }
        for p in self.include.iter().chain(&self.exclude) {
            if p.is_empty()
                || p.chars().count() > 512
                || p.starts_with('/')
                || p.chars().any(|c| c.is_control() || "\\:[]{};,".contains(c))
                || p.split('/').any(|s| {
                    s.is_empty() || s == "." || s == ".." || (s.contains("**") && s != "**")
                })
            {
                return Err(AppError::invalid("无效通配规则：使用相对路径及 *、?、**"));
            }
        }
        Ok(())
    }
    pub fn matches(&self, path: &str) -> bool {
        if path.chars().count() > 4096 || (!self.recursive && path.contains('/')) {
            return false;
        }
        let Some((stem, ext)) = path.rsplit_once('.') else {
            return false;
        };
        if !self.extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
            return false;
        }
        let matches = |p: &String| {
            let p = p
                .strip_prefix("*/")
                .map(|p| format!("**/{p}"))
                .unwrap_or_else(|| p.clone())
                .to_lowercase();
            let target = if p.rsplit('/').next().is_some_and(|s| !s.contains('.')) {
                stem
            } else {
                path
            };
            wildcard(&p, &target.to_lowercase())
        };
        self.include.iter().any(matches) && !self.exclude.iter().any(matches)
    }
}

/// Dynamic programming uses O(path length) space and O(pattern × path) time.
/// `**/` is one token, accepting either no directory or a prefix ending in `/`.
fn wildcard(pattern: &str, path: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = path.chars().collect();
    let mut next = vec![false; s.len() + 1];
    next[s.len()] = true;
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < p.len() {
        if p[i] == '*' && p.get(i + 1) == Some(&'*') {
            if p.get(i + 2) == Some(&'/') {
                tokens.push('D');
                i += 3;
            } else {
                tokens.push('A');
                i += 2;
            }
        } else {
            tokens.push(p[i]);
            i += 1;
        }
    }
    for token in tokens.into_iter().rev() {
        let mut current = vec![false; s.len() + 1];
        let mut directory_suffix = false;
        for j in (0..=s.len()).rev() {
            current[j] = match token {
                'D' => {
                    if j < s.len() && s[j] == '/' && next[j + 1] {
                        directory_suffix = true;
                    }
                    next[j] || directory_suffix
                }
                'A' => next[j] || (j < s.len() && current[j + 1]),
                '*' => next[j] || (j < s.len() && s[j] != '/' && current[j + 1]),
                '?' => j < s.len() && s[j] != '/' && next[j + 1],
                c => j < s.len() && s[j] == c && next[j + 1],
            };
        }
        next = current;
    }
    next[0]
}
