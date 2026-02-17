// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler registration for HID operations (main process)

import { IpcChannels } from '../shared/ipc/channels'
import { MSG_LEN } from '../shared/constants/protocol'
import * as hidService from './hid-service'
import { secureHandle } from './ipc-guard'

/**
 * Register IPC handlers for HID device operations.
 * These bridge preload → main for node-hid access.
 */
export function setupHidIpc(): void {
  // --- Standard HID (32-byte) ---
  secureHandle(IpcChannels.HID_LIST_DEVICES, () => hidService.listDevices())

  secureHandle(
    IpcChannels.HID_OPEN_DEVICE,
    (_event, vendorId: number, productId: number) =>
      hidService.openHidDevice(vendorId, productId),
  )

  secureHandle(IpcChannels.HID_CLOSE_DEVICE, () => hidService.closeHidDevice())

  secureHandle(IpcChannels.HID_SEND_RECEIVE, (_event, data: unknown) =>
    hidService.sendReceive(hidService.validateHidData(data, MSG_LEN)),
  )

  secureHandle(IpcChannels.HID_SEND, (_event, data: unknown) =>
    hidService.send(hidService.validateHidData(data, MSG_LEN)),
  )

  secureHandle(IpcChannels.HID_IS_DEVICE_OPEN, () => hidService.isDeviceOpen())
}
