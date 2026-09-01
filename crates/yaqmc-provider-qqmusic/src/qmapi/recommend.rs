//! Typed qm-api-rs recommendation boundary.

use qqmusic_api::{
    models::recommend::{GuessRecommendRequest, RadarRecommendRequest},
    Client, Credential, Song,
};

use crate::qmapi::cgi::map_qmapi_error;
use crate::qqmusic::QQMusicError;

fn guess_request(limit: u32, offset: u32, seed_song_ids: &[u64]) -> GuessRecommendRequest {
    GuessRecommendRequest {
        limit,
        offset,
        seed_song_ids: seed_song_ids.to_vec(),
    }
}

fn radar_request(page: u32, entrance_song_ids: &[u64]) -> RadarRecommendRequest {
    RadarRecommendRequest {
        page,
        request_type: 0,
        favorite_song_ids: Vec::new(),
        entrance_song_ids: entrance_song_ids.to_vec(),
    }
}

pub(crate) async fn guess(
    client: &Client,
    credential: &Credential,
    limit: u32,
    offset: u32,
    seed_song_ids: &[u64],
) -> Result<Vec<Song>, QQMusicError> {
    client
        .recommend
        .get_guess_recommend_with_request(
            &guess_request(limit, offset, seed_song_ids),
            Some(credential),
        )
        .await
        .map(|response| response.songs)
        .map_err(map_qmapi_error)
}

pub(crate) async fn radar(
    client: &Client,
    credential: &Credential,
    page: u32,
    entrance_song_ids: &[u64],
) -> Result<Vec<Song>, QQMusicError> {
    client
        .recommend
        .get_radar_recommend_with_request(&radar_request(page, entrance_song_ids), Some(credential))
        .await
        .map(|response| response.songs)
        .map_err(map_qmapi_error)
}

pub(crate) async fn daily_songlist_id(
    client: &Client,
    credential: &Credential,
) -> Result<i64, QQMusicError> {
    client
        .recommend
        .get_daily_recommendation(Some(credential))
        .await
        .map(|response| response.songlist_id)
        .map_err(map_qmapi_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guess_request_preserves_continuation_inputs() {
        let request = guess_request(12, 24, &[101, 202]);
        assert_eq!(request.limit, 12);
        assert_eq!(request.offset, 24);
        assert_eq!(request.seed_song_ids, vec![101, 202]);
    }

    #[test]
    fn radar_request_is_scoped_to_the_current_entrance_tracks() {
        let request = radar_request(3, &[303, 404]);
        assert_eq!(request.page, 3);
        assert_eq!(request.request_type, 0);
        assert!(request.favorite_song_ids.is_empty());
        assert_eq!(request.entrance_song_ids, vec![303, 404]);
    }
}
