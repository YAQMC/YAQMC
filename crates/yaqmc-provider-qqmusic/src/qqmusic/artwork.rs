use super::{clean_text, color_for};
use yaqmc_provider_api::{Artwork, ArtworkVariant};

pub(super) use qqmusic_api::artwork::{
    is_allowed_url as is_allowed_artwork_url, normalize_url as normalize_provider_artwork_url,
};

const FALLBACK_ARTWORK: &str = "/artwork/stillness.svg";

pub(super) fn artwork_for_album(mid: &str, title: &str) -> Artwork {
    let source = qqmusic_api::artwork::album(mid);
    let color_key = if source.is_some() { mid.trim() } else { mid };
    map_artwork(source, title, color_for(color_key))
}

pub(super) fn artwork_from_provider_url(
    source: &str,
    title: &str,
    dominant_color: String,
) -> Artwork {
    map_artwork(
        qqmusic_api::artwork::from_url(source),
        title,
        dominant_color,
    )
}

fn map_artwork(
    source: Option<qqmusic_api::artwork::ArtworkSource>,
    title: &str,
    dominant_color: String,
) -> Artwork {
    let (src, variants) = source
        .map(|source| {
            (
                source.url,
                source
                    .variants
                    .into_iter()
                    .map(|variant| ArtworkVariant {
                        src: variant.url,
                        width: variant.width,
                        height: variant.height,
                    })
                    .collect(),
            )
        })
        .unwrap_or_else(|| (FALLBACK_ARTWORK.to_owned(), Vec::new()));
    Artwork {
        src,
        alt: format!("Cover for {}", clean_text(title)),
        dominant_color,
        variants,
    }
}

#[cfg(test)]
fn provider_cover_url(value: &serde_json::Value) -> String {
    if let Some(text) = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        return text.to_owned();
    }
    let Some(object) = value.as_object() else {
        return String::new();
    };
    for key in [
        "url",
        "medium_url",
        "big_url",
        "default_url",
        "small_url",
        "PhotoUrl",
        "photo_url",
    ] {
        if let Some(text) = object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            return text.to_owned();
        }
    }
    String::new()
}

