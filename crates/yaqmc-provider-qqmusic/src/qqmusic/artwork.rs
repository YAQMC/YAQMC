use super::{clean_text, color_for, upgrade_https};
use yaqmc_provider_api::{Artwork, ArtworkVariant};

const FALLBACK_ARTWORK: &str = "/artwork/stillness.svg";
const VERIFIED_ALBUM_SIZES: [u32; 4] = [150, 300, 500, 800];

pub(super) fn artwork_for_album(mid: &str, title: &str) -> Artwork {
    let clean_mid = mid.trim();
    if !is_safe_album_mid(clean_mid) {
        return fallback_artwork(title, mid);
    }

    let variants = album_variants(clean_mid);
    Artwork {
        src: variants[1].src.clone(),
        alt: format!("Cover for {}", clean_text(title)),
        dominant_color: color_for(clean_mid),
        variants,
    }
}

pub(super) fn artwork_from_provider_url(
    source: &str,
    title: &str,
    dominant_color: String,
) -> Artwork {
    let source = upgrade_https(source.trim());
    if !is_allowed_artwork_url(&source) {
        return Artwork {
            src: FALLBACK_ARTWORK.to_owned(),
            alt: format!("Cover for {}", clean_text(title)),
            dominant_color,
            variants: Vec::new(),
        };
    }

    let variants = canonical_album_mid(&source)
        .filter(|mid| is_safe_album_mid(mid))
        .map(|mid| album_variants(&mid))
        .or_else(|| measured_source_variant(&source).map(|variant| vec![variant]))
        .unwrap_or_default();
    Artwork {
        src: variants
            .get(1)
            .map(|variant| variant.src.clone())
            .unwrap_or(source),
        alt: format!("Cover for {}", clean_text(title)),
        dominant_color,
        variants,
    }
}

const ALLOWED_ARTWORK_HOSTS: &[&str] = &[
    "y.gtimg.cn",
    "qpic.y.qq.com",
    "music-file.y.qq.com",
    "q.qlogo.cn",
    "thirdwx.qlogo.cn",
    "thirdqq.qlogo.cn",
];

pub(super) fn is_allowed_artwork_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url
            .host_str()
            .is_some_and(|host| ALLOWED_ARTWORK_HOSTS.contains(&host))
}

pub(super) fn provider_cover_url(value: &serde_json::Value) -> String {
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

pub(super) fn card_cover_url(card: &serde_json::Value) -> String {
    let cover = provider_cover_url(&card["cover"]);
    if !cover.is_empty() {
        return cover;
    }
    card["picurl"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or_default()
        .to_owned()
}

fn fallback_artwork(title: &str, color_key: &str) -> Artwork {
    Artwork {
        src: FALLBACK_ARTWORK.to_owned(),
        alt: format!("Cover for {}", clean_text(title)),
        dominant_color: color_for(color_key),
        variants: Vec::new(),
    }
}

fn album_variants(mid: &str) -> Vec<ArtworkVariant> {
    VERIFIED_ALBUM_SIZES
        .into_iter()
        .map(|size| ArtworkVariant {
            src: format!(
                "https://y.gtimg.cn/music/photo_new/T002R{size}x{size}M000{mid}.jpg?max_age=2592000"
            ),
            width: size,
            height: size,
        })
        .collect()
}

fn is_safe_album_mid(mid: &str) -> bool {
    !mid.is_empty()
        && mid != "unknown"
        && mid.len() <= 64
        && mid
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn canonical_album_mid(source: &str) -> Option<String> {
    let url = reqwest::Url::parse(source).ok()?;
    let filename = url.path_segments()?.next_back()?;
    let after_prefix = filename.strip_prefix("T002R")?;
    let (_, mid_with_suffix) = after_prefix.split_once("M000")?;
    let raw_mid = mid_with_suffix.strip_suffix(".jpg")?;
    let mid = raw_mid
        .rsplit_once('_')
        .filter(|(_, suffix)| {
            !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
        })
        .map(|(mid, _)| mid)
        .unwrap_or(raw_mid);
    Some(mid.to_owned())
}

fn measured_source_variant(source: &str) -> Option<ArtworkVariant> {
    let url = reqwest::Url::parse(source).ok()?;
    let filename = url.path_segments()?.next_back()?;
    let (_, dimensions_and_id) = filename.split_once('R')?;
    let (dimensions, _) = dimensions_and_id.split_once("M000")?;
    let (width, height) = dimensions.split_once('x')?;
    let width = width.parse::<u32>().ok()?;
    let height = height.parse::<u32>().ok()?;
    (width > 0 && height > 0).then(|| ArtworkVariant {
        src: source.to_owned(),
        width,
        height,
    })
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
    }
}
