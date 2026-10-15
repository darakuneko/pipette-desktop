// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// Replays the invoke fixtures (src-tauri/tests/fixtures/ipc/<domain>.json)
// against the shim: calling `member` with `args` invokes `command` with
// `invokeArgs` and nothing else, and resolves with `response`. The Rust
// tests (src-tauri/src/ipc_contract.rs) check the same entries against the
// commands' argument and return types.
//
// `member` is a VialAPI member, or `<module>.<export>` for a shim function
// that is not one.

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { APP_COMMANDS } from '../generated/app-command-names'

interface Entry {
  member: string
  args: unknown[]
  command: string
  invokeArgs: Record<string, unknown>
  response: unknown
}

const FIXTURE_DIR = resolve(__dirname, '../../../src-tauri/tests/fixtures/ipc')

const entries: Entry[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf8')) as Entry[])

interface Shim {
  appConfig: typeof import('../api/app-config')
  device: typeof import('../api/device')
  files: typeof import('../api/files')
  shell: typeof import('../api/shell')
  syncPending: typeof import('../api/sync-pending')
  window: typeof import('../api/window')
  transport: typeof import('../hid-transport')
}

/** Fresh modules for each entry: the transport keeps the open flag. */
async function load(): Promise<Shim> {
  vi.resetModules()
  return {
    appConfig: await import('../api/app-config'),
    device: await import('../api/device'),
    files: await import('../api/files'),
    shell: await import('../api/shell'),
    syncPending: await import('../api/sync-pending'),
    window: await import('../api/window'),
    transport: await import('../hid-transport'),
  }
}

interface Caller {
  /** Puts the shim in the state the call needs, before the calls are recorded. */
  setup?: (shim: Shim) => Promise<unknown>
  /** Calls the member; a member that resolves with nothing resolves with undefined here. */
  run: (shim: Shim, args: unknown[]) => Promise<unknown>
  /** The member resolves with nothing, whatever the command responds. */
  void?: true
}

const bytes = (value: unknown): Uint8Array => Uint8Array.from(value as number[])

const CALLERS: Record<string, Caller> = {
  listDevices: { run: ({ device }) => device.deviceApi.listDevices() },
  openDevice: {
    run: ({ device }, [vendorId, productId]) => device.deviceApi.openDevice(vendorId as number, productId as number),
  },
  closeDevice: { run: ({ device }) => device.deviceApi.closeDevice(), void: true },
  // A closed transport answers false without asking the backend.
  isDeviceOpen: {
    setup: ({ device }) => device.deviceApi.openDevice(1, 2),
    run: ({ device }) => device.deviceApi.isDeviceOpen(),
  },
  'hid-transport.sendReceive': {
    run: async ({ transport }, [data]) => Array.from(await transport.sendReceive(bytes(data))),
  },
  'hid-transport.send': { run: ({ transport }, [data]) => transport.send(bytes(data)), void: true },
  appConfigGetAll: { run: ({ appConfig }) => appConfig.appConfigApi.appConfigGetAll() },
  appConfigSet: {
    run: ({ appConfig }, [key, value]) => appConfig.appConfigApi.appConfigSet(key as string, value),
    void: true,
  },
  'device.decompressDefinition': {
    run: ({ device }, [data]) => device.decompressDefinition(data as number[]),
  },
  'device.probeOpen': {
    run: ({ device }, [vendorId, productId, serialNumber]) =>
      device.probeOpen(vendorId as number, productId as number, serialNumber as string),
  },
  'device.probeSendReceive': {
    run: ({ device }, [id, data]) => device.probeSendReceive(id as number, data as number[]),
  },
  'device.probeClose': { run: ({ device }, [id]) => device.probeClose(id as number), void: true },
  openExternal: { run: ({ shell }, [url]) => shell.shellApi.openExternal(url as string), void: true },
  setWindowZoom: { run: ({ window }, [zoom]) => window.windowApi.setWindowZoom(zoom as number), void: true },
  windowShow: { run: ({ window }) => window.windowApi.windowShow() },
  windowHide: { run: ({ window }) => window.windowApi.windowHide(), void: true },
  windowStartedHidden: { run: ({ window }) => window.windowApi.windowStartedHidden() },
  windowIsVisible: { run: ({ window }) => window.windowApi.windowIsVisible() },
  syncHasPendingChanges: { run: ({ syncPending }) => syncPending.syncPendingApi.syncHasPendingChanges() },
  saveLayout: { run: ({ files }, [json, name]) => files.filesApi.saveLayout(json as string, name as string) },
  loadLayout: {
    run: ({ files }, [title, extensions]) => files.filesApi.loadLayout(title as string, extensions as string[]),
  },
  exportKeymapC: {
    run: ({ files }, [content, name]) => files.filesApi.exportKeymapC(content as string, name as string),
  },
  exportPdf: { run: ({ files }, [data, name]) => files.filesApi.exportPdf(data as string, name as string) },
  exportCsv: { run: ({ files }, [content, name]) => files.filesApi.exportCsv(content as string, name as string) },
  exportCsvBundle: {
    run: ({ files }, [list]) => files.filesApi.exportCsvBundle(list as { name: string; content: string }[]),
  },
  exportJson: { run: ({ files }, [content, name]) => files.filesApi.exportJson(content as string, name as string) },
  sideloadJson: { run: ({ files }, [title]) => files.filesApi.sideloadJson(title as string) },
}

afterEach(() => {
  clearMocks()
})

describe('invoke fixtures', () => {
  it('cover every app command', () => {
    const commands = new Set(entries.map((entry) => entry.command))
    for (const command of APP_COMMANDS) {
      expect(commands.has(command), command).toBe(true)
    }
  })

  it.each(entries.map((entry) => [`${entry.member} (${entry.command})`, entry] as const))(
    '%s invokes the command with the recorded arguments and resolves with the response',
    async (_name, entry) => {
      const caller = CALLERS[entry.member]
      expect(caller, `no caller for ${entry.member}`).toBeDefined()
      const calls: [string, unknown][] = []
      mockIPC((cmd, payload) => {
        calls.push([cmd, payload])
        if (cmd === entry.command) return entry.response
        if (cmd === 'open_device') return true
        throw new Error(`unexpected command ${cmd}`)
      })
      const shim = await load()
      await caller.setup?.(shim)
      calls.length = 0

      const result = await caller.run(shim, entry.args)
      expect(calls).toEqual([[entry.command, entry.invokeArgs]])
      expect(result).toEqual(caller.void ? undefined : entry.response)
    },
  )
})
