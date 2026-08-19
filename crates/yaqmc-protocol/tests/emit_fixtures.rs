use std::fs;

use serde_json::Value;
use yaqmc_protocol::{
    contract_fixtures_dir, emit_contract_fixtures, methods, CoreMessage, CORE_EVENT_CHANNELS,
    FRAME_HARD_CAP_BYTES, HOST_EVENT_CHANNELS, PROTOCOL_ONLY_METHODS,
};

const FIXTURE_FILES: &[&str] = &[
    "constants.json",
    "envelopes.json",
    "methods.json",
    "channels.json",
    "events.json",
    "requests.json",
    "responses.json",
];

#[test]
fn cargo_declares_the_fixtures_feature() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains("fixtures = []"));
    assert!(manifest.contains("name = \"emit_fixtures\""));
}

#[test]
fn emit_contract_fixtures_writes_deterministic_golden_json() {
    let dir = contract_fixtures_dir();
    emit_contract_fixtures(&dir).expect("first emit");
    let first: Vec<(String, String)> = FIXTURE_FILES
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                fs::read_to_string(dir.join(name)).expect(name),
            )
        })
        .collect();
    emit_contract_fixtures(&dir).expect("second emit");
    for (name, previous) in &first {
        let again = fs::read_to_string(dir.join(name)).expect(name);
        assert_eq!(&again, previous, "{name} must be deterministic");
    }

    let constants: Value = serde_json::from_str(&first[0].1).expect("constants json");
    assert_eq!(constants["frameHardCapBytes"], FRAME_HARD_CAP_BYTES);
    assert_eq!(
        constants["protocolOnlyMethods"],
        serde_json::to_value(PROTOCOL_ONLY_METHODS).expect("protocol-only")
    );

    let envelopes: Value = serde_json::from_str(&first[1].1).expect("envelopes json");
    for (key, value) in envelopes.as_object().expect("envelope map") {
        let message: CoreMessage =
            serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{key}: {error}"));
        assert_eq!(
            serde_json::to_value(&message).expect("re-serialize"),
            *value,
            "{key} must round-trip through CoreMessage"
        );
    }

    let method_rows: Vec<Value> = serde_json::from_str(&first[2].1).expect("methods json");
    assert_eq!(method_rows.len(), methods().len());
    for (row, spec) in method_rows.iter().zip(methods()) {
        assert_eq!(row["name"], spec.name);
        assert!(
            row["requestCap"].as_u64().expect("request cap") <= u64::from(FRAME_HARD_CAP_BYTES)
        );
        assert!(
            row["responseCap"].as_u64().expect("response cap") <= u64::from(FRAME_HARD_CAP_BYTES)
        );
    }

    let channels: Value = serde_json::from_str(&first[3].1).expect("channels json");
    assert_eq!(
        channels["core"],
        serde_json::to_value(CORE_EVENT_CHANNELS).expect("core channels")
    );
    assert_eq!(
        channels["host"],
        serde_json::to_value(HOST_EVENT_CHANNELS).expect("host channels")
    );

    let events: Value = serde_json::from_str(&first[4].1).expect("events json");
    let event_map = events.as_object().expect("event map");
    for channel in CORE_EVENT_CHANNELS.iter().chain(HOST_EVENT_CHANNELS) {
        let message: CoreMessage = serde_json::from_value(event_map[*channel].clone())
            .unwrap_or_else(|error| panic!("{channel}: {error}"));
        let CoreMessage::Event { channel: found, .. } = message else {
            panic!("{channel} fixture must be an event frame");
        };
        assert_eq!(found, *channel);
    }
}
