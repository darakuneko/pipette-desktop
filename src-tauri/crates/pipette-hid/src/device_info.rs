// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::dataset::{
    VIRTUAL_DEVICE_NAME, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_SERIAL, VIRTUAL_DEVICE_VID,
};

use crate::constants::BOOTLOADER_SERIAL_MAGIC;

/// Same values as `DeviceType` in `src/shared/types/protocol.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceType {
    Vial,
    Via,
    Bootloader,
}

impl DeviceType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vial => "vial",
            Self::Via => "via",
            Self::Bootloader => "bootloader",
        }
    }
}

/// Same shape as `DeviceInfo` in `src/shared/types/protocol.ts`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceInfo {
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub serial_number: String,
    pub device_type: DeviceType,
}

/// Classify by serial number: the Vial bootloader serial marks a
/// bootloader; everything else on the Vial usage page — with the Vial serial
/// magic or an unrecognized serial — is treated as Vial.
pub fn classify_device(serial_number: &str) -> DeviceType {
    if serial_number.contains(BOOTLOADER_SERIAL_MAGIC) { DeviceType::Bootloader } else { DeviceType::Vial }
}

pub fn virtual_device_info() -> DeviceInfo {
    DeviceInfo {
        vendor_id: VIRTUAL_DEVICE_VID,
        product_id: VIRTUAL_DEVICE_PID,
        product_name: VIRTUAL_DEVICE_NAME.to_owned(),
        serial_number: VIRTUAL_DEVICE_SERIAL.to_owned(),
        device_type: DeviceType::Vial,
    }
}
