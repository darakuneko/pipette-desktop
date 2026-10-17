// SPDX-License-Identifier: GPL-2.0-or-later
// What the mocks of setup.ts share with the tests: the machine the
// Electron code runs as, and the IPC handlers its stores registered.

/** The machine id of the Electron code's machine hash, and the keyboards
 *  its typing analytics cache has typing for. */
export const machineEnv = { machineId: 'interop-machine-1', typingUids: [] as string[] }

/** The handlers `secureHandle` registered, by channel. */
export const handlers = new Map<string, (...args: unknown[]) => unknown>()
