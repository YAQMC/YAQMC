use yaqmc_core::{
    audio::AudioFormat,
    media::{MediaPreparer, PlaybackSourceResolver},
    playback_session::{snapshot_is_stale, SeekMailbox},
    player::{ApiEvent, PlayerService, RepeatMode},
    streaming::ProgressiveSource,
};

#[test]
fn playback_compile_closure_is_core_owned_and_preserves_seek_contract() {
    let mailbox = SeekMailbox::default();
    let first = mailbox.publish(41, 1_000);
    let latest = mailbox.publish(41, 12_000);

    assert_eq!(first.revision, 1);
    assert_eq!(latest.revision, 2);
    assert_eq!(mailbox.latest(), Some(latest));
    assert!(!mailbox.is_current(first, 41));
    assert!(mailbox.is_current(latest, 41));
    assert!(snapshot_is_stale(41, 1, 41, 2));
    assert_eq!(AudioFormat::Flac.as_str(), "flac");
    assert_eq!(RepeatMode::default(), RepeatMode::Off);

    fn require_core_type<T: ?Sized>() {}

    require_core_type::<PlayerService>();
    require_core_type::<ApiEvent>();
    require_core_type::<ProgressiveSource>();
    require_core_type::<dyn MediaPreparer>();
    require_core_type::<dyn PlaybackSourceResolver>();
}
