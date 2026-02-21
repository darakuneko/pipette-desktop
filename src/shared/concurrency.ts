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
