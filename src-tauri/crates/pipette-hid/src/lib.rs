// SPDX-License-Identifier: GPL-2.0-or-later
//! Raw HID transport for Vial keyboards.
//!
//! Only byte transport lives here — listing, opening and 32-byte request /
//! response exchange. The Vial protocol itself is implemented by the
//! WebView-side `protocol.ts`. When `PIPETTE_VIRTUAL_DEVICE` is set, the
//! virtual keyboard from `pipette-virtual-device` is listed and, once
//! opened, answers every report in place of real hardware.

mod backend;
mod constants;
mod device_info;
mod error;
mod fifo;
mod hidapi_backend;
mod service;

pub use backend::{HidBackend, HidHandle, RawDeviceInfo};
pub use constants::*;
pub use device_info::{DeviceInfo, DeviceType, classify_device, virtual_device_info};
pub use error::HidError;
pub use hidapi_backend::HidapiBackend;
pub use pipette_virtual_device::{ControllerState, MSG_LEN, Report, VirtualDevice, VirtualDeviceMode};
pub use service::HidService;
