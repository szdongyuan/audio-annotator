use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowFunction {
    Hann,
    Hamming,
    Blackman,
    Rectangular,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisSettings {
    pub window: WindowFunction,
    pub window_size: u32,
    pub hop_size: u32,
    pub fft_size: u32,
    pub mel_bands: u32,
}
impl Default for AnalysisSettings {
    fn default() -> Self {
        Self {
            window: WindowFunction::Hann,
            window_size: 2048,
            hop_size: 512,
            fft_size: 2048,
            mel_bands: 128,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpectrumKind {
    Stft,
    Mel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaView {
    pub visible_channels: Vec<u8>,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub low_hz: f64,
    pub high_hz: f64,
    pub frequency_mix: f64,
    pub spectrum_kind: SpectrumKind,
    pub gain_db: f64,
    pub dynamic_range_db: f64,
    pub palette: String,
}
