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

/** Nests `withWriteLock` over every key in `keys`, held for the whole span
 * of `task` (not released between keys) — a multi-unit operation (e.g. a
 * local-data import touching several uids and favorite types at once)
 * needs every touched key locked from its first read to its last write,
 * or a concurrent single-key writer could observe a stale read partway
 * through the multi-key operation. Deduped and sorted here, inside the
 * lock helper, rather than trusted from the caller: a duplicate key would
 * deadlock against itself (`withWriteLock` is not reentrant), and two
 * concurrent multi-key callers that share some keys but acquire them in
 * different orders can deadlock each other — sorting gives every caller
 * the same fixed acquisition order regardless of the order `keys` arrived
 * in. */
export function withWriteLocks<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort()
  const run = (remaining: readonly string[]): Promise<T> => {
    if (remaining.length === 0) return task()
    const [key, ...rest] = remaining
    return withWriteLock(key, () => run(rest))
  }
  return run(ordered)
}
