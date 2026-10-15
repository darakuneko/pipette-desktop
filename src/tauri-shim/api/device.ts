// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI device and protocol members for the Tauri build: the protocol
// members are the Electron preload's (src/preload/protocol-members.ts)
// around the same src/preload/protocol.ts, whose transport is the Tauri one
// (../hid-transport, see vite.tauri.config.ts). The definition is
// decompressed by the backend (src-tauri/src/definition.rs), as the Electron
// main process does it. probeDevice runs the shared probe sequence
// (src/shared/hid/probe-sequence.ts) over the backend's probe handle
// (the hid_probe_* commands of src-tauri/src/hid_commands.rs).

import * as protocol from '../../preload/protocol'
import { createProtocolMembers, type DecompressDefinition } from '../../preload/protocol-members'
import { runProbeSequence } from '../../shared/hid/probe-sequence'
import type { ProbeResult } from '../../shared/types/protocol'
import type { VialAPI } from '../../shared/types/vial-api'
import type { CompressedDefinition } from '../generated/CompressedDefinition'
import type { DecompressedDefinition } from '../generated/DecompressedDefinition'
import { call } from '../ipc'
import { closeHidDevice, isDeviceOpen, listDevices, openHidDevice } from '../hid-transport'

export const decompressDefinition: DecompressDefinition = (compressed) =>
  call<DecompressedDefinition>('decompress_definition', {
    data: compressed satisfies CompressedDefinition,
  })

/** Opens a keyboard other than the main connection for a probe; resolves
 *  with the probe handle's id. */
export function probeOpen(vendorId: number, productId: number, serialNumber?: string): Promise<number> {
  return call<number>('hid_probe_open', { vendorId, productId, serialNumber })
}

/** One request over the probe handle `id`, one read, no retries. */
export function probeSendReceive(id: number, data: number[]): Promise<number[]> {
  return call<number[]>('hid_probe_send_receive', { id, data })
}

export async function probeClose(id: number): Promise<void> {
  await call<void>('hid_probe_close', { id })
}

async function probeDevice(vendorId: number, productId: number, serialNumber?: string): Promise<ProbeResult> {
  const id = await probeOpen(vendorId, productId, serialNumber)
  try {
    return await runProbeSequence((data) => probeSendReceive(id, data), decompressDefinition)
  } finally {
    // A handle left open is closed by the backend at the next probe, when
    // the page loads again and at quit, so a failed close does not change
    // the probe's outcome.
    await probeClose(id).catch(() => {})
  }
}

export const deviceApi = {
  // --- Device Management ---
  listDevices: () => listDevices(),
  openDevice: (vendorId, productId) => openHidDevice(vendorId, productId),
  closeDevice: () => closeHidDevice(),
  isDeviceOpen: () => isDeviceOpen(),
  probeDevice,

  ...createProtocolMembers(protocol, decompressDefinition),
} satisfies Partial<VialAPI>
