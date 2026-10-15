// SPDX-License-Identifier: GPL-2.0-or-later

use crate::backend::RawDeviceInfo;
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

/// Missing strings become empty.
impl From<RawDeviceInfo> for DeviceInfo {
    fn from(d: RawDeviceInfo) -> Self {
        let serial_number = d.serial_number.unwrap_or_default();
        Self {
            vendor_id: d.vendor_id,
            product_id: d.product_id,
            product_name: d.product.unwrap_or_default(),
            device_type: classify_device(&serial_number),
            serial_number,
        }
    }
}
