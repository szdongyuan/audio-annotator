use annotator_core::media::import_source::*;
#[test]
fn rules_shorthand_globs_extensions_and_precedence() {
    let mut rules = Rules {
        include: vec!["*/CH1".into(), "*/CH2".into()],
        ..Rules::default()
    };
    rules.validate().unwrap();
    for path in ["CH1.wav", "a/b/ch1.FLAC", "a/CH2.mp3"] {
        assert!(rules.matches(path), "{path}");
    }
    for path in ["CH10.wav", "a/CH2.txt", "a/CH3.wav"] {
        assert!(!rules.matches(path), "{path}");
    }
    rules.exclude = vec!["*/CH2".into()];
    assert!(!rules.matches("a/b/CH2.wav"));
    rules.exclude.clear();
    rules.include = vec!["**/audio/CH?.wav".into()];
    assert!(rules.matches("audio/CH1.wav"));
    assert!(rules.matches("a/b/audio/CH2.WAV"));
    assert!(!rules.matches("audio/deep/CH1.wav"));
    rules.recursive = false;
    assert!(!rules.matches("audio/CH1.wav"));
    rules.include = vec!["**/*".into()];
    rules.extensions = vec!["flac".into()];
    assert!(rules.matches("CH1.FLAC"));
    assert!(!rules.matches("CH1.wav"));
}

#[test]
fn invalid_and_excessive_native_rules_fail_before_scanning() {
    for pattern in ["", "../*.wav", "/a", "a\\b", "a[12]", "a***b", "a,b", "a;b"] {
        let rules = Rules {
            include: vec![pattern.into()],
            ..Rules::default()
        };
        assert!(rules.validate().is_err(), "{pattern}");
    }
    assert!(Rules {
        include: vec!["x".repeat(513)],
        ..Rules::default()
    }
    .validate()
    .is_err());
    assert!(Rules {
        exclude: vec!["x".into(); 256],
        ..Rules::default()
    }
    .validate()
    .is_err());
    assert!(Rules {
        extensions: vec!["exe".into()],
        ..Rules::default()
    }
    .validate()
    .is_err());
}
