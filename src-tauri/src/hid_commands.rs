// SPDX-License-Identifier: GPL-2.0-or-later
//! The raw HID commands behind the vialAPI shim's device members, the
//! WebView-side transport (src/tauri-shim/hid-transport.ts) and the probe
//! (src/tauri-shim/api/device.ts). Only bytes cross here; the Vial protocol
//! runs in the WebView.

use std::sync::Arc;

use pipette_hid::{DeviceInfo, DeviceType, HidError, HidService, MSG_LEN};
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;

use crate::command_error::CommandError;

/// The process-wide HID service, shared with the blocking I/O tasks.
pub struct Hid(pub Arc<HidService>);

/// Same values as `DeviceType` in src/shared/types/protocol.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "DeviceType")]
pub enum DeviceTypeDto {
    Vial,
    Via,
    Bootloader,
}

impl From<DeviceType> for DeviceTypeDto {
    fn from(t: DeviceType) -> Self {
        match t {
            DeviceType::Vial => Self::Vial,
            DeviceType::Via => Self::Via,
            DeviceType::Bootloader => Self::Bootloader,
        }
    }
}

/// Same shape as `DeviceInfo` in src/shared/types/protocol.ts.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeviceInfo")]
pub struct DeviceInfoDto {
    vendor_id: u16,
    product_id: u16,
    product_name: String,
    serial_number: String,
    #[serde(rename = "type")]
    device_type: DeviceTypeDto,
}

impl From<DeviceInfo> for DeviceInfoDto {
    fn from(d: DeviceInfo) -> Self {
        Self {
            vendor_id: d.vendor_id,
            product_id: d.product_id,
            product_name: d.product_name,
            serial_number: d.serial_number,
            device_type: d.device_type.into(),
        }
    }
}

/// One outgoing report: an array of at most MSG_LEN integers in 0..=255, as
/// `validateHidData` in src/main/hid-service.ts accepts. The byte range is
/// enforced by deserializing into `u8`, the length here, so an invalid
/// payload is rejected before it reaches the service.
#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(try_from = "Vec<u8>")]
pub struct HidData(Vec<u8>);

impl TryFrom<Vec<u8>> for HidData {
    type Error = String;

    fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
        if bytes.len() > MSG_LEN {
            return Err(format!("HID data exceeds maximum length of {MSG_LEN}"));
        }
        Ok(Self(bytes))
    }
}

/// Runs `io` on a blocking-task thread: hidapi calls block (reads wait up to
/// the HID timeout and are retried), and must stay off the async runtime and
/// the UI thread.
async fn blocking<R, F>(hid: &State<'_, Hid>, io: F) -> Result<R, CommandError>
where
    R: Send + 'static,
    F: FnOnce(&HidService) -> Result<R, HidError> + Send + 'static,
{
    let service = Arc::clone(&hid.0);
    Ok(tauri::async_runtime::spawn_blocking(move || io(&service)).await??)
}

#[tauri::command]
pub async fn list_devices(hid: State<'_, Hid>) -> Result<Vec<DeviceInfoDto>, CommandError> {
    blocking(&hid, |service| {
        service.list_devices().map(|devices| devices.into_iter().map(DeviceInfoDto::from).collect())
    })
    .await
}

#[tauri::command]
pub async fn open_device(hid: State<'_, Hid>, vendor_id: u16, product_id: u16) -> Result<bool, CommandError> {
    blocking(&hid, move |service| service.open_device(vendor_id, product_id)).await
}

#[tauri::command]
pub async fn close_device(hid: State<'_, Hid>) -> Result<(), CommandError> {
    blocking(&hid, |service| {
        service.close_device();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn send_receive(hid: State<'_, Hid>, data: HidData) -> Result<Vec<u8>, CommandError> {
    blocking(&hid, move |service| service.send_receive(&data.0).map(|report| report.to_vec())).await
}

#[tauri::command]
pub async fn send(hid: State<'_, Hid>, data: HidData) -> Result<(), CommandError> {
    blocking(&hid, move |service| service.send(&data.0)).await
}

#[tauri::command]
pub async fn is_device_open(hid: State<'_, Hid>) -> Result<bool, CommandError> {
    blocking(&hid, |service| service.is_device_open()).await
}

/// Opens a keyboard other than the main connection for a probe (see
/// `HidService::probe_open`) and returns the probe handle's id.
#[tauri::command]
pub async fn hid_probe_open(
    hid: State<'_, Hid>,
    vendor_id: u16,
    product_id: u16,
    serial_number: Option<String>,
) -> Result<u32, CommandError> {
    blocking(&hid, move |service| service.probe_open(vendor_id, product_id, serial_number.as_deref())).await
}

/// One report over the probe handle `id`, one read, no retries.
#[tauri::command]
pub async fn hid_probe_send_receive(
    hid: State<'_, Hid>,
    id: u32,
    data: HidData,
) -> Result<Vec<u8>, CommandError> {
    blocking(&hid, move |service| service.probe_send_receive(id, &data.0).map(|report| report.to_vec())).await
}

#[tauri::command]
pub async fn hid_probe_close(hid: State<'_, Hid>, id: u32) -> Result<(), CommandError> {
    blocking(&hid, move |service| {
        service.probe_close(id);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parse(value: serde_json::Value) -> Result<HidData, String> {
        serde_json::from_value(value).map_err(|err| err.to_string())
    }

    #[test]
    fn accepts_bytes_up_to_the_report_length() {
        assert_eq!(parse(json!([])).unwrap(), HidData(vec![]));
        assert_eq!(parse(json!([0, 255, 0x12])).unwrap(), HidData(vec![0, 255, 0x12]));
        assert_eq!(parse(json!(vec![7; MSG_LEN])).unwrap(), HidData(vec![7; MSG_LEN]));
    }

    #[test]
    fn rejects_more_than_one_report() {
        let err = parse(json!(vec![0; MSG_LEN + 1])).unwrap_err();
        assert!(err.contains("HID data exceeds maximum length of 32"), "{err}");
    }

    #[test]
    fn rejects_values_that_are_not_bytes() {
        for bad in [json!([256]), json!([-1]), json!([1.5]), json!(["1"]), json!([null]), json!([true])] {
            assert!(parse(bad.clone()).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn rejects_a_payload_that_is_not_an_array() {
        for bad in [json!(null), json!(5), json!("data"), json!({ "0": 1 })] {
            assert!(parse(bad.clone()).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn device_info_serializes_in_the_renderer_shape() {
        let info = DeviceInfo {
            vendor_id: 0x5049,
            product_id: 0x0001,
            product_name: "Virtual Keyboard".into(),
            serial_number: "vial:f64c2b3c".into(),
            device_type: DeviceType::Vial,
        };
        assert_eq!(
            serde_json::to_value(DeviceInfoDto::from(info)).unwrap(),
            json!({
                "vendorId": 0x5049,
                "productId": 1,
                "productName": "Virtual Keyboard",
                "serialNumber": "vial:f64c2b3c",
                "type": "vial",
            })
        );
    }
}
