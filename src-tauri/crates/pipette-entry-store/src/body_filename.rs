// SPDX-License-Identifier: GPL-2.0-or-later
//! Body filenames that carry the entry id, so no two ids ever share a body
//! file. The rules work on UTF-16 code units, as the Electron build's do,
//! so both builds give a legacy name the same new name.

use std::fmt::Write;

use pipette_js_json::JsString;

use crate::store_groups::{EntryStore, FilenameIdRule};
use crate::text::{truncate_utf8, truncate_utf8_name_part, utf8_byte_length};

/// UTF-8 bytes a body filename built by the suffix rule may take: a margin
/// under the 255-byte name limit of common file systems (the atomic writer
/// shortens its own temp names when they would not fit).
///
/// Part of the naming contract every device shares: this value, the cut in
/// `fit_stem` (before the stem's last `_`, then dropping trailing `_` / `.`
/// / whitespace) and the `_{id}{ext}` layout decide which new name a legacy
/// name moves to. Devices running different rules would move the same
/// legacy entry to different files, so none of them may change.
pub const MAX_BODY_FILENAME_BYTES: usize = 200;

const UNDERSCORE: u16 = b'_' as u16;

/// `filename` split before its extension: the last `.` after the last `/`,
/// unless it starts the name.
fn split_extension(filename: &[u16]) -> (&[u16], &[u16]) {
    let slash = filename.iter().rposition(|&u| u == u16::from(b'/'));
    let dot = filename.iter().rposition(|&u| u == u16::from(b'.'));
    match dot {
        Some(dot) if slash.map_or(dot > 0, |slash| dot > slash + 1) => filename.split_at(dot),
        _ => (filename, &[]),
    }
}

/// The id as it appears in a body filename: as it is when it is only
/// letters, digits and `-` and does not start with `x`, otherwise `x` and
/// 4 hex digits per UTF-16 code unit (lossless, lone surrogates included).
/// The segment never contains `_`, the separator, and the plain and hex
/// forms cannot meet (only the hex form starts with `x`), so one segment
/// names exactly one id.
pub fn id_filename_segment(id: &JsString) -> Vec<u16> {
    let units = id.utf16_units();
    let plain = units.first().is_some_and(|&u| u != u16::from(b'x'))
        && units.iter().all(|&u| u8::try_from(u).is_ok_and(|b| b.is_ascii_alphanumeric() || b == b'-'));
    if plain {
        return units;
    }
    let mut hex = String::with_capacity(1 + units.len() * 4);
    hex.push('x');
    for unit in units {
        // Writing to a String cannot fail.
        let _ = write!(hex, "{unit:04x}");
    }
    hex.encode_utf16().collect()
}

fn pack_filename(id: &JsString) -> Vec<u16> {
    let mut name: Vec<u16> = "packs/".encode_utf16().collect();
    name.extend(id.utf16_units());
    name.extend(".json".encode_utf16());
    name
}

/// Whether `filename` carries `id` the way `store` names its body files:
/// the id segment is exactly the part after the last `_` of the stem
/// (suffix rule) or before the first `_` (prefix rule). Two different ids
/// can then never own the same body file.
pub fn body_filename_has_id(store: EntryStore, id: &JsString, filename: &JsString) -> bool {
    let filename = filename.utf16_units();
    match store.groups().filename_id {
        FilenameIdRule::Suffix => {
            let (stem, _) = split_extension(&filename);
            stem.iter()
                .rposition(|&u| u == UNDERSCORE)
                .is_some_and(|sep| stem[sep + 1..] == id_filename_segment(id)[..])
        }
        FilenameIdRule::Prefix => filename
            .iter()
            .position(|&u| u == UNDERSCORE)
            .is_some_and(|sep| filename[..sep] == id_filename_segment(id)[..]),
        FilenameIdRule::Fixed => filename == pack_filename(id),
    }
}

/// `stem` cut so it fits in `max_bytes` (part of the naming contract, see
/// [`MAX_BODY_FILENAME_BYTES`]). The cut comes off the end of the part
/// before the stem's last `_`, so the part after it (the timestamp of a
/// legacy snapshot name `{device}_{ts}`, which the device name is read
/// back from) stays whole; the `_` / `.` / spaces the cut leaves are
/// dropped. When that part cannot hold anything, the stem is cut from its
/// end.
fn fit_stem(stem: &[u16], max_bytes: usize) -> Vec<u16> {
    if utf8_byte_length(stem) <= max_bytes {
        return stem.to_vec();
    }
    if let Some(sep) = stem.iter().rposition(|&u| u == UNDERSCORE).filter(|&sep| sep > 0) {
        let tail = &stem[sep..];
        let head = truncate_utf8_name_part(&stem[..sep], max_bytes.saturating_sub(utf8_byte_length(tail)));
        if !head.is_empty() {
            return [head, tail].concat();
        }
    }
    truncate_utf8(stem, max_bytes).to_vec()
}

