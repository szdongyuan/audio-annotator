//! Device-user credentials. This capability deliberately implements neither Debug nor Serialize.
use super::{atomic, validation::*};
use crate::error::{AppError, ErrorCode, Result};
use std::{
    fs::File,
    path::Path,
    time::{Duration, Instant},
};

pub(crate) const LOCAL_PREFIX: &str = "@local:";
/// A native credential capability, never a public DTO or log value.
/// ```compile_fail
/// use annotator_core::collaboration::LocalIdentity;
/// fn expose(identity: &LocalIdentity) { let _ = serde_json::to_vec(identity); }
/// ```
/// ```compile_fail
/// use annotator_core::collaboration::LocalIdentity;
/// fn log(identity: &LocalIdentity) { println!("{identity:?}"); }
/// ```
pub struct LocalIdentity {
    pub(super) login: String,
    pub(super) secret: String,
    display: String,
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedIdentity {
    version: u32,
    id: String,
    secret: String,
}

pub(crate) fn short_lock(path: &Path) -> Result<File> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match atomic::lock(path) {
            Err(error) if error.code == ErrorCode::ProjectLocked && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10))
            }
            result => return result,
        }
    }
}
impl LocalIdentity {
    pub fn login_name(&self) -> &str {
        &self.login
    }
    pub fn display_name(&self) -> &str {
        &self.display
    }
    /// The caller supplies an existing private application-data directory, never a project directory.
    pub fn load_or_create(local_root: &Path) -> Result<Self> {
        atomic::safe_existing(local_root)?;
        let _lock = short_lock(&local_root.join(".local-identity.lock"))?;
        let path = local_root.join("local-identity.dpapi");
        let stored = if path.try_exists().map_err(atomic::io)? {
            let encrypted = atomic::read(&path, 16384)?;
            let clear = protect(&encrypted, false)?;
            limit(clear.len() <= 1024)?;
            serde_json::from_slice::<ProtectedIdentity>(&clear)
                .map_err(|_| AppError::invalid("Invalid protected local identity"))?
        } else {
            let stored = ProtectedIdentity {
                version: 1,
                id: uuid::Uuid::new_v4().to_string(),
                secret: format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                ),
            };
            let clear = serde_json::to_vec(&stored)
                .map_err(|_| AppError::invalid("Cannot encode local identity"))?;
            let encrypted = protect(&clear, true)?;
            atomic::publish_new(&path, &encrypted, None, None)?;
            stored
        };
        require(stored.version == 1, "Unsupported local identity version")?;
        uuid(&stored.id)?;
        require(
            stored.secret.len() == 64 && stored.secret.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid local identity secret",
        )?;
        Ok(Self {
            login: format!("{LOCAL_PREFIX}{}", stored.id),
            display: format!("本机作者 · {}", &stored.id[..8]),
            secret: stored.secret,
        })
    }
}
#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>> {
    Err(AppError::new(
        ErrorCode::UnsupportedFormat,
        "Local identity requires Windows CurrentUser DPAPI",
    ))
}
#[cfg(windows)]
fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    limit(bytes.len() <= 16384)?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI does not mutate input. No LOCAL_MACHINE flag: encryption is bound to CurrentUser.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(AppError::invalid(
            "Cannot protect or decrypt local identity with Windows CurrentUser DPAPI",
        ));
    }
    // The successful DPAPI allocation remains valid until LocalFree; bound before copying.
    let result = if output.cbData as usize > 16384 || output.pbData.is_null() {
        Err(AppError::invalid("Invalid DPAPI output"))
    } else {
        Ok(unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec())
    };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    result
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_ciphertext_contains_no_plaintext_credentials() {
        let plain = b"secret-credential-for-identity-test";
        let encrypted = protect(plain, true).unwrap();
        assert!(!encrypted.windows(plain.len()).any(|b| b == plain));
        assert_eq!(protect(&encrypted, false).unwrap(), plain);
    }
    #[test]
    fn persisted_identity_and_public_project_snapshots_never_expose_secret() {
        let root =
            std::env::temp_dir().join(format!("local-secret-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let identity = LocalIdentity::load_or_create(&root).unwrap();
        let saved = std::fs::read(root.join("local-identity.dpapi")).unwrap();
        assert!(!saved
            .windows(identity.secret.len())
            .any(|w| w == identity.secret.as_bytes()));
        let project = root.join("project");
        std::fs::create_dir(&project).unwrap();
        let (repo, session) = super::super::CollaborationRepository::create_default(
            &project,
            "Secret check",
            &identity,
        )
        .unwrap();
        let public = serde_json::to_string(&repo.snapshot().unwrap()).unwrap();
        assert!(!public.contains(&identity.secret));
        assert!(!public.contains("passwordHash"));
        let accounts = std::fs::read_dir(project.join("accounts")).unwrap();
        for entry in accounts {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|s| s == "json") {
                assert!(!std::fs::read_to_string(path)
                    .unwrap()
                    .contains(&identity.secret));
            }
        }
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
    }
}
