// SPDX-License-Identifier: GPL-2.0-or-later
// node-hid based HID transport — runs in main process.
// Handles raw HID device enumeration, connection, and 32-byte packet I/O.

import HID from 'node-hid'
import {
  MSG_LEN,
  HID_USAGE_PAGE,
  HID_USAGE,
  HID_REPORT_ID,
  HID_TIMEOUT_MS,
  HID_RETRY_COUNT,
  HID_RETRY_DELAY_MS,
  HID_OPEN_RETRY_COUNT,
  HID_OPEN_RETRY_DELAY_MS,
  VIAL_SERIAL_MAGIC,
  BOOTLOADER_SERIAL_MAGIC,
} from '../shared/constants/protocol'
import { log, logHidPacket } from './logger'
import type { DeviceInfo, DeviceType, ProbeResult } from '../shared/types/protocol'
import { decompressLzma, decompressXz, hasXzMagic } from './lzma'
import { runProbeSequence } from '../shared/hid/probe-sequence'
import {
  isVirtualDeviceEnabled,
  isVirtualDeviceExclusive,
  getVirtualDeviceInfo,
  matchesVirtualDevice,
  openVirtualDevice,
  closeVirtualDevice,
  isVirtualDeviceOpen,
  handleVirtualReport,
} from './virtual-device'

let openDevice: HID.HIDAsync | null = null
let openDevicePath: string | null = null
let sendMutex: Promise<void> = Promise.resolve()

/**
 * Pad data to exactly MSG_LEN bytes, truncating or zero-filling as needed.
 */
function padToMsgLen(data: number[]): number[] {
  const padded = new Array<number>(MSG_LEN).fill(0)
  for (let i = 0; i < Math.min(data.length, MSG_LEN); i++) {
    padded[i] = data[i]
  }
  return padded
}

/**
 * Acquire the send mutex, returning { prev, release }.
 * Caller must chain on `prev` and call `release()` when done.
 */
function acquireMutex(): { prev: Promise<void>; release: () => void } {
  const prev = sendMutex
  let release: () => void
  sendMutex = new Promise<void>((resolve) => {
    release = resolve
  })
  return { prev, release: release! }
}

/**
 * Classify a device by serial number.
 * node-hid provides serial numbers directly, unlike WebHID in Electron.
 * Devices on the Vial usage page without recognized serial are assumed Vial.
 */
function classifyDevice(serialNumber: string): DeviceType {
  if (serialNumber.includes(BOOTLOADER_SERIAL_MAGIC)) return 'bootloader'
  if (serialNumber.includes(VIAL_SERIAL_MAGIC)) return 'vial'
  // Usage page 0xFF60 is Vial-specific; default to 'vial' when serial is unrecognized
  return 'vial'
}

/**
 * Normalize a read buffer to exactly MSG_LEN bytes.
 * node-hid may include report ID as the first byte on some platforms;
 * if the buffer is MSG_LEN + 1 and starts with the report ID, strip it.
 */
function normalizeResponse(buf: Buffer, expectedLen: number): number[] {
  // Strip leading report ID if present
  if (buf.length === expectedLen + 1 && buf[0] === HID_REPORT_ID) {
    return Array.from(buf.subarray(1, expectedLen + 1))
  }
  // Pad or truncate to expected length
  const result = new Array<number>(expectedLen).fill(0)
  for (let i = 0; i < Math.min(buf.length, expectedLen); i++) {
    result[i] = buf[i]
  }
  return result
}

/**
 * List available Vial/VIA HID devices.
 * Filters by usage page 0xFF60 and usage 0x61.
 */
