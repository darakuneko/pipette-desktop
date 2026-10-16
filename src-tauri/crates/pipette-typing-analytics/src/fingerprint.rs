// SPDX-License-Identifier: GPL-2.0-or-later
//! Who recorded a minute (fingerprint.ts and `canonicalScopeKey` of
//! src/shared/types/typing-analytics.ts): this device's machine hash, its
//! OS as Node's `os` module names it, and the keyboard.

use crate::identity::{os_arch, os_platform, os_release};
use crate::jsonl::row::js_number_string;

/// `os.platform()`, `os.release()` and `os.arch()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OsInfo {
    pub platform: String,
    pub release: String,
    pub arch: String,
}

impl OsInfo {
    /// The values Node gives on this machine.
    pub fn current() -> Self {
        Self { platform: os_platform().into(), release: os_release(), arch: os_arch().into() }
    }
}

/// `TypingAnalyticsKeyboard`.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyboardInfo {
    pub uid: String,
    pub vendor_id: f64,
    pub product_id: f64,
    pub product_name: String,
}

/// `TypingAnalyticsFingerprint`.
#[derive(Clone, Debug, PartialEq)]
pub struct Fingerprint {
    pub machine_hash: String,
    pub os: OsInfo,
    pub keyboard: KeyboardInfo,
}

impl Fingerprint {
    /// `canonicalScopeKey`: the parts joined by `|`, numbers as `String(n)`.
    /// The product name is left out, so a device whose descriptor differs
    /// between OSes keeps one scope.
    pub fn scope_key(&self) -> String {
        [
            self.machine_hash.as_str(),
            &self.os.platform,
            &self.os.release,
            &self.keyboard.uid,
            &js_number_string(self.keyboard.vendor_id),
            &js_number_string(self.keyboard.product_id),
        ]
        .join("|")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(uid: &str, product_name: &str) -> Fingerprint {
        Fingerprint {
            machine_hash: "hash".into(),
            os: OsInfo { platform: "linux".into(), release: "6.8.0-test".into(), arch: "x64".into() },
            keyboard: KeyboardInfo {
                uid: uid.into(),
                vendor_id: f64::from(0xFEED),
                product_id: 0.0,
                product_name: product_name.into(),
            },
        }
    }

    #[test]
    fn the_scope_key_joins_every_part_but_the_product_name_and_arch() {
        let a = fingerprint("0xAABB", "Pipette Keyboard");
        assert_eq!(a.scope_key(), "hash|linux|6.8.0-test|0xAABB|65261|0");
        assert_eq!(a.scope_key(), fingerprint("0xAABB", "Pipette Keyboard (win)").scope_key());
        assert_ne!(a.scope_key(), fingerprint("0xCCDD", "Pipette Keyboard").scope_key());
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        let mut fp = fingerprint("u", "p");
        fp.keyboard.vendor_id = -0.0;
        fp.keyboard.product_id = 1.5e21;
        assert_eq!(fp.scope_key(), "hash|linux|6.8.0-test|u|0|1.5e+21");
    }

    #[test]
    fn the_current_os_has_node_names() {
        let os = OsInfo::current();
        assert_eq!(os.platform, os_platform());
        assert_eq!(os.arch, os_arch());
    }
}