#[cfg(test)]
fn card_cover_url(card: &serde_json::Value) -> String {
    let cover = provider_cover_url(&card["cover"]);
    let source = if cover.is_empty() {
        card["picurl"].as_str().unwrap_or_default()
    } else {
        &cover
    };
    normalize_provider_artwork_url(source).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn album_artwork_exposes_only_verified_sizes() {
        let artwork = artwork_for_album("003c616O2Zlswm", "新的心跳");
        assert_eq!(artwork.variants.len(), 4);
        assert_eq!(artwork.src, artwork.variants[1].src);
        assert_eq!(
            artwork
                .variants
                .iter()
                .map(|variant| variant.width)
                .collect::<Vec<_>>(),
            vec![150, 300, 500, 800]
        );
        assert!(artwork.variants[3].src.contains("T002R800x800M000"));
        assert!(!artwork
            .variants
            .iter()
            .any(|variant| variant.width == 1_000));
    }

    #[test]
    fn provider_album_url_is_normalized_to_measured_variants() {
        let artwork = artwork_from_provider_url(
            "http://y.gtimg.cn/music/photo_new/T002R300x300M000003c616O2Zlswm.jpg",
            "新的心跳",
            "#102030".to_owned(),
        );
        assert_eq!(artwork.variants.len(), 4);
        assert_eq!(artwork.src, artwork.variants[1].src);

        let suffixed = artwork_from_provider_url(
            "https://y.gtimg.cn/music/photo_new/T002R300x300M000003eNAcG12WfIs_1.jpg",
            "Broken Trust",
            "#102030".to_owned(),
        );
        assert_eq!(suffixed.variants.len(), 4);
        assert!(suffixed.variants[3]
            .src
            .contains("T002R800x800M000003eNAcG12WfIs.jpg"));
    }

    #[test]
    fn provider_playlist_url_is_preserved_without_invented_sizes() {
        let artwork = artwork_from_provider_url(
            "https://qpic.y.qq.com/playlist.jpg",
            "Playlist",
            "#102030".to_owned(),
        );
        assert_eq!(artwork.src, "https://qpic.y.qq.com/playlist.jpg");
        assert!(artwork.variants.is_empty());

        let songlist_cdn = artwork_from_provider_url(
            "https://music-file.y.qq.com/songlist/u/cover?imageView2/4/w/600/h/600",
            "热门歌单",
            "#102030".to_owned(),
        );
        assert_eq!(
            songlist_cdn.src,
            "https://music-file.y.qq.com/songlist/u/cover?imageView2/4/w/600/h/600"
        );
        assert!(songlist_cdn.variants.is_empty());

        let measured = artwork_from_provider_url(
            "https://y.gtimg.cn/music/photo_new/T003R500x500M00000143qaC3OlGPV.jpg",
            "Toplist",
            "#102030".to_owned(),
        );
        assert_eq!(measured.variants.len(), 1);
        assert_eq!(measured.variants[0].width, 500);
        assert_eq!(measured.variants[0].height, 500);

        let daily = artwork_from_provider_url(
            "https://y.qq.com/m/resource/calendar/0901_300.jpg",
            "今日私享",
            "#102030".to_owned(),
        );
        assert_eq!(
            daily.src,
            "https://y.qq.com/m/resource/calendar/0901_300.jpg"
        );
        assert!(daily.variants.is_empty());
    }

    #[test]
    fn unsafe_album_mid_and_provider_host_fall_back() {
        assert_eq!(artwork_for_album("../bad", "Album").src, FALLBACK_ARTWORK);
        assert_eq!(
            artwork_from_provider_url(
                "https://example.com/cover.jpg",
                "Album",
                "#102030".to_owned()
            )
            .src,
            FALLBACK_ARTWORK
        );
        assert_eq!(
            artwork_from_provider_url(
                "https://y.qq.com/portal/player.html",
                "Not artwork",
                "#102030".to_owned()
            )
            .src,
            FALLBACK_ARTWORK
        );
    }

    #[test]
    fn album_like_playlist_filename_preserves_source_and_ui_metadata() {
        let source = "https://qpic.y.qq.com/T002R300x300M000ALBUM123.jpg";
        let artwork = artwork_from_provider_url(source, "A &amp; B", "#123456".into());
        assert_eq!(artwork.src, source);
        assert!(artwork.variants.is_empty());
        assert_eq!(artwork.dominant_color, "#123456");
        assert_eq!(artwork.alt, "Cover for A & B");
    }

    #[test]
    fn provider_cover_url_reads_string_or_object_fields() {
        assert_eq!(
            provider_cover_url(&serde_json::json!("https://qpic.y.qq.com/a.jpg")),
            "https://qpic.y.qq.com/a.jpg"
        );
        assert_eq!(
            provider_cover_url(&serde_json::json!({
                "url": "https://y.gtimg.cn/photo.jpg"
            })),
            "https://y.gtimg.cn/photo.jpg"
        );
        assert_eq!(
            provider_cover_url(&serde_json::json!({
                "default_url": "https://qpic.y.qq.com/default.jpg"
            })),
            "https://qpic.y.qq.com/default.jpg"
        );
        assert_eq!(
            card_cover_url(&serde_json::json!({
                "cover": { "url": "https://qpic.y.qq.com/object.jpg" },
                "picurl": "https://qpic.y.qq.com/fallback.jpg"
            })),
            "https://qpic.y.qq.com/object.jpg"
        );
        assert_eq!(
            card_cover_url(&serde_json::json!({
                "picurl": "https://qpic.y.qq.com/fallback.jpg"
            })),
            "https://qpic.y.qq.com/fallback.jpg"
        );
        assert_eq!(
            card_cover_url(&serde_json::json!({
                "cover": {
                    "small_url": "https://music-file.y.qq.com/songlist/small",
                    "medium_url": "https://music-file.y.qq.com/songlist/medium",
                    "big_url": "https://music-file.y.qq.com/songlist/big",
                    "default_url": "https://music-file.y.qq.com/songlist/default"
                }
            })),
            "https://music-file.y.qq.com/songlist/medium"
        );
        assert_eq!(
            card_cover_url(&serde_json::json!({
                "picurl": "http://y.gtimg.cn/music/photo_new/mv.jpg"
            })),
            "https://y.gtimg.cn/music/photo_new/mv.jpg"
        );
        assert_eq!(
            card_cover_url(&serde_json::json!({
                "cover": "https://y.qq.com/music/common/upload/MUSIC_FOCUS/focus.png"
            })),
            "https://y.qq.com/music/common/upload/MUSIC_FOCUS/focus.png"
        );
        assert!(card_cover_url(&serde_json::json!({
            "cover": "https://y.qq.com/portal/player.html"
        }))
        .is_empty());
    }
}
