use annotator_core::{
    analysis::{
        mel::MelBank,
        stft::{frame_count, Stft},
    },
    model::{AnalysisSettings, WindowFunction},
};
use std::f64::consts::PI;
fn settings(window: WindowFunction) -> AnalysisSettings {
    AnalysisSettings {
        window,
        window_size: 1024,
        fft_size: 1024,
        hop_size: 256,
        mel_bands: 32,
    }
}
fn tone(n: usize, bin: f64, amplitude: f64) -> Vec<f32> {
    (0..n)
        .map(|i| (amplitude * (2. * PI * bin * i as f64 / 1024.).sin()) as f32)
        .collect()
}
#[test]
fn tones_have_fixed_window_normalized_amplitude_and_physical_bins() {
    for window in [
        WindowFunction::Hann,
        WindowFunction::Hamming,
        WindowFunction::Blackman,
        WindowFunction::Rectangular,
    ] {
        let mut stft = Stft::new(&settings(window)).unwrap();
        let frame = stft.frame(&tone(1024, 64., 1.)).unwrap();
        let peak = frame
            .amplitude
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        assert_eq!(peak, 64);
        assert!((frame.amplitude[64] - 1.).abs() < 1e-6);
        assert!((frame.power[64] - 0.5).abs() < 1e-6);
        assert!((stft.bin_hz(64, 48000) - 3000.).abs() < 1e-12);
        let quiet = stft.frame(&tone(1024, 64., 0.1)).unwrap();
        assert!((quiet.amplitude_db()[64] + 20.).abs() < 1e-4);
        let mut dual = tone(1024, 32., 0.4);
        for (a, b) in dual.iter_mut().zip(tone(1024, 128., 0.2)) {
            *a += b;
        }
        let dual = stft.frame(&dual).unwrap();
        assert!((dual.amplitude[32] - 0.4).abs() < 1e-6);
        assert!((dual.amplitude[128] - 0.2).abs() < 1e-6);
    }
}
#[test]
fn dc_nyquist_short_tail_and_hop_are_not_doubled_or_extended() {
    let mut stft = Stft::new(&settings(WindowFunction::Rectangular)).unwrap();
    assert_eq!(frame_count(0, 256), 0);
    assert_eq!(frame_count(1, 256), 1);
    assert_eq!(frame_count(1024, 256), 4);
    assert_eq!(frame_count(1025, 256), 5);
    assert_eq!(frame_count(1025, 512), 3);
    assert!((stft.frame(&vec![0.5; 1024]).unwrap().amplitude[0] - 0.5).abs() < 1e-12);
    let nyquist: Vec<_> = (0..1024)
        .map(|i| if i % 2 == 0 { 0.5 } else { -0.5 })
        .collect();
    assert!((stft.frame(&nyquist).unwrap().amplitude[512] - 0.5).abs() < 1e-12);
    assert!((stft.frame(&vec![1.; 64]).unwrap().amplitude[0] - 0.0625).abs() < 1e-12);
    assert!(stft
        .frame(&vec![0.; 1024])
        .unwrap()
        .amplitude_db()
        .iter()
        .all(|v| *v == -160.));
    assert!(stft.frame(&[f32::NAN]).is_err());
}
#[test]
fn mel_uses_fixed_triangles_normalized_by_weight_sum_and_energy_compensation() {
    let bank = MelBank::new(48000, 1024, 32).unwrap();
    let points: Vec<_> = (0..34)
        .map(|i| 700. * (10_f64.powf(i as f64 / 33. * (1_f64 + 24000. / 700.).log10()) - 1.))
        .collect();
    let input: Vec<_> = (0..513).map(|i| if i == 64 { 0.5 } else { 0. }).collect();
    let result = bank.apply(&input).unwrap();
    for band in 0..32 {
        let weight = |f: f64| {
            ((f - points[band]) / (points[band + 1] - points[band]))
                .min((points[band + 2] - f) / (points[band + 2] - points[band + 1]))
                .max(0.)
        };
        let sum: f64 = (0..513).map(|i| weight(i as f64 * 48000. / 1024.)).sum();
        let expected = if sum > 0. {
            0.5 * weight(3000.) / sum
        } else {
            0.
        };
        assert!((result[band] - expected).abs() < 1e-12);
        assert!((bank.boundaries()[band][1] - points[band + 1]).abs() < 1e-9);
    }
    let sparse = MelBank::new(48000, 64, 512).unwrap();
    assert!(sparse
        .db(&vec![0.; 33])
        .unwrap()
        .iter()
        .all(|v| *v == -160.));
}
