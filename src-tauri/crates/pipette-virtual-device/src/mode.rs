// SPDX-License-Identifier: GPL-2.0-or-later
//! The `PIPETTE_VIRTUAL_DEVICE` switch.

/// Environment variable that turns the virtual device on.
pub const VIRTUAL_DEVICE_ENV: &str = "PIPETTE_VIRTUAL_DEVICE";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VirtualDeviceMode {
    /// Unset or any other value: the virtual device does not exist.
    Off,
    /// `1`: listed after the real HID devices.
    Append,
    /// `only`: listed alone, real devices hidden, so device lists (and doc
    /// screenshots) do not depend on the hardware plugged into the machine.
    Only,
}

impl VirtualDeviceMode {
    pub fn from_env_value(value: Option<&str>) -> Self {
        match value {
            Some("1") => Self::Append,
            Some("only") => Self::Only,
            _ => Self::Off,
        }
    }

    /// Read the environment on every call (not cached), so the mode follows
    /// the variable for the life of the process.
    pub fn from_env() -> Self {
        Self::from_env_value(std::env::var(VIRTUAL_DEVICE_ENV).ok().as_deref())
    }

    pub fn is_enabled(self) -> bool {
        self != Self::Off
    }

    pub fn is_exclusive(self) -> bool {
        self == Self::Only
    }
}
