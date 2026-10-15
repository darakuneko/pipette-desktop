// SPDX-License-Identifier: GPL-2.0-or-later
// Runs the shim's writes of one store key one at a time, in the order the
// renderer made them. The backend runs commands concurrently and may start
// them in any order, while the Electron main process starts its handlers in
// the order the calls arrive; each write here is invoked only once the one
// before it with the same key has finished (failed writes included). The
// store keys are the write-lock keys of the stores
// (src/main/per-uid-write-lock.ts and the keyboard names' own queue in
// src/main/sync/keyboard-meta.ts), which the backend locks under the same
// names; the app config sets have a key of their own (api/app-config.ts).

const tails = new Map<string, Promise<unknown>>()

/** Runs `task` after every task queued under `key` before it has settled. */
export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
