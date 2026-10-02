// SPDX-License-Identifier: GPL-2.0-or-later
// Lightweight concurrency limiter (same API shape as p-limit)

type LimitFunction = <T>(fn: () => Promise<T>) => Promise<T>

export function pLimit(concurrency: number): LimitFunction {
  if (concurrency < 1) throw new RangeError('concurrency must be at least 1')
  let active = 0
  const queue: Array<() => void> = []

  function next(): void {
    if (active < concurrency && queue.length > 0) {
      active++
      queue.shift()!()
    }
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--
          next()
        })
      })
      next()
    })
  }
}

export interface RunConcurrentlyResult<R> {
  /** Worker result by item index; `undefined` for items that failed or never started. */
  results: Array<R | undefined>
  /** Worker failures, sorted by item index. */
  errors: Array<{ index: number; error: unknown }>
  /** Number of items whose worker was started. */
  started: number
  /** True when at least one item was skipped (after a failure or `shouldStop`). */
  stopped: boolean
}

export interface RunConcurrentlyOptions {
  /** Checked before each item starts; returning true starts no further items. */
  shouldStop?: () => boolean
}

/**
 * Runs `worker` over `items` with at most `concurrency` workers at once,
 * starting items in order. Unlike `Promise.all` over `pLimit`, a failure
 * does not leave queued work running in the background: once any worker
 * rejects (or `shouldStop` returns true) no further item starts, and the
 * returned promise settles only after every started worker has settled.
 * Worker failures are reported in the result, never thrown.
 */
export async function runConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  options: RunConcurrentlyOptions = {},
): Promise<RunConcurrentlyResult<R>> {
  if (!(concurrency >= 1)) throw new RangeError('concurrency must be at least 1')
  const results: Array<R | undefined> = new Array<R | undefined>(items.length).fill(undefined)
  const errors: Array<{ index: number; error: unknown }> = []
  let nextIndex = 0
  let started = 0
  let halted = false

  async function lane(): Promise<void> {
    while (nextIndex < items.length) {
      let stop: boolean
      try {
        stop = halted || (options.shouldStop?.() ?? false)
      } catch (error) {
        halted = true
        throw error
      }
      if (stop) {
        halted = true
        return
      }
      const index = nextIndex++
      started++
      try {
        results[index] = await worker(items[index], index)
      } catch (error) {
        errors.push({ index, error })
        halted = true
      }
    }
  }

  const laneCount = Math.min(concurrency, items.length)
  // A throwing `shouldStop` halts every lane; allSettled keeps this call from
  // rejecting until the workers already running in other lanes have settled.
  const settled = await Promise.allSettled(Array.from({ length: laneCount }, lane))
  const laneFailure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (laneFailure) throw laneFailure.reason

  errors.sort((a, b) => a.index - b.index)
  return { results, errors, started, stopped: started < items.length }
}
