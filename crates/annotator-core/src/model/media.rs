use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaDescriptor {
    pub id: String,
    pub display_name: String,
    pub source_ref: String,
    pub sha256: String,
    pub byte_length: u64,
    pub sample_rate: u32,
    pub frame_count: u64,
    pub channel_count: u8,
    #[serde(deserialize_with = "super::required_nullable")]
    pub channel_layout: Option<Vec<String>>,
    pub note: String,
    pub channel_notes: Vec<String>,
}
impl MediaDescriptor {
    pub fn duration(&self) -> f64 {
        self.frame_count as f64 / self.sample_rate as f64
    }
    pub fn nyquist(&self) -> f64 {
        self.sample_rate as f64 / 2.0
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybackMix {
    pub solo_channels: Vec<u8>,
    pub muted_channels: Vec<u8>,
}
