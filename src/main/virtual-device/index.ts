// SPDX-License-Identifier: GPL-2.0-or-later
// Public API for the virtual GPK60-63R emulator — the seam hid-service.ts
// calls into, plus a controller exposed to E2E tests for driving key
// presses and the unlock sequence without real HID hardware.

import { CMD_VIA_VIAL_PREFIX, MSG_LEN } from '../../shared/constants/protocol'
import type { DeviceInfo } from '../../shared/types/protocol'
import { VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_NAME, VIRTUAL_DEVICE_SERIAL, getCompressedDefinition } from './gpk60-63r'
import { createVirtualDeviceState, pressKey, releaseKey, releaseAll } from './state'
import type { VirtualDeviceState } from './state'
import { handleViaReport } from './via-handler'
import { handleVialReport } from './vial-handler'

let state: VirtualDeviceState | null = null
let compressedDefinition: Uint8Array | null = null
let open = false

/**
 * Read live (not cached at module load) so tests can toggle the env var
 * per-case. PIPETTE_VIRTUAL_DEVICE accepts two values:
 * - '1'    — append the virtual device to the real HID enumeration
 * - 'only' — expose the virtual device exclusively (real devices hidden),
 *            so doc screenshots don't depend on whatever hardware happens
 *            to be plugged into the workstation
 */
export function isVirtualDeviceEnabled(): boolean {
  const v = process.env.PIPETTE_VIRTUAL_DEVICE
  return v === '1' || v === 'only'
}

/** True only for PIPETTE_VIRTUAL_DEVICE='only' — list the virtual device alone. */
export function isVirtualDeviceExclusive(): boolean {
  return process.env.PIPETTE_VIRTUAL_DEVICE === 'only'
}

export function getVirtualDeviceInfo(): DeviceInfo {
  return {
    vendorId: VIRTUAL_DEVICE_VID,
    productId: VIRTUAL_DEVICE_PID,
    productName: VIRTUAL_DEVICE_NAME,
    serialNumber: VIRTUAL_DEVICE_SERIAL,
    type: 'vial',
  }
}

export function matchesVirtualDevice(vendorId: number, productId: number): boolean {
  return vendorId === VIRTUAL_DEVICE_VID && productId === VIRTUAL_DEVICE_PID
}

function ensureState(): VirtualDeviceState {
  if (!state) state = createVirtualDeviceState()
  return state
}

/**
 * Open the virtual device. State persists across re-opens within the same
 * process (like a powered-on keyboard keeping its EEPROM) — only `reset()`
 * on the controller restores factory defaults.
 */
export async function openVirtualDevice(): Promise<void> {
  ensureState()
  compressedDefinition = await getCompressedDefinition()
  open = true
}

export function closeVirtualDevice(): void {
  open = false
}

export function isVirtualDeviceOpen(): boolean {
  return open
}

/** Handle one raw 32-byte HID report and return the 32-byte response. */
export function handleVirtualReport(data: number[]): number[] {
  if (!open || !state || !compressedDefinition) {
    throw new Error('Virtual device is not open')
  }

  const req = new Uint8Array(MSG_LEN)
  for (let i = 0; i < Math.min(data.length, MSG_LEN); i++) {
    req[i] = data[i]
  }

  const now = Date.now()
  const resp =
    req[0] === CMD_VIA_VIAL_PREFIX
      ? handleVialReport(state, req, compressedDefinition, now)
      : handleViaReport(state, req)

  return Array.from(resp)
}

export interface VirtualDeviceControllerState {
  open: boolean
  unlocked: boolean
  unlockInProgress: boolean
  unlockCounter: number
}

export interface VirtualDeviceController {
  pressKey(row: number, col: number): void
  releaseKey(row: number, col: number): void
  tapKey(row: number, col: number, holdMs?: number): Promise<void>
  releaseAll(): void
  holdKeys(pairs: [number, number][]): void
  setUnlockCounterMax(n: number): void
  getState(): VirtualDeviceControllerState
  reset(): void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exposed on `globalThis.__pipetteVirtualDevice` for Playwright E2E tests to drive. */
export function getVirtualDeviceController(): VirtualDeviceController {
  return {
    pressKey(row, col) {
      pressKey(ensureState(), row, col)
    },
    releaseKey(row, col) {
      releaseKey(ensureState(), row, col)
    },
    async tapKey(row, col, holdMs = 0) {
      const s = ensureState()
      pressKey(s, row, col)
      if (holdMs > 0) await delay(holdMs)
      releaseKey(s, row, col)
    },
    releaseAll() {
      releaseAll(ensureState())
    },
    holdKeys(pairs) {
      const s = ensureState()
      for (const [row, col] of pairs) pressKey(s, row, col)
    },
    setUnlockCounterMax(n) {
      const s = ensureState()
      s.unlockCounterMax = n
      // Clamp a countdown already in progress so tests shortening the
      // sequence take effect immediately instead of after a combo release.
      if (s.unlockCounter > n) s.unlockCounter = n
    },
    getState() {
      const s = ensureState()
      return { open, unlocked: s.unlocked, unlockInProgress: s.unlockInProgress, unlockCounter: s.unlockCounter }
    },
    reset() {
      state = createVirtualDeviceState()
    },
  }
}
