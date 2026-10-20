// SPDX-License-Identifier: GPL-2.0-or-later
// The HID transport that src/tauri-shim/protocol.ts imports
// (src/tauri-shim/hid-transport.ts), which checks its exports against
// this interface.

import type { DeviceInfo } from './protocol'

export interface HidTransport {
  listDevices(): Promise<DeviceInfo[]>
  openHidDevice(vendorId: number, productId: number): Promise<boolean>
  closeHidDevice(): Promise<void>
  /** Send one report (at most 32 bytes) and receive the 32-byte response. */
  sendReceive(data: Uint8Array): Promise<Uint8Array>
  /** Send one report without waiting for a response. */
  send(data: Uint8Array): Promise<void>
  /** Whether a device is open and still present; a vanished one is closed. */
  isDeviceOpen(): Promise<boolean>
}

/** Compiles only when `T` provides every HidTransport member. A transport
 *  module applies it to its own namespace type. */
export type ImplementsHidTransport<T extends HidTransport> = T