/// `filename` in the id-carrying form of `store`; a name that already
/// carries the id is returned as it is. Deterministic, so every device maps
/// a legacy name to the same new one. The suffix rule keeps the new name
/// within [`MAX_BODY_FILENAME_BYTES`] by cutting the stem; the `_{id}` part
/// and the extension are kept unit for unit, so the cut name still carries
/// the id. Pack filenames are fixed per id (pack ids are restricted by
/// [`crate::is_safe_pack_id`]).
pub fn id_body_filename(store: EntryStore, id: &JsString, filename: &JsString) -> JsString {
    if body_filename_has_id(store, id, filename) {
        return filename.clone();
    }
    let units = filename.utf16_units();
    let seg = id_filename_segment(id);
    let named = match store.groups().filename_id {
        FilenameIdRule::Suffix => {
            let (stem, ext) = split_extension(&units);
            let id_part = [&[UNDERSCORE][..], &seg, ext].concat();
            let max = MAX_BODY_FILENAME_BYTES.saturating_sub(utf8_byte_length(&id_part));
            [fit_stem(stem, max), id_part].concat()
        }
        FilenameIdRule::Prefix => [&seg[..], &[UNDERSCORE], &units].concat(),
        FilenameIdRule::Fixed => pack_filename(id),
    };
    JsString::from_utf16(named)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(s: &str) -> JsString {
        JsString::from(s)
    }

    fn name(store: EntryStore, id: &str, filename: &str) -> String {
        id_body_filename(store, &js(id), &js(filename)).to_string_lossy().into_owned()
    }

    fn has(store: EntryStore, id: &str, filename: &str) -> bool {
        body_filename_has_id(store, &js(id), &js(filename))
    }

    fn seg(id: &JsString) -> String {
        String::from_utf16_lossy(&id_filename_segment(id))
    }

    const ID: &str = "0f8c2b1e-1111-4222-8333-944445555666";

    #[test]
    fn each_rule_converts_a_legacy_name_and_keeps_a_current_one() {
        let id = ID;
        let cases = [
            (
                EntryStore::Snapshots,
                format!("kb_2025-01-01T00-00-00_{id}.pipette"),
                "kb_2025-01-01T00-00-00.pipette".to_owned(),
                format!("kb_2025-01-01T00-00-00_{id}.pipette"),
            ),
            (
                EntryStore::Favorites,
                format!("macro_2025_ab12cd34_{id}.json"),
                "macro_2025_ab12cd34.json".to_owned(),
                format!("macro_2025_ab12cd34_{id}.json"),
            ),
            (
                EntryStore::AnalyzeFilters,
                format!("2025_{id}.json"),
                "2025_99999999-aaaa-4bbb-8ccc-dddddddddddd.json".to_owned(),
                format!("2025_99999999-aaaa-4bbb-8ccc-dddddddddddd_{id}.json"),
            ),
            (
                EntryStore::RunLogs,
                format!("2025_{id}.json"),
                "2025_other.json".to_owned(),
                format!("2025_other_{id}.json"),
            ),
            (EntryStore::KeyLabels, format!("{id}_2025.json"), "x.json".to_owned(), format!("{id}_x.json")),
            (
                EntryStore::TypingTestTexts,
                format!("{id}_2025.json"),
                "x.json".to_owned(),
                format!("{id}_x.json"),
            ),
            (
                EntryStore::I18nPacks,
                format!("packs/{id}.json"),
                "packs/other.json".to_owned(),
                format!("packs/{id}.json"),
            ),
            (
                EntryStore::ThemePacks,
                format!("packs/{id}.json"),
                "x.json".to_owned(),
                format!("packs/{id}.json"),
            ),
        ];
        for (store, current, legacy, converted) in cases {
            assert!(has(store, id, &current), "{store:?}");
            assert_eq!(name(store, id, &current), current);
            assert!(!has(store, id, &legacy), "{store:?}");
            assert_eq!(name(store, id, &legacy), converted);
            assert!(has(store, id, &converted), "{store:?}");
        }
    }

    #[test]
    fn a_name_with_no_extension_gets_the_id_at_the_end() {
        assert_eq!(name(EntryStore::Favorites, "a", "noext"), "noext_a");
        assert_eq!(name(EntryStore::Favorites, "a", ".hidden"), ".hidden_a");
        assert_eq!(name(EntryStore::Favorites, "a", "dir.d/name"), "dir.d/name_a");
    }

    #[test]
    fn ids_outside_the_plain_set_or_starting_with_x_are_hex_encoded() {
        assert_eq!(seg(&js("abc-1")), "abc-1");
        assert_eq!(seg(&js("b_a")), "x0062005f0061");
        assert_eq!(seg(&js("x1")), "x00780031");
        assert_eq!(seg(&js("日本")), "x65e5672c");
        assert_ne!(seg(&js("ab")), seg(&js("x6162")));
        assert_eq!(seg(&JsString::from_utf16(vec![0xd800])), "xd800");
        assert_ne!(seg(&JsString::from_utf16(vec![0xd800])), seg(&JsString::from_utf16(vec![0xd801])));
        assert_eq!(seg(&js("😀")), "xd83dde00");
        assert_eq!(seg(&js("")), "x");
    }

    #[test]
    fn an_id_that_is_a_suffix_or_prefix_of_another_never_owns_its_file() {
        let for_ba = name(EntryStore::Favorites, "b_a", "x.json");
        assert_eq!(for_ba, "x_x0062005f0061.json");
        assert!(!has(EntryStore::Favorites, "a", &for_ba));
        assert!(!has(EntryStore::Favorites, "b_a", "x_b_a.json"));
        assert!(has(EntryStore::Favorites, "a", "x_b_a.json"));
        assert!(!has(EntryStore::Favorites, "b", "x_b-a.json"));
        assert!(!has(EntryStore::KeyLabels, "a", "a-b_2025.json"));
        assert!(has(EntryStore::KeyLabels, "a-b", "a-b_2025.json"));
        assert_eq!(name(EntryStore::KeyLabels, "a_b", "a_b_2025.json"), "x0061005f0062_a_b_2025.json");
    }

    #[test]
    fn conversion_is_idempotent_for_every_rule_also_for_encoded_ids() {
        let ids = [js("a"), js("b_a"), js("日本"), js("x1"), JsString::from_utf16(vec![0xd800])];
        for store in EntryStore::ALL {
            for id in &ids {
                let once = id_body_filename(store, id, &js("legacy_1.json"));
                assert_eq!(id_body_filename(store, id, &once), once);
                assert!(body_filename_has_id(store, id, &once));
            }
        }
    }

    const TS: &str = "2026-03-15T14-35-29.037Z";
    const SNAP_ID: &str = "0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90";

    #[test]
    fn cuts_the_device_name_of_a_long_legacy_snapshot_name_and_keeps_its_timestamp_id_and_extension() {
        let legacy = format!("{}_{TS}.pipette", "A".repeat(240 - TS.len() - "_.pipette".len()));
        assert_eq!(legacy.len(), 240);
        let named = name(EntryStore::Snapshots, SNAP_ID, &legacy);
        assert!(named.len() <= MAX_BODY_FILENAME_BYTES);
        assert!(named.ends_with(&format!("_{TS}_{SNAP_ID}.pipette")));
        assert!(named.starts_with("AAAA"));
        assert!(has(EntryStore::Snapshots, SNAP_ID, &named));
        assert_eq!(name(EntryStore::Snapshots, SNAP_ID, &named), named);
    }

    #[test]
    fn never_splits_a_multi_byte_character_and_drops_the_separators_the_cut_leaves() {
        let suffix = format!("_{TS}_{SNAP_ID}.pipette");
        for unit in ["日本語", "😀", "é_"] {
            let device = unit.repeat(80);
            let named = name(EntryStore::Snapshots, SNAP_ID, &format!("{device}_{TS}.pipette"));
            assert!(named.len() <= MAX_BODY_FILENAME_BYTES);
            let head = named.strip_suffix(&suffix).unwrap();
            assert!(!head.is_empty());
            assert!(device.starts_with(head));
            assert!(!head.ends_with(['_', '.', ' ']));
        }
    }

    #[test]
    fn cuts_the_stem_from_its_end_when_it_has_no_separator_to_keep_the_tail_of() {
        let named = name(EntryStore::Favorites, "a", &format!("{}.json", "b".repeat(300)));
        assert_eq!(named, format!("{}_a.json", "b".repeat(MAX_BODY_FILENAME_BYTES - "_a.json".len())));
    }

    #[test]
    fn leaves_a_name_within_the_limit_as_it_was() {
        assert_eq!(
            name(EntryStore::Snapshots, SNAP_ID, &format!("KB_{TS}.pipette")),
            format!("KB_{TS}_{SNAP_ID}.pipette")
        );
    }

    #[test]
    fn a_lone_surrogate_at_the_cut_counts_three_bytes_and_is_kept_whole() {
        let mut stem: Vec<u16> = vec![0xd800; 70];
        stem.extend("_tail".encode_utf16());
        stem.extend(".json".encode_utf16());
        let named = id_body_filename(EntryStore::Favorites, &js("a"), &JsString::from_utf16(stem));
        let units = named.utf16_units();
        assert!(utf8_byte_length(&units) <= MAX_BODY_FILENAME_BYTES);
        assert!(String::from_utf16_lossy(&units).ends_with("_tail_a.json"));
    }
}
