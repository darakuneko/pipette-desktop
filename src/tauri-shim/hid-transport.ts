// SPDX-License-Identifier: GPL-2.0-or-later
// The HID transport of ./protocol.ts: the HidTransport members
// (src/shared/types/hid-transport.ts), answered by the Rust HID commands
// (src-tauri/src/hid_commands.rs).

import type { ImplementsHidTransport } from '../shared/types/hid-transport'
import type { DeviceInfo } from './generated/DeviceInfo'
import type * as ThisModule from './hid-transport'
import { call, type CommandName } from './ipc'

// Skips the round trip to the backend while no device is open, as the
// Electron transport does.
let deviceOpen = false

// Async commands start in no fixed order on the backend, so reports are
// queued here: each send/sendReceive is invoked after the previous one has
// settled, preserving the call order the Electron main process keeps with
// its mutex.
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(command: CommandName, args: { data: number[] }): Promise<T> {
  const result = queue.then(() => call<T>(command, args))
  queue = result.catch(() => {})
  return result
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return call<DeviceInfo[]>('list_devices')
}

export async function openHidDevice(vendorId: number, productId: number): Promise<boolean> {
  const result = await call<boolean>('open_device', { vendorId, productId })
  deviceOpen = result === true
  return deviceOpen
}

export async function closeHidDevice(): Promise<void> {
  await call<void>('close_device')
  deviceOpen = false
}

/** Send one report (at most 32 bytes) and receive the 32-byte response. */
export async function sendReceive(data: Uint8Array): Promise<Uint8Array> {
  const result = await enqueue<number[]>('send_receive', { data: Array.from(data) })
  return new Uint8Array(result)
}

/** Send one report without waiting for a response. */
export async function send(data: Uint8Array): Promise<void> {
  await enqueue<void>('send', { data: Array.from(data) })
}

/** Whether a device is open and still present; a vanished one is closed. */
export async function isDeviceOpen(): Promise<boolean> {
  if (!deviceOpen) return false
  const open = await call<boolean>('is_device_open')
  if (!open) deviceOpen = false
  return open
}

/** Fails to compile when the exports of this module stop providing
 *  HidTransport. */
export type TauriHidTransport = ImplementsHidTransport<typeof ThisModule>
