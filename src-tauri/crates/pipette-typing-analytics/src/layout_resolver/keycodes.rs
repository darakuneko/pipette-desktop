// SPDX-License-Identifier: GPL-2.0-or-later
//! The keycode lookups of the Layout Comparison resolver, on the keycode
//! registry of src/shared/keycodes/keycodes.ts as the Electron main
//! process holds it (data/keycodes.rs, generated from it).

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

mod data {
    include!("../../data/keycodes.rs");
}

pub use data::PRINTABLE_KEYCODES;

struct Registry {
    masked: HashSet<&'static str>,
    keycodes: HashMap<&'static str, &'static str>,
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Registry {
        masked: data::MASKED_KEYCODES.iter().copied().collect(),
        keycodes: data::KEYCODES.iter().copied().collect(),
    })
}

/// `findInnerKeycode(serialized)?.qmkId`: the keycode inside a masked
/// keycode (`LSFT(KC_A)` → `KC_A`), or the keycode itself.
pub fn inner_qmk_id(serialized: &str) -> Option<&'static str> {
    let registry = registry();
    let mut id = serialized;
    if let Some(paren) = id.find('(')
        && registry.masked.contains(&id[..paren])
    {
        // `substring(paren + 1, length - 1)` drops the last UTF-16 unit:
        // half of a character outside the BMP, which no keycode matches.
        let last = id.chars().next_back()?;
        if last.len_utf16() == 2 {
            return None;
        }
        id = id.get(paren + 1..id.len() - last.len_utf8()).unwrap_or("");
    }
    if id == "kc" {
        id = "KC_NO";
    }
    registry.keycodes.get(id).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_inner_keycode() {
        assert_eq!(inner_qmk_id("KC_A"), Some("KC_A"));
        assert_eq!(inner_qmk_id("LSFT(KC_A)"), Some("KC_A"));
        assert_eq!(inner_qmk_id("LSFT"), Some("LSFT(kc)"));
        assert_eq!(inner_qmk_id("kc"), Some("KC_NO"));
        assert_eq!(inner_qmk_id("MO(1)"), None);
        assert_eq!(inner_qmk_id("LSFT()"), None);
        assert_eq!(inner_qmk_id("LSFT(KC_A\u{1F600}"), None);
        assert_eq!(inner_qmk_id("NOPE"), None);
        assert!(PRINTABLE_KEYCODES.contains(&("KC_A", "a")));
    }
}
