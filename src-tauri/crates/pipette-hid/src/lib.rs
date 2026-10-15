// SPDX-License-Identifier: GPL-2.0-or-later
//! Raw HID transport for Vial keyboards.
//!
//! Only byte transport lives here — listing, opening and 32-byte request /
//! response exchange. The Vial protocol itself is implemented by the
//! WebView-side `protocol.ts`. Depending on the [`VirtualDeviceMode`] the
//! service is built with, the virtual keyboard from `pipette-virtual-device`
//! is listed next to (or instead of) real hardware and, once opened, answers
//! every report in place of a real device.

mod backend;
mod constants;
mod device_info;
mod error;
mod fifo;
mod hidapi_backend;
mod packet_log;
mod service;
mod timing;
mod virtual_backend;

pub use backend::{HidBackend, HidHandle, RawDeviceInfo};
pub use constants::*;
pub use device_info::{DeviceInfo, DeviceType, classify_device};
pub use error::HidError;
pub use hidapi_backend::{HidapiBackend, is_vial_interface};
pub use packet_log::{DEBUG_HID_ENV, Direction, packet_log_message, packet_logging_from_env};
pub use pipette_protocol::{MSG_LEN, Report};
pub use pipette_virtual_device::{ControllerState, VirtualDeviceController, VirtualDeviceMode};
pub use service::HidService;
#[cfg(any(test, feature = "test-util"))]
pub use timing::Timing;
