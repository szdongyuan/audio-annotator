use annotator_core::{error::ErrorCode, model::*, project::ProjectSession};

fn fixture() -> ProjectDocument {
    ProjectDocument::from_json(include_str!("../../../tests/fixtures/document-v1.json")).unwrap()
}

#[test]
fn shared_fixture_round_trips_and_rejects_invalid_documents() {
    let doc = fixture();
    assert_eq!(
        ProjectDocument::from_json(&serde_json::to_string(&doc).unwrap()).unwrap(),
        doc
    );
    for bad in [f64::NAN, f64::INFINITY, -1.0, 2.0] {
        let mut invalid = doc.clone();
        invalid.annotations[0].region.start_seconds = bad;
        assert!(invalid.validate().is_err());
    }
    let mut invalid = doc.clone();
    invalid.annotations[0].region.channel_index = 2;
    assert!(invalid.validate().is_err());
    invalid = doc.clone();
    invalid.annotations[0].region.media_id = "00000000-0000-4000-8000-000000000099".into();
    assert!(invalid.validate().is_err());
    invalid = doc.clone();
    let mut duplicate = invalid.categories[0].clone();
    duplicate.id = "00000000-0000-4000-8000-000000000088".into();
    duplicate.name = format!(" {} ", duplicate.name);
    invalid.categories.push(duplicate);
    assert!(invalid.validate().is_err());
    assert_eq!(
        ProjectDocument::from_json(r#"{"formatVersion":2}"#)
            .unwrap_err()
            .code,
        ErrorCode::UnsupportedVersion
    );
}

#[test]
fn changes_are_atomic_and_history_revisions_only_increase() {
    let doc = fixture();
    let id = doc.project_id.clone();
    let category_id = doc.categories[0].id.clone();
    let mut session = ProjectSession::new(doc.clone()).unwrap();
    assert_eq!(
        session
            .apply_change(
                &id,
                99,
                Change::RemoveCategory {
                    id: category_id.clone()
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    assert_eq!(session.snapshot().document, doc);
    let mut annotation = doc.annotations[0].clone();
    annotation.region.high_hz = 24001.0;
    assert!(session
        .apply_change(&id, 0, Change::UpdateAnnotation { annotation })
        .is_err());
    assert_eq!(session.snapshot().document, doc);
    let snapshot = session
        .apply_change(&id, 0, Change::RemoveCategory { id: category_id })
        .unwrap();
    assert_eq!(snapshot.document.annotations[0].category_id, None);
    assert_eq!(snapshot.document.revision, 1);
    let undone = session.undo(&id, 1).unwrap();
    assert_eq!(undone.document.annotations, doc.annotations);
    assert_eq!(undone.document.revision, 2);
    assert_eq!(session.redo(&id, 2).unwrap().document.revision, 3);
}

#[test]
fn playback_mix_validates_deduplicates_and_media_removal_is_undoable() {
    let doc = fixture();
    let id = doc.project_id.clone();
    let media_id = doc.media[0].id.clone();
    let mut session = ProjectSession::new(doc).unwrap();
    assert!(session
        .apply_change(
            &id,
            0,
            Change::UpdatePlaybackMix {
                media_id: media_id.clone(),
                mix: PlaybackMix {
                    solo_channels: vec![2],
                    muted_channels: vec![]
                }
            }
        )
        .is_err());
    let snapshot = session
        .apply_change(
            &id,
            0,
            Change::UpdatePlaybackMix {
                media_id: media_id.clone(),
                mix: PlaybackMix {
                    solo_channels: vec![1, 1],
                    muted_channels: vec![0, 0],
                },
            },
        )
        .unwrap();
    assert_eq!(
        snapshot.document.playback_mix[&media_id].solo_channels,
        vec![1]
    );
    assert!(!snapshot.can_undo);
    let removed = session
        .apply_change(
            &id,
            1,
            Change::RemoveMedia {
                media_id: media_id.clone(),
            },
        )
        .unwrap();
    assert!(removed.document.annotations.is_empty());
    assert!(removed.document.edits.is_empty());
    assert!(removed.document.playback_mix.is_empty());
    let restored = session.undo(&id, 2).unwrap();
    assert_eq!(
        restored.document.playback_mix[&media_id].solo_channels,
        vec![1]
    );
    assert_eq!(restored.document.annotations.len(), 1);
}

#[test]
fn text_merges_only_for_the_same_target_and_preferences_survive_undo() {
    let doc = fixture();
    let id = doc.project_id.clone();
    let media_id = doc.media[0].id.clone();
    let mut session = ProjectSession::new(doc.clone()).unwrap();
    for (revision, note) in [(0, "a"), (1, "ab")] {
        session
            .apply_change(
                &id,
                revision,
                Change::UpdateMediaNote {
                    media_id: media_id.clone(),
                    note: note.into(),
                    merge_key: Some("session1".into()),
                },
            )
            .unwrap();
    }
    session
        .apply_change(
            &id,
            2,
            Change::UpdatePlaybackMix {
                media_id: media_id.clone(),
                mix: PlaybackMix::default(),
            },
        )
        .unwrap();
    let undone = session.undo(&id, 3).unwrap();
    assert_eq!(undone.document.media[0].note, doc.media[0].note);
    assert_eq!(
        undone.document.playback_mix[&media_id],
        PlaybackMix::default()
    );
    assert!(!undone.can_undo);
    session.redo(&id, 4).unwrap();
    session
        .apply_change(
            &id,
            5,
            Change::UpdateChannelNote {
                media_id: media_id.clone(),
                channel_index: 0,
                note: "channel edit".into(),
                merge_key: Some("session1".into()),
            },
        )
        .unwrap();
    let undone = session.undo(&id, 6).unwrap();
    assert_eq!(undone.document.media[0].note, "ab");
    assert_eq!(
        undone.document.media[0].channel_notes,
        doc.media[0].channel_notes
    );
    assert!(undone.can_undo);
}

#[test]
fn malformed_settings_metadata_ids_and_unknown_fields_are_rejected() {
    let original = fixture();
    type InvalidDocument = Box<dyn Fn(&mut ProjectDocument)>;
    let reject: Vec<InvalidDocument> = vec![
        Box::new(|d| d.media[0].sample_rate = 0),
        Box::new(|d| d.media[0].frame_count = 0),
        Box::new(|d| d.media[0].channel_count = 7),
        Box::new(|d| d.media[0].sha256 = "bad".into()),
        Box::new(|d| d.media[0].channel_notes.clear()),
        Box::new(|d| d.categories[0].id = d.media[0].id.clone()),
        Box::new(|d| d.annotations[0].category_id = Some(d.project_id.clone())),
        Box::new(|d| d.annotations[0].region.end_seconds = 2.00001),
        Box::new(|d| d.annotations[0].region.low_hz = d.annotations[0].region.high_hz),
        Box::new(|d| d.analysis.values_mut().next().unwrap().fft_size = 2049),
        Box::new(|d| d.analysis.values_mut().next().unwrap().hop_size = 0),
        Box::new(|d| d.analysis.values_mut().next().unwrap().mel_bands = 513),
        Box::new(|d| d.playback_mix.clear()),
        Box::new(|d| d.playback_mix.values_mut().next().unwrap().muted_channels = vec![0, 0]),
        Box::new(|d| d.algorithm_versions.dsp = 2),
        Box::new(|d| d.edits[0].processing_version = 2),
        Box::new(|d| d.created_at = "not a timestamp".into()),
    ];
    for mutate in reject {
        let mut d = original.clone();
        mutate(&mut d);
        assert!(d.validate().is_err());
    }
    let mut value = serde_json::to_value(&original).unwrap();
    value["unknownField"] = true.into();
    assert!(ProjectDocument::from_json(&value.to_string()).is_err());
    value.as_object_mut().unwrap().remove("unknownField");
    value["media"][0]["unknownField"] = true.into();
    assert!(ProjectDocument::from_json(&value.to_string()).is_err());
}

#[test]
fn nullable_document_fields_are_required_keys() {
    let original = serde_json::to_value(fixture()).unwrap();
    for pointer in ["/media/0", "/annotations/0", "/viewState"] {
        let mut value = original.clone();
        let key = match pointer {
            "/media/0" => "channelLayout",
            "/annotations/0" => "categoryId",
            _ => "activeMediaId",
        };
        value
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(
            ProjectDocument::from_json(&value.to_string()).is_err(),
            "Missing {key} must not silently become null"
        );
    }
}

#[test]
fn view_changes_persist_outside_content_history_and_channel_bounds_use_the_target_media() {
    let mut doc = fixture();
    let id = doc.project_id.clone();
    let media_id = doc.media[0].id.clone();
    let mut mono = doc.media[0].clone();
    mono.id = "00000000-0000-4000-8000-000000000030".into();
    mono.channel_count = 1;
    mono.channel_notes.truncate(1);
    mono.channel_layout = None;
    doc.analysis
        .insert(mono.id.clone(), AnalysisSettings::default());
    doc.playback_mix
        .insert(mono.id.clone(), PlaybackMix::default());
    doc.media.push(mono.clone());
    let mut session = ProjectSession::new(doc.clone()).unwrap();
    let mut invalid = doc.annotations[0].clone();
    invalid.region.media_id = mono.id;
    assert!(session
        .apply_change(
            &id,
            0,
            Change::UpdateAnnotation {
                annotation: invalid
            }
        )
        .is_err());
    let mut view_state = doc.view_state.clone();
    view_state.media.insert(
        media_id.clone(),
        MediaView {
            visible_channels: vec![1],
            start_seconds: 0.5,
            end_seconds: 1.5,
            low_hz: 100.0,
            high_hz: 4000.0,
            frequency_mix: 0.8,
            spectrum_kind: SpectrumKind::Mel,
            gain_db: 3.0,
            dynamic_range_db: 100.0,
            palette: "magma".into(),
        },
    );
    let applied = session
        .apply_change(
            &id,
            0,
            Change::UpdateViewState {
                view_state: view_state.clone(),
            },
        )
        .unwrap();
    assert!(!applied.can_undo);
    session
        .apply_change(
            &id,
            1,
            Change::UpdateMediaNote {
                media_id,
                note: "edited".into(),
                merge_key: None,
            },
        )
        .unwrap();
    assert_eq!(
        session.undo(&id, 2).unwrap().document.view_state,
        view_state
    );
    view_state.media.values_mut().next().unwrap().frequency_mix = f64::NAN;
    let before = session.snapshot();
    assert!(session
        .apply_change(&id, 3, Change::UpdateViewState { view_state })
        .is_err());
    assert_eq!(session.snapshot(), before);
}

#[test]
fn revision_exhaustion_and_unknown_entities_leave_document_and_history_unchanged() {
    let mut doc = fixture();
    doc.revision = validation::MAX_SAFE_INTEGER;
    let mut session = ProjectSession::new(doc.clone()).unwrap();
    assert_eq!(
        session
            .apply_change(
                &doc.project_id,
                doc.revision,
                Change::RemoveCategory {
                    id: doc.categories[0].id.clone()
                }
            )
            .unwrap_err()
            .code,
        ErrorCode::ResourceLimit
    );
    assert_eq!(session.snapshot().document, doc);
    assert!(!session.snapshot().can_undo);
    let mut session = ProjectSession::new(fixture()).unwrap();
    let before = session.snapshot();
    assert!(session
        .apply_change(
            &doc.project_id,
            0,
            Change::RemoveCategory {
                id: doc.project_id.clone()
            }
        )
        .is_err());
    assert_eq!(session.snapshot(), before);
}

#[test]
fn every_content_change_is_serializable_and_undoable() {
    let doc = fixture();
    let media_id = doc.media[0].id.clone();
    let mut new_media = doc.media[0].clone();
    new_media.id = "00000000-0000-4000-8000-000000000020".into();
    let mut category = doc.categories[0].clone();
    category.id = "00000000-0000-4000-8000-000000000021".into();
    category.name = "new".into();
    let mut annotation = doc.annotations[0].clone();
    annotation.id = "00000000-0000-4000-8000-000000000022".into();
    let mut edit = doc.edits[0].clone();
    edit.id = "00000000-0000-4000-8000-000000000023".into();
    let changes = vec![
        Change::ImportMedia { media: new_media },
        Change::AddCategory { category },
        Change::UpdateCategory {
            category: Category {
                name: "renamed".into(),
                ..doc.categories[0].clone()
            },
        },
        Change::AddAnnotation { annotation },
        Change::UpdateAnnotation {
            annotation: Annotation {
                note: "changed".into(),
                ..doc.annotations[0].clone()
            },
        },
        Change::RemoveAnnotation {
            id: doc.annotations[0].id.clone(),
        },
        Change::UpdateAnnotationNote {
            id: doc.annotations[0].id.clone(),
            note: "changed".into(),
            merge_key: None,
        },
        Change::AddEdit { edit },
        Change::UpdateEdit {
            edit: SpectralEdit {
                enabled: false,
                ..doc.edits[0].clone()
            },
        },
        Change::RemoveEdit {
            id: doc.edits[0].id.clone(),
        },
        Change::SetEditEnabled {
            id: doc.edits[0].id.clone(),
            enabled: false,
        },
        Change::UpdateAnalysis {
            media_id,
            settings: AnalysisSettings {
                window: WindowFunction::Blackman,
                ..AnalysisSettings::default()
            },
        },
    ];
    for change in changes {
        let serialized = serde_json::to_value(&change).unwrap();
        assert!(serialized["type"]
            .as_str()
            .unwrap()
            .chars()
            .next()
            .unwrap()
            .is_lowercase());
        assert_eq!(
            serde_json::from_value::<Change>(serialized).unwrap(),
            change
        );
        let mut session = ProjectSession::new(doc.clone()).unwrap();
        let applied = session.apply_change(&doc.project_id, 0, change).unwrap();
        assert!(applied.can_undo);
        let undone = session.undo(&doc.project_id, 1).unwrap().document;
        assert_eq!(undone.media, doc.media);
        assert_eq!(undone.annotations, doc.annotations);
        assert_eq!(undone.categories, doc.categories);
        assert_eq!(undone.edits, doc.edits);
        assert_eq!(undone.analysis, doc.analysis);
        assert!(session.redo(&doc.project_id, 2).is_ok());
    }
}

#[test]
fn annotation_editor_boundary_sequence_keeps_notes_and_rejected_history_atomic() {
    let doc = fixture();
    let id = doc.project_id.clone();
    let mut session = ProjectSession::new(doc.clone()).unwrap();
    let mut annotation = doc.annotations[0].clone();
    annotation.region.start_seconds = 0.0;
    annotation.region.end_seconds = 2.0;
    annotation.region.low_hz = 0.0;
    annotation.region.high_hz = 24000.0;
    let full = session
        .apply_change(&id, 0, Change::UpdateAnnotation { annotation })
        .unwrap();
    for invalid in [
        Region {
            start_seconds: 2.0,
            ..full.document.annotations[0].region.clone()
        },
        Region {
            high_hz: 24000.0001,
            ..full.document.annotations[0].region.clone()
        },
        Region {
            channel_index: 2,
            ..full.document.annotations[0].region.clone()
        },
    ] {
        assert!(session
            .apply_change(
                &id,
                1,
                Change::UpdateAnnotation {
                    annotation: Annotation {
                        region: invalid,
                        ..full.document.annotations[0].clone()
                    },
                }
            )
            .is_err());
        assert_eq!(session.snapshot(), full);
    }
    let removed = session
        .apply_change(
            &id,
            1,
            Change::RemoveCategory {
                id: doc.categories[0].id.clone(),
            },
        )
        .unwrap();
    assert!(removed.document.annotations[0].category_id.is_none());
    assert_eq!(
        removed.document.annotations[0].note,
        doc.annotations[0].note
    );
    assert_eq!(removed.document.media[0].note, doc.media[0].note);
    assert_eq!(
        removed.document.media[0].channel_notes,
        doc.media[0].channel_notes
    );
    let undone = session.undo(&id, 2).unwrap();
    assert_eq!(undone.document.annotations, full.document.annotations);
    assert_eq!(undone.document.categories, doc.categories);
    assert_eq!(
        session.undo(&id, 3).unwrap().document.annotations,
        doc.annotations
    );
}
