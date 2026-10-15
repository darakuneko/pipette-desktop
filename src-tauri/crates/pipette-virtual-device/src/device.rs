// SPDX-License-Identifier: GPL-2.0-or-later
//! The virtual device as the HID layer sees it (open / close / one report
//! in, one report out) plus the controller used by tests and development
//! tools to press keys and drive the unlock sequence.

use std::fmt;

use crate::dataset::{COMPRESSED_DEFINITION, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};
use crate::protocol::{CMD_VIA_VIAL_PREFIX, Report, pad_report};
use crate::state::VirtualDeviceState;
use crate::via_handler::handle_via_report;
use crate::vial_handler::handle_vial_report;

/// A report was sent while the virtual device is closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotOpenError;

impl fmt::Display for NotOpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Virtual device is not open")
    }
}

impl std::error::Error for NotOpenError {}

/// What the controller reports back to tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControllerState {
    pub open: bool,
    pub unlocked: bool,
    pub unlock_in_progress: bool,
    pub unlock_counter: i32,
}

pub fn matches_virtual_device(vendor_id: u16, product_id: u16) -> bool {
    vendor_id == VIRTUAL_DEVICE_VID && product_id == VIRTUAL_DEVICE_PID
}

/// State lives as long as this value, across close and re-open (like a
/// powered keyboard keeping its EEPROM); only [`VirtualDevice::reset`]
/// restores factory defaults.
#[derive(Clone, Debug, Default)]
pub struct VirtualDevice {
    state: VirtualDeviceState,
    open: bool,
}

impl VirtualDevice {
    /// A closed device with factory state.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&mut self) {
        self.open = true;
    }

    pub fn close(&mut self) {
        self.open = false;
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Handle one raw report (zero-padded or truncated to 32 bytes) at time
    /// `now` (ms) and return the 32-byte response.
    pub fn handle_report(&mut self, data: &[u8], now: u64) -> Result<Report, NotOpenError> {
        if !self.open {
            return Err(NotOpenError);
        }
        let req = pad_report(data);
        Ok(if req[0] == CMD_VIA_VIAL_PREFIX {
            handle_vial_report(&mut self.state, &req, COMPRESSED_DEFINITION, now)
        } else {
            handle_via_report(&mut self.state, &req)
        })
    }

    pub fn state(&self) -> &VirtualDeviceState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut VirtualDeviceState {
        &mut self.state
    }

    // --- Controller ---

    pub fn press_key(&mut self, row: i32, col: i32) {
        self.state.press_key(row, col);
    }

    pub fn release_key(&mut self, row: i32, col: i32) {
        self.state.release_key(row, col);
    }

    pub fn release_all(&mut self) {
        self.state.release_all();
    }

    pub fn hold_keys(&mut self, pairs: &[(i32, i32)]) {
        for &(row, col) in pairs {
            self.state.press_key(row, col);
        }
    }

    /// Also clamps a countdown already in progress, so shortening the
    /// sequence takes effect immediately instead of after a combo release.
    pub fn set_unlock_counter_max(&mut self, n: i32) {
        self.state.unlock_counter_max = n;
        if self.state.unlock_counter > n {
            self.state.unlock_counter = n;
        }
    }

    pub fn controller_state(&self) -> ControllerState {
        ControllerState {
            open: self.open,
            unlocked: self.state.unlocked,
            unlock_in_progress: self.state.unlock_in_progress,
            unlock_counter: self.state.unlock_counter,
        }
    }

    /// Restore factory state; the open flag is kept.
    pub fn reset(&mut self) {
        self.state = VirtualDeviceState::new();
    }
}
