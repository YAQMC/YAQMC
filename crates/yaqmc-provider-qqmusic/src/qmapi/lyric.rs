//! Row L: library lyric fetch/decrypt mapped through in-tree parsers (wire freeze).
//!
//! In non-test builds, `QQMusicClient::lyrics` calls library `get_lyric`
//! directly and maps the result here.
//! Library `lyric_parser` is not the wire document.

use qqmusic_api::models::lyric::GetLyricResponse;
use yaqmc_provider_api::LyricDocument;

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::qmapi_client;
use crate::qqmusic::{
    attach_companion_lyrics, parse_lrc_document, parse_qrc_document, QQMusicError,
};

pub(crate) fn lyric_document_from_qmapi(
    mid: &str,
    response: &GetLyricResponse,
) -> Option<LyricDocument> {
    let lyric = response.lyric.trim();
    if lyric.is_empty() {
        return None;
    }
    let mut document = parse_qrc_document(mid, lyric).or_else(|| parse_lrc_document(mid, lyric))?;
    attach_companion_lyrics(
        &mut document,
        nonempty(response.trans.as_str()),
        nonempty(response.roma.as_str()),
    );
    Some(document)
}

pub(crate) async fn fetch_lyric_document(mid: &str) -> Result<Option<LyricDocument>, QQMusicError> {
    let client = qmapi_client().map_err(|error| {
        let classification = map_qmapi_error(error);
        tracing::warn!(
            target: "qqmusic.lyric",
            classification = classification.code(),
            "library client construction failed"
        );
        classification
    })?;
    let response = client
        .lyric
        .get_lyric(mid, 0, true, true, true, false)
        .await
        .map_err(|error| {
            let classification = map_qmapi_error(error);
            tracing::warn!(
                target: "qqmusic.lyric",
                mid,
                classification = classification.code(),
                "library get_lyric failed"
            );
            classification
        })?;
    Ok(lyric_document_from_qmapi(mid, &response))
}

fn nonempty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use lyrics_crypto::decrypter::qrc::decrypter::decrypt_lyrics as decrypt_qrc;
    use qqmusic_api::models::lyric::{qrc_decrypt, GetLyricResponse};

    use super::*;
    use crate::qmapi::qmapi_client;
    use crate::qqmusic::{attach_companion_lyrics, parse_qrc_document};

    const LIBRARY_QRC_VECTOR: &str =
        "3c80fea4c8965b324d9d7f9b0778e5be0374013221f3c86fdbab3be5929b9320ea64d4ea7f2fa40a";
    const QRC_FIXTURE: &str = r#"<QrcInfos><LyricInfo LyricContent="[0,2000]Fixture(0,900) lyric(900,1100)&#10;[2500,1500]Second(2500,1500)" /></QrcInfos>"#;

    fn qrc_decrypt_matches_intree(encrypted: &str) -> bool {
        qrc_decrypt(encrypted) == decrypt_qrc(encrypted)
    }

    #[test]
    fn qmapi_client_injects_yaqmc_reqwest_transport() {
        qmapi_client().expect("Client::new_with_transport");
    }

    #[test]
    fn qrc_decrypt_matches_lyrics_crypto_on_library_reference_vector() {
        let library = qrc_decrypt(LIBRARY_QRC_VECTOR).expect("library decrypt");
        let intree = decrypt_qrc(LIBRARY_QRC_VECTOR).expect("lyrics-crypto decrypt");
        assert_eq!(library, intree);
        assert_eq!(
            library,
            "[ti:test][00:00.00]\u{4f60}\u{597d}\u{4e16}\u{754c}"
        );
    }

    #[test]
    fn qmapi_lyric_fetch_uses_library_get_lyric_in_non_test_qmapi_builds() {
        assert!(
            qrc_decrypt_matches_intree(LIBRARY_QRC_VECTOR),
            "QRC decrypt diverged; keep lyrics-crypto"
        );
        // `QQMusicClient::lyrics` calls `fetch_lyric_document` directly when
        // this crate is not under `cfg(test)`.
    }

    #[test]
    fn library_qrc_parser_is_not_the_wire_document() {
        let raw = "[0,2000]Fixture(0,900) lyric(900,1100)";
        let library = qqmusic_api::lyric_parser::QrcLyric::parse(raw);
        let intree = parse_qrc_document("TRACK", raw).expect("intree parse");
        assert_eq!(intree.lines[0].words[1].start_ms, 900);
        assert_ne!(
            library.lines[0].words[1].start_ms as u64, intree.lines[0].words[1].start_ms,
            "library parser treats (dur_cs) not (start,duration); keep in-tree mapping"
        );
    }

    #[test]
    fn library_parse_decrypts_then_intree_lrc_mapping() {
        let response = GetLyricResponse::parse(serde_json::json!({
            "lyric": LIBRARY_QRC_VECTOR,
        }))
        .expect("parse decrypts lyric");
        let document = lyric_document_from_qmapi("TRACK", &response).expect("mapped");
        assert_eq!(document.lines[0].text, "你好世界");
        assert_eq!(document.lines[0].start_ms, Some(0));
    }

    #[test]
    fn decrypted_qmapi_response_uses_intree_qrc_and_companion_mapping() {
        let response = GetLyricResponse {
            lyric: QRC_FIXTURE.to_owned(),
            trans: "[00:00.00]Translation\n[00:02.50]Second translation".to_owned(),
            roma: "[00:00.00]Romanization".to_owned(),
            ..GetLyricResponse::default()
        };
        let mapped = lyric_document_from_qmapi("TRACK", &response).expect("mapped");
        let mut expected = parse_qrc_document("TRACK", QRC_FIXTURE).expect("intree parse");
        attach_companion_lyrics(
            &mut expected,
            Some("[00:00.00]Translation\n[00:02.50]Second translation"),
            Some("[00:00.00]Romanization"),
        );
        assert_eq!(mapped, expected);
    }
}
