// SPDX-License-Identifier: GPL-2.0-or-later
// Per-uid write serialization shared by the per-keyboard stores
// (pipette-settings, snapshots, analyze-filters). Each store does
// read-modify-write of a per-uid JSON file from independent async callers;
// chaining tasks per uid makes every read-merge-write atomic against the
// others, while different uids still run in parallel.

const writeChains = new Map<string, Promise<unknown>>()

/** Run `task` after any in-flight task for the same `uid` settles (success
 * OR failure, so one failed write never stalls the chain). Returns the
 * task's own promise; the chain entry is cleared once it drains to idle so
 * the map stays bounded by the number of actively-written uids. */
export function withWriteLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(uid) ?? Promise.resolve()
  const result = prev.then(task, task)
  // `chain` swallows errors so the next queued task still runs and the
  // `.finally` cleanup never triggers an unhandled rejection. It's the
  // stable reference tracked in the map (the tail-identity check).
  const chain: Promise<unknown> = result.catch(() => {})
  writeChains.set(uid, chain)
  void chain.finally(() => {
    if (writeChains.get(uid) === chain) writeChains.delete(uid)
  })
  return result
}
