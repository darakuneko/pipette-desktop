// SPDX-License-Identifier: GPL-2.0-or-later
// The backend commands the shim invokes, by the name of the shim function
// that calls each. The names must be those of APP_COMMANDS in
// src-tauri/src/app_command_names.rs; __tests__/commands.test.ts compares
// the two through the list the Rust tests export to
// generated/app-command-names.json.

export const COMMANDS = {
  listDevices: 'list_devices',
  openDevice: 'open_device',
  closeDevice: 'close_device',
  sendReceive: 'send_receive',
  send: 'send',
  isDeviceOpen: 'is_device_open',
  decompressDefinition: 'decompress_definition',
} as const

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS]
