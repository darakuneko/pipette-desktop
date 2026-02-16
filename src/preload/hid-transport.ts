/**
 * HID transport layer — IPC bridge to main process (node-hid).
 * Handles 32-byte packet I/O via ipcRenderer.invoke.
 *
 * All actual HID communication happens in the main process.
 * This module provides the same interface as the previous WebHID implementation.
 */

import { ipcRenderer } from 'electron'
import { IpcChannels } from '../shared/ipc/channels'
import type { DeviceInfo } from '../shared/types/protocol'

// Cache device-open state to skip IPC round-trip when device is known closed
let deviceOpen = false

/**
 * List available Vial/VIA HID devices.
 */
export async function listDevices(): Promise<DeviceInfo[]> {
  return ipcRenderer.invoke(IpcChannels.HID_LIST_DEVICES)
}

/**
 * Open a HID device by vendorId and productId.
 */
export async function openHidDevice(vendorId: number, productId: number): Promise<boolean> {
  const result = await ipcRenderer.invoke(IpcChannels.HID_OPEN_DEVICE, vendorId, productId)
  deviceOpen = result === true
  return deviceOpen
}

/**
 * Close the currently open HID device.
 */
export async function closeHidDevice(): Promise<void> {
  await ipcRenderer.invoke(IpcChannels.HID_CLOSE_DEVICE)
  deviceOpen = false
}

/**
 * Send a 32-byte packet and receive a 32-byte response.
 * Mutex and retry logic are handled in the main process.
 */
export async function sendReceive(data: Uint8Array): Promise<Uint8Array> {
  const result: number[] = await ipcRenderer.invoke(
    IpcChannels.HID_SEND_RECEIVE,
    Array.from(data),
  )
  return new Uint8Array(result)
}

/**
 * Send a packet without waiting for response.
 */
export async function send(data: Uint8Array): Promise<void> {
  await ipcRenderer.invoke(IpcChannels.HID_SEND, Array.from(data))
}

/**
 * Check if a device is currently open and physically present.
 * Queries main process to detect physical disconnection.
 */
export async function isDeviceOpen(): Promise<boolean> {
  if (!deviceOpen) return false
  const open = await ipcRenderer.invoke(IpcChannels.HID_IS_DEVICE_OPEN)
  if (!open) deviceOpen = false
  return open as boolean
}
