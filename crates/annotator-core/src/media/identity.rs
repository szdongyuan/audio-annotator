use crate::error::{AppError, ErrorCode, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::SystemTime,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStamp {
    pub bytes: u64,
    pub modified: SystemTime,
}
impl SourceStamp {
    pub fn read(path: &Path) -> Result<Self> {
        let m = path
            .metadata()
            .map_err(|_| AppError::new(ErrorCode::MissingMedia, "音频文件不存在或不可读取"))?;
        if !m.is_file() {
            return Err(AppError::new(ErrorCode::MissingMedia, "音频路径不是文件"));
        }
        Ok(Self {
            bytes: m.len(),
            modified: m
                .modified()
                .map_err(|_| AppError::new(ErrorCode::DecodeFailed, "无法读取音频修改时间"))?,
        })
    }
    pub fn verify(&self, path: &Path) -> Result<()> {
        if &Self::read(path)? != self {
            return Err(AppError::new(
                ErrorCode::IdentityMismatch,
                "源音频已改变，请重新校验或关联",
            ));
        }
        Ok(())
    }
}
pub fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(AppError::new(ErrorCode::Cancelled, "音频导入已取消"))
    } else {
        Ok(())
    }
}
pub fn fingerprint(
    path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<String> {
    let mut input =
        File::open(path).map_err(|_| AppError::new(ErrorCode::MissingMedia, "无法打开音频"))?;
    let mut hash = Sha256::new();
    let mut block = [0_u8; 64 * 1024];
    let mut count = 0;
    loop {
        check_cancel(cancel)?;
        let n = input
            .read(&mut block)
            .map_err(|_| AppError::new(ErrorCode::DecodeFailed, "读取音频指纹失败"))?;
        if n == 0 {
            break;
        }
        hash.update(&block[..n]);
        count += n as u64;
        progress(count);
    }
    Ok(format!("{:x}", hash.finalize()))
}
