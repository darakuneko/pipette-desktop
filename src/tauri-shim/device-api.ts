// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI device and protocol members for the Tauri build: the protocol
// members are the Electron preload's (src/preload/protocol-members.ts)
// around the same src/preload/protocol.ts, whose transport is the Tauri one
// (./hid-transport, see vite.tauri.config.ts). The definition is
// decompressed by the backend (src-tauri/src/definition.rs), as the Electron
// main process does it.

import { invoke } from '@tauri-apps/api/core'
import * as protocol from '../preload/protocol'
import { createProtocolMembers } from '../preload/protocol-members'
import type { VialAPI } from '../shared/types/vial-api'
import { closeHidDevice, isDeviceOpen, listDevices, openHidDevice } from './hid-transport'

export const deviceApi = {
  // --- Device Management ---
  listDevices: () => listDevices(),
  openDevice: (vendorId, productId) => openHidDevice(vendorId, productId),
  closeDevice: () => closeHidDevice(),
  isDeviceOpen: () => isDeviceOpen(),

  ...createProtocolMembers(protocol, (compressed) =>
    invoke<string | null>('decompress_definition', { data: compressed }),
  ),
} satisfies Partial<VialAPI>
