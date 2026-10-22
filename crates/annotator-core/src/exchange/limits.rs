use super::{invalid, io, limit};
use crate::error::Result;
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom},
};
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub manifest_bytes: u64,
    pub entries: u64,
    pub total_bytes: u64,
    pub media_bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            manifest_bytes: 16 * 1024 * 1024,
            entries: 4096,
            total_bytes: 20 * 1024 * 1024 * 1024,
            media_bytes: 8 * 1024 * 1024 * 1024,
        }
    }
}
pub fn safe_path(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 256
        || !name.is_ascii()
        || name.contains(['\\', ':'])
        || name.starts_with('/')
    {
        return Err(invalid("禁止绝对路径、反斜线或特殊 ZIP 路径"));
    }
    for part in name.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.bytes().any(|b| b < 32 || b"<>\"|?*".contains(&b))
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(invalid("禁止不安全的 Windows 文件名"));
        }
    }
    Ok(())
}
fn u16le(b: &[u8]) -> u64 {
    u16::from_le_bytes(b[..2].try_into().unwrap()) as u64
}
fn u32le(b: &[u8]) -> u64 {
    u32::from_le_bytes(b[..4].try_into().unwrap()) as u64
}
fn u64le(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}
/// Bound and count raw central records BEFORE zip allocates its index (which deduplicates names).
/// Supports ordinary and ZIP64 packages, including >4 GiB stored media.
pub fn preflight(file: &mut File, limits: Limits) -> Result<usize> {
    let len = file.metadata().map_err(io)?.len();
    let tail_len = len.min(65557) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64))).map_err(io)?;
    let mut tail = vec![0; tail_len];
    file.read_exact(&mut tail).map_err(io)?;
    let end = (0..tail_len.saturating_sub(21))
        .rev()
        .find(|&i| {
            tail[i..].starts_with(b"PK\x05\x06")
                && i + 22 + u16le(&tail[i + 20..]) as usize == tail_len
        })
        .ok_or_else(|| invalid("缺少 ZIP 结束记录"))?;
    let e = &tail[end..];
    if u16le(&e[4..]) != 0 || u16le(&e[6..]) != 0 || u16le(&e[8..]) != u16le(&e[10..]) {
        return Err(invalid("不支持分卷 ZIP"));
    }
    let mut count = u16le(&e[10..]);
    let mut size = u32le(&e[12..]);
    let mut offset = u32le(&e[16..]);
    let mut directory_end = len - tail_len as u64 + end as u64;
    if count == 65535 || size == u32::MAX as u64 || offset == u32::MAX as u64 {
        let pos = len - tail_len as u64 + end as u64;
        if pos < 20 {
            return Err(invalid("无效 ZIP64"));
        }
        file.seek(SeekFrom::Start(pos - 20)).map_err(io)?;
        let mut loc = [0; 20];
        file.read_exact(&mut loc).map_err(io)?;
        if &loc[..4] != b"PK\x06\x07" || u32le(&loc[4..]) != 0 || u32le(&loc[16..]) != 1 {
            return Err(invalid("无效 ZIP64 定位"));
        }
        let at = u64le(&loc[8..]);
        if at > pos.saturating_sub(76) {
            return Err(invalid("ZIP64 越界"));
        }
        file.seek(SeekFrom::Start(at)).map_err(io)?;
        let mut z = [0; 56];
        file.read_exact(&mut z).map_err(io)?;
        if &z[..4] != b"PK\x06\x06"
            || u64le(&z[4..]) != 44
            || at.checked_add(56) != Some(pos - 20)
            || u32le(&z[16..]) != 0
            || u32le(&z[20..]) != 0
            || u64le(&z[24..]) != u64le(&z[32..])
        {
            return Err(invalid("无效 ZIP64 记录"));
        }
        count = u64le(&z[32..]);
        size = u64le(&z[40..]);
        offset = u64le(&z[48..]);
        directory_end = at;
    }
    if count > limits.entries || size > 16 * 1024 * 1024 {
        return Err(limit());
    }
    let finish = offset
        .checked_add(size)
        .filter(|&n| n == directory_end)
        .ok_or_else(|| invalid("ZIP 索引越界"))?;
    file.seek(SeekFrom::Start(offset)).map_err(io)?;
    let mut names = HashSet::new();
    let mut actual = 0;
    while file.stream_position().map_err(io)? < finish {
        actual += 1;
        if actual > limits.entries {
            return Err(limit());
        }
        let mut header = [0; 46];
        file.read_exact(&mut header).map_err(io)?;
        if &header[..4] != b"PK\x01\x02" {
            return Err(invalid("ZIP 索引无效"));
        }
        let name_len = u16le(&header[28..]);
        let extra = u16le(&header[30..]);
        let comment = u16le(&header[32..]);
        if name_len > 256 || u16le(&header[34..]) != 0 || u16le(&header[8..]) & 1 != 0 {
            return Err(invalid("加密、分卷或过长的 ZIP 路径"));
        }
        let mut name = vec![0; name_len as usize];
        file.read_exact(&mut name).map_err(io)?;
        let name = std::str::from_utf8(&name).map_err(|_| invalid("ZIP 路径不是 UTF-8"))?;
        safe_path(name)?;
        if !names.insert(name.to_ascii_lowercase()) {
            return Err(invalid("ZIP 条目大小写重名"));
        }
        let mode = (u32le(&header[38..]) >> 16) as u32;
        let kind = mode & 0o170000;
        if (kind != 0 && kind != 0o100000) || u32le(&header[38..]) & 0x10 != 0 {
            return Err(invalid("禁止链接、目录或特殊条目"));
        }
        file.seek(SeekFrom::Current((extra + comment) as i64))
            .map_err(io)?;
    }
    if actual != count || file.stream_position().map_err(io)? != finish {
        return Err(invalid("ZIP 条目数或索引大小不一致"));
    }
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    Ok(actual as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn rejects_an_index_that_does_not_end_at_the_end_record() {
        let p = std::env::temp_dir().join(format!("zip-index-{}", uuid::Uuid::new_v4()));
        let mut writer = zip::ZipWriter::new(File::create(&p).unwrap());
        writer
            .start_file("manifest.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"{}").unwrap();
        writer.finish().unwrap();
        let mut bytes = std::fs::read(&p).unwrap();
        let end = bytes.len() - 22;
        bytes.splice(end..end, b"JUNK".iter().copied());
        std::fs::write(&p, bytes).unwrap();
        let error = preflight(&mut File::open(&p).unwrap(), Limits::default()).unwrap_err();
        assert_eq!(error.code, crate::error::ErrorCode::InvalidArchive);
        std::fs::remove_file(p).unwrap();
    }
}