export async function listDevices(): Promise<DeviceInfo[]> {
  // 'only' mode: hide real hardware so device lists (and doc screenshots)
  // are reproducible regardless of what is plugged into the workstation.
  if (isVirtualDeviceExclusive()) {
    return [getVirtualDeviceInfo()]
  }

  const devices = await HID.devicesAsync()
  const result: DeviceInfo[] = []

  for (const d of devices) {
    if (d.usagePage !== HID_USAGE_PAGE || d.usage !== HID_USAGE) continue

    const serial = d.serialNumber ?? ''
    const type = classifyDevice(serial)
    result.push({
      vendorId: d.vendorId,
      productId: d.productId,
      productName: d.product ?? '',
      serialNumber: serial,
      type,
    })
  }

  if (isVirtualDeviceEnabled()) {
    result.push(getVirtualDeviceInfo())
  }

  return result
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Thrown when a read comes back empty: the HID_TIMEOUT_MS window passed with no
 * report (hidapi on Linux also maps EAGAIN/EINPROGRESS to an empty read).
 * This is the only condition worth retrying — see isTransientError.
 */
class HidReadTimeoutError extends Error {
  constructor() {
    super('HID read timeout')
    this.name = 'HidReadTimeoutError'
  }
}

// Only an empty read is retryable. Every hidapi rejection — write failure,
// disconnect, I/O error — fails immediately whatever its message says: disconnect
// errors on Linux, macOS and Windows all embed the hidapi function name
// hid_read_timeout, so matching on the word "timeout" would retry a dead device
// for ~10s and flood the mutex queue.
function isTransientError(err: Error): boolean {
  return err instanceof HidReadTimeoutError
}

/**
 * Record an open failure — either enumeration (HID.devicesAsync()) or the final
 * retry of HID.HIDAsync.open() — so the raw cause isn't lost behind the
 * renderer's translated message. Wrapped in try/catch so a logging failure
 * never masks the original error.
 */
function logOpenFailure(vendorId: number, productId: number, err: unknown): void {
  try {
    const vid = vendorId.toString(16).padStart(4, '0')
    const pid = productId.toString(16).padStart(4, '0')
    const message = err instanceof Error ? err.message : String(err)
    log('error', `Failed to open HID device 0x${vid}:0x${pid}: ${message}`)
  } catch {
    // Ignore logging failures.
  }
}

/**
 * Open a HID device by vendorId and productId.
 * Uses device path for precise matching.
 * Retries with a delay to work around transient open failures on all platforms.
 */
export async function openHidDevice(vendorId: number, productId: number): Promise<boolean> {
  await closeHidDevice()

  if (isVirtualDeviceEnabled() && matchesVirtualDevice(vendorId, productId)) {
    await openVirtualDevice()
    return true
  }

  let devices: Awaited<ReturnType<typeof HID.devicesAsync>>
  try {
    devices = await HID.devicesAsync()
  } catch (err) {
    logOpenFailure(vendorId, productId, err)
    throw err
  }
  const deviceInfo = devices.find(
    (d) =>
      d.vendorId === vendorId &&
      d.productId === productId &&
      d.usagePage === HID_USAGE_PAGE &&
      d.usage === HID_USAGE,
  )

  if (!deviceInfo?.path) return false

  for (let attempt = 0; attempt < HID_OPEN_RETRY_COUNT; attempt++) {
    try {
      openDevice = await HID.HIDAsync.open(deviceInfo.path)
      openDevicePath = deviceInfo.path
      return true
    } catch (err) {
      if (attempt < HID_OPEN_RETRY_COUNT - 1) {
        await delay(HID_OPEN_RETRY_DELAY_MS)
        continue
      }
      logOpenFailure(vendorId, productId, err)
      throw err
    }
  }

  return false
}

/**
 * Close the currently open HID device.
 */
export async function closeHidDevice(): Promise<void> {
  if (openDevice) {
    try {
      openDevice.close()
    } catch {
      // Ignore close errors (device may already be disconnected)
    }
  }
  openDevice = null
  openDevicePath = null

  // Always clear the virtual-open flag, not just when the feature flag is
  // currently set: sendReceive()/send()/isDeviceOpen() route on
  // isVirtualDeviceOpen() alone, so a stale open flag would keep hijacking
  // HID calls if the env var changes between open and close.
  closeVirtualDevice()
}

/**
 * Validate IPC data: must be an array of bytes (0-255), length <= maxLen.
 */
export function validateHidData(data: unknown, maxLen: number): number[] {
  if (!Array.isArray(data)) {
    throw new Error('HID data must be an array')
  }
  if (data.length > maxLen) {
    throw new Error(`HID data exceeds maximum length of ${maxLen}`)
  }
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (typeof v !== 'number' || v < 0 || v > 255 || !Number.isInteger(v)) {
      throw new Error(`HID data byte at index ${i} is invalid: ${v}`)
    }
  }
  return data as number[]
}

/**
 * Send a 32-byte packet and receive a 32-byte response.
 * Serialized via mutex; retries on timeout up to HID_RETRY_COUNT times.
 */
