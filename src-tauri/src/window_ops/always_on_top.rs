// SPDX-License-Identifier: GPL-2.0-or-later
//! Keeping the window on top, and whether the session allows it, decided
//! from the environment, not from the display backend GTK actually uses (an
//! X11 app under XWayland reads as unsupported too).

/// Whether a window can stay on top: everywhere but Linux, and on Linux
/// only when `WAYLAND_DISPLAY` is unset or empty and `XDG_SESSION_TYPE`
/// does not contain `wayland` (case-sensitive). `var` reads the
/// environment.
pub fn is_supported(linux: bool, var: impl Fn(&str) -> Option<String>) -> bool {
    if !linux {
        return true;
    }
    let wayland_display = var("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty());
    let wayland_session = var("XDG_SESSION_TYPE").is_some_and(|value| value.contains("wayland"));
    !wayland_display && !wayland_session
}

/// [`is_supported`] for this process.
pub fn is_supported_here() -> bool {
    is_supported(cfg!(target_os = "linux"), |name| {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_support_matches_the_recorded_table() {
        let fixture = crate::window_ops::compact::tests::fixture();
        let cases = fixture["isAlwaysOnTopSupported"].as_array().unwrap();
        assert_eq!(cases.len(), 66);
        for case in cases {
            let env = case["env"].as_object().unwrap();
            let linux = case["platform"] == "linux";
            let supported = is_supported(linux, |name| env.get(name).map(|v| v.as_str().unwrap().to_owned()));
            assert_eq!(supported, case["supported"].as_bool().unwrap(), "{case}");
        }
    }
}
