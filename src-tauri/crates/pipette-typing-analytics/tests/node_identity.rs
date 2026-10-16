// SPDX-License-Identifier: GPL-2.0-or-later
//! The machine id and the OS strings of the fingerprint against what Node
//! reported on this machine (`pnpm run generate:node-identity` writes them
//! under Cargo's temp directory). Without that file there is nothing to
//! compare: the test only says so, unless `PIPETTE_REQUIRE_NODE_IDENTITY=1`
//! is set, in which case it fails. The values are never printed.

// Helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use pipette_typing_analytics::identity::{os_arch, os_platform, os_release};

#[test]
fn matches_node_on_this_machine() {
    let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("pipette-typing-analytics")
        .join("node_identity.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        let message = format!("{} is missing; run pnpm run generate:node-identity", path.display());
        assert!(std::env::var_os("PIPETTE_REQUIRE_NODE_IDENTITY").is_none_or(|v| v != "1"), "{message}");
        eprintln!("skipped: {message}");
        return;
    };
    let recorded = pipette_js_json::parse(&text).unwrap();
    let node = |key: &str| recorded.as_object().unwrap().get(key).unwrap().as_str().unwrap().to_owned();
    let machine_id = pipette_sync_format::machine_id_original().ok();
    assert!(machine_id == Some(node("machineId")), "the machine id differs from node-machine-id's");
    assert!(os_platform() == node("platform"), "os.platform() differs");
    assert!(os_release() == node("release"), "os.release() differs");
    assert!(os_arch() == node("arch"), "os.arch() differs");
}
