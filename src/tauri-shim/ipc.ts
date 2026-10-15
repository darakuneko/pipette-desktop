// SPDX-License-Identifier: GPL-2.0-or-later
// The two ways the shim talks to the backend: `call` for a command, and
// `subscribe` for an event the backend emits.

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { APP_COMMANDS } from './generated/app-command-names'

/** A backend app command, as src-tauri/src/app_command_names.rs lists them. */
export type CommandName = (typeof APP_COMMANDS)[number]

/**
 * Invokes `command`. A command fails with its error message, a string (the
 * `CommandError` of src-tauri/src/command_error.rs); it rejects here as
 * `new Error(message)`, as an `ipcRenderer.invoke` rejection reaches the
 * renderer.
 */
export async function call<T>(command: CommandName, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err))
  }
}

/**
 * Calls `callback` with the payload of each `channel` event until the
 * returned function is called. Listening finishes asynchronously, but the
 * returned function works at once: no payload reaches `callback` after it,
 * and the listener is removed as soon as listening has finished.
 */
export function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  let subscribed = true
  const unlisten = listen<T>(channel, (event) => {
    if (subscribed) callback(event.payload)
  }).catch((err: unknown) => {
    console.error(`[vialAPI shim] failed to listen to ${channel}:`, err)
    return null
  })
  return () => {
    if (!subscribed) return
    subscribed = false
    void unlisten.then((stop) => stop?.()).catch((err: unknown) => {
      console.error(`[vialAPI shim] failed to stop listening to ${channel}:`, err)
    })
  }
}
