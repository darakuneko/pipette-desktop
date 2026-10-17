// SPDX-License-Identifier: GPL-2.0-or-later
// The IPC handlers the Electron code registers through ipc-guard.ts
// (secureHandle / secureOn), kept by channel so the Hub fixture
// generators can call them as the renderer would.

type Handler = (...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()

export function registerHandler(channel: string, handler: Handler): void {
  handlers.set(channel, handler)
}

/** Calls the handler of `channel` with `args` after the event argument,
 *  as `ipcRenderer.invoke` would. */
export async function invokeHandler(channel: string, args: readonly unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`hub fixture harness: no handler for ${channel}`)
  return await handler({ senderFrame: { origin: 'file://' } }, ...args)
}
