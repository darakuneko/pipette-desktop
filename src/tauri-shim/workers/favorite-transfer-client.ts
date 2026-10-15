// SPDX-License-Identifier: GPL-2.0-or-later
// Sends favorite transfer requests to their worker
// (favorite-transfer.worker.ts), started on the first request and kept for
// the next ones. Answers are matched to requests by id. If the worker
// fails (it cannot load, or a message cannot be read), every request in
// flight rejects and the next request starts a new worker.

import type { FavoriteTransferRequest, FavoriteTransferResult } from './favorite-transfer-requests'

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function fail(message: string): void {
  worker?.terminate()
  worker = null
  const waiting = [...pending.values()]
  pending.clear()
  for (const { reject } of waiting) reject(new Error(message))
}

function start(): Worker {
  const started = new Worker(new URL('./favorite-transfer.worker.ts', import.meta.url), { type: 'module' })
  started.addEventListener('message', (event: MessageEvent<{ id: number; result: unknown }>) => {
    const { id, result } = event.data
    pending.get(id)?.resolve(result)
    pending.delete(id)
  })
  started.addEventListener('error', (event) => {
    event.preventDefault()
    fail(`favorite transfer worker failed: ${event.message}`)
  })
  started.addEventListener('messageerror', () => fail('favorite transfer worker sent an unreadable message'))
  return started
}

/** The worker's answer to `request`. */
export function transfer<R extends FavoriteTransferRequest>(request: R): Promise<FavoriteTransferResult<R>> {
  worker ??= start()
  const id = nextId++
  const promise = new Promise<FavoriteTransferResult<R>>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
  })
  worker.postMessage({ id, request })
  return promise
}
