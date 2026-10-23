use super::{model::*, validation::*};
use crate::error::{AppError, Result};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};

pub(crate) fn normalized_login(login: &str) -> Result<String> {
    let login = login.trim().to_lowercase();
    require(
        (1..=64).contains(&login.chars().count())
            && login.len() <= 256
            && !login.chars().any(char::is_control),
        "Invalid account name",
    )?;
    Ok(login)
}
fn display_name(value: &str) -> Result<()> {
    require(
        !value.trim().is_empty()
            && (1..=64).contains(&value.chars().count())
            && value.len() <= 256
            && !value.chars().any(char::is_control),
        "Invalid display name",
    )
}
fn password(value: &str) -> Result<()> {
    require(
        (8..=128).contains(&value.chars().count()) && value.len() <= 512,
        "Password must contain 8–128 characters and at most 512 bytes",
    )
}
fn algorithm() -> Argon2<'static> {
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19456, 2, 1, Some(32)).expect("fixed Argon2 parameters"),
    )
}
fn validated_phc(value: &str) -> Result<PasswordHash<'_>> {
    // Bound external work BEFORE allowing the verifier to construct Argon2 from untrusted parameters.
    require(
        value.len() <= 128 && value.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
        "Unsupported account credential parameters",
    )?;
    let phc =
        PasswordHash::new(value).map_err(|_| AppError::invalid("Malformed account credential"))?;
    require(
        phc.algorithm.as_str() == "argon2id"
            && phc.version == Some(19)
            && phc.params.iter().count() == 3
            && phc.hash.as_ref().is_some_and(|h| h.len() == 32),
        "Invalid account credential contract",
    )?;
    let mut salt = [0u8; 64];
    let decoded = phc
        .salt
        .ok_or_else(|| AppError::invalid("Missing account salt"))?
        .decode_b64(&mut salt)
        .map_err(|_| AppError::invalid("Invalid account salt"))?;
    require(decoded.len() == 16, "Invalid account salt length")?;
    Ok(phc)
}
pub(crate) fn filename(login: &str) -> String {
    format!("{}.json", hash(login.as_bytes()))
}
impl AccountRecord {
    pub fn parse(bytes: &[u8], project_id: &str) -> Result<Self> {
        let account: Self = decode(bytes, MAX_ACCOUNT_BYTES, ACCOUNT_KIND)?;
        uuid(&account.project_id)?;
        uuid(&account.identity.author_id)?;
        require(account.project_id == project_id, "Account project mismatch")?;
        require(
            normalized_login(&account.identity.normalized_login)?
                == account.identity.normalized_login,
            "Account name is not canonical",
        )?;
        display_name(&account.identity.display_name)?;
        require(
            account.identity.created_at.ends_with('Z')
                && chrono::DateTime::parse_from_rfc3339(&account.identity.created_at).is_ok(),
            "Invalid account creation time",
        )?;
        validated_phc(&account.password_hash)?;
        Ok(account)
    }
    pub(crate) fn create(
        project_id: &str,
        login: &str,
        display: &str,
        secret: &str,
    ) -> Result<Self> {
        let login = normalized_login(login)?;
        display_name(display)?;
        password(secret)?;
        // Two v4 UUID draws retain at least 128 random bits despite UUID version/variant bits.
        let first = uuid::Uuid::new_v4();
        let second = uuid::Uuid::new_v4();
        let mut random = [0u8; 16];
        random[..8].copy_from_slice(&first.as_bytes()[8..]);
        random[8..].copy_from_slice(&second.as_bytes()[8..]);
        random[0] = first.as_bytes()[0];
        random[8] = second.as_bytes()[0];
        let salt = SaltString::encode_b64(&random)
            .map_err(|_| AppError::invalid("Cannot encode account salt"))?;
        let password_hash = algorithm()
            .hash_password(secret.as_bytes(), &salt)
            .map_err(|_| AppError::invalid("Cannot create account credential"))?
            .to_string();
        Ok(Self {
            kind: ACCOUNT_KIND.into(),
            format_version: 1,
            project_id: project_id.into(),
            identity: AuthorIdentity {
                author_id: uuid::Uuid::new_v4().to_string(),
                normalized_login: login,
                display_name: display.into(),
                created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            },
            password_hash,
        })
    }
    pub(crate) fn verify(&self, secret: &str) -> Result<()> {
        password(secret)?;
        let phc = validated_phc(&self.password_hash)?;
        algorithm()
            .verify_password(secret.as_bytes(), &phc)
            .map_err(|_| AppError::invalid("Incorrect account name or password"))
    }
}