export function sendReceive(data: number[]): Promise<number[]> {
  const { prev, release } = acquireMutex()

  return prev.then(async () => {
    try {
      if (isVirtualDeviceOpen()) {
        const padded = padToMsgLen(data)
        logHidPacket('TX', new Uint8Array(padded))
        const result = handleVirtualReport(padded)
        logHidPacket('RX', new Uint8Array(result))
        return result
      }

      if (!openDevice) {
        throw new Error('No HID device is open')
      }
      // Pin the handle for the whole operation, retries included: openHidDevice() /
      // closeHidDevice() reassign openDevice outside this mutex, so re-reading it
      // after an await could aim a retry at a closed or replaced handle.
      const device = openDevice

      const padded = padToMsgLen(data)
      logHidPacket('TX', new Uint8Array(padded))

      let lastError: Error | undefined
      for (let attempt = 0; attempt < HID_RETRY_COUNT; attempt++) {
        try {
          await device.write([HID_REPORT_ID, ...padded])

          const response = await device.read(HID_TIMEOUT_MS)
          if (!response || response.length === 0) {
            throw new HidReadTimeoutError()
          }

          const result = normalizeResponse(response, MSG_LEN)
          logHidPacket('RX', new Uint8Array(result))
          return result
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          if (!isTransientError(lastError)) throw lastError
          if (attempt < HID_RETRY_COUNT - 1) {
            await delay(HID_RETRY_DELAY_MS)
          }
        }
      }
      throw lastError ?? new Error('HID send/receive failed')
    } finally {
      release()
    }
  })
}

/**
 * Send a packet without waiting for response.
 * Serialized via mutex to prevent interleaving with sendReceive.
 */
export function send(data: number[]): Promise<void> {
  const { prev, release } = acquireMutex()

  return prev.then(async () => {
    try {
      if (isVirtualDeviceOpen()) {
        const padded = padToMsgLen(data)
        logHidPacket('TX', new Uint8Array(padded))
        handleVirtualReport(padded)
        return
      }

      if (!openDevice) {
        throw new Error('No HID device is open')
      }
      // Pin the handle for this write, same rationale as sendReceive: openHidDevice() /
      // closeHidDevice() reassign openDevice outside this mutex.
      const device = openDevice

      const padded = padToMsgLen(data)
      logHidPacket('TX', new Uint8Array(padded))
      await device.write([HID_REPORT_ID, ...padded])
    } finally {
      release()
    }
  })
}

/**
 * Check if a device is currently open and physically present.
 * Re-enumerates USB devices to detect physical disconnection.
 */
export async function isDeviceOpen(): Promise<boolean> {
  if (isVirtualDeviceOpen()) return true
  if (!openDevice || !openDevicePath) return false
  const devices = await HID.devicesAsync()
  const present = devices.some((d) => d.path === openDevicePath)
  if (!present) {
    await closeHidDevice()
  }
  return present
}

/**
 * Probe a secondary keyboard device to read its keymap without affecting the primary connection.
 * Opens a temporary HID handle, runs the shared probe sequence over it
 * (single read per request, no retries, no packet log), then closes it.
 */
export async function probeDevice(vendorId: number, productId: number, serialNumber?: string): Promise<ProbeResult> {
  const devices = await HID.devicesAsync()
  const deviceInfo = devices.find(
    (d) =>
      d.vendorId === vendorId &&
      d.productId === productId &&
      d.usagePage === HID_USAGE_PAGE &&
      d.usage === HID_USAGE &&
      d.path !== openDevicePath && // Exclude the primary device
      (!serialNumber || (d.serialNumber ?? '') === serialNumber),
  )

  if (!deviceInfo?.path) {
    throw new Error('Probe target device not found')
  }

  const tempDevice = await HID.HIDAsync.open(deviceInfo.path)

  try {
    return await runProbeSequence(
      async (data) => {
        const padded = padToMsgLen(data)
        await tempDevice.write([HID_REPORT_ID, ...padded])
        const response = await tempDevice.read(HID_TIMEOUT_MS)
        if (!response || response.length === 0) {
          throw new Error('HID read timeout during probe')
        }
        return normalizeResponse(response, MSG_LEN)
      },
      async (compressed) => {
        const buf = Buffer.from(compressed)
        return hasXzMagic(buf) ? decompressXz(buf) : decompressLzma(compressed)
      },
    )
  } finally {
    try {
      tempDevice.close()
    } catch {
      // Ignore close errors
    }
  }
}
