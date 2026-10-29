use super::Eligibility;
use crate::collaboration::LayerPayload;

/// Pure policy over already validated current layers. Notes and category definitions
/// do not confer annotation ownership; every region object does, including empty boxes.
pub fn classify_media(
    actor: &str,
    media_id: &str,
    in_recycle: bool,
    layers: &[(String, LayerPayload)],
) -> Eligibility {
    classify_layers(
        actor,
        media_id,
        in_recycle,
        layers
            .iter()
            .map(|(author, payload)| (author.as_str(), payload)),
    )
}

pub(super) fn classify_layers<'a>(
    actor: &str,
    media_id: &str,
    in_recycle: bool,
    mut layers: impl Iterator<Item = (&'a str, &'a LayerPayload)>,
) -> Eligibility {
    if !in_recycle {
        return Eligibility::NotInRecycle;
    }
    let foreign = layers.any(|(author, payload)| {
        author != actor
            && (payload
                .annotations
                .iter()
                .any(|a| a.region.media_id == media_id)
                || payload.media_labels.iter().any(|m| {
                    m.media_id == media_id
                        && (!m.category_ids.is_empty()
                            || m.channel_category_ids.iter().any(|tags| !tags.is_empty()))
                }))
    });
    if foreign {
        Eligibility::OtherAuthorAnnotation
    } else {
        Eligibility::Allowed
    }
}
