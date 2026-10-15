// SPDX-License-Identifier: GPL-2.0-or-later
//! The controller used by tests and development tools to press keys, drive
//! the unlock sequence and restore factory state, on a device shared with the
//! HID layer.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::device::VirtualDevice;
use crate::state::VirtualDeviceState;

/// What the controller reports back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControllerState {
    pub open: bool,
    pub unlocked: bool,
    pub unlock_in_progress: bool,
    pub unlock_counter: i32,
}

/// A cheap, cloneable handle on a shared [`VirtualDevice`].
#[derive(Clone, Debug)]
pub struct VirtualDeviceController {
    device: Arc<Mutex<VirtualDevice>>,
}

impl VirtualDeviceController {
    pub fn new(device: Arc<Mutex<VirtualDevice>>) -> Self {
        Self { device }
    }

    fn device(&self) -> MutexGuard<'_, VirtualDevice> {
        self.device.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Out-of-range positions are ignored.
    pub fn press_key(&self, row: i32, col: i32) {
        self.device().state_mut().press_key(row, col);
    }

    /// Out-of-range positions are ignored.
    pub fn release_key(&self, row: i32, col: i32) {
        self.device().state_mut().release_key(row, col);
    }

    pub fn release_all(&self) {
        self.device().state_mut().release_all();
    }

    pub fn hold_keys(&self, pairs: &[(i32, i32)]) {
        let mut device = self.device();
        for &(row, col) in pairs {
            device.state_mut().press_key(row, col);
        }
    }

    /// Also clamps a countdown already in progress, so shortening the
    /// sequence takes effect immediately instead of after a combo release.
    pub fn set_unlock_counter_max(&self, n: i32) {
        let mut device = self.device();
        let state = device.state_mut();
        state.unlock_counter_max = n;
        if state.unlock_counter > n {
            state.unlock_counter = n;
        }
    }

    pub fn get_state(&self) -> ControllerState {
        let device = self.device();
        let state = device.state();
        ControllerState {
            open: device.is_open(),
            unlocked: state.unlocked,
            unlock_in_progress: state.unlock_in_progress,
            unlock_counter: state.unlock_counter,
        }
    }

    /// Restore factory state; the open flag is kept.
    pub fn reset(&self) {
        *self.device().state_mut() = VirtualDeviceState::new();
    }
}
