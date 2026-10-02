// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { pLimit, runConcurrently } from '../concurrency'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('pLimit', () => {
  it('limits concurrent execution to the specified number', async () => {
    const limit = pLimit(2)
    let active = 0
    let maxActive = 0

    const task = () =>
      limit(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await delay(50)
        active--
      })

    await Promise.all([task(), task(), task(), task(), task()])

    expect(maxActive).toBe(2)
  })

  it('all tasks complete successfully', async () => {
    const limit = pLimit(2)
    const results: number[] = []

    const tasks = [1, 2, 3, 4, 5].map((n) =>
      limit(async () => {
        await delay(10)
        results.push(n)
        return n * 10
      }),
    )

    const values = await Promise.all(tasks)

    expect(values).toEqual([10, 20, 30, 40, 50])
    expect(results).toHaveLength(5)
  })

  it('propagates errors without blocking the queue', async () => {
    const limit = pLimit(1)
    const results: string[] = []

    const p1 = limit(async () => {
      throw new Error('fail')
    })

    const p2 = limit(async () => {
      results.push('ok')
      return 'success'
    })

    await expect(p1).rejects.toThrow('fail')
    await expect(p2).resolves.toBe('success')
    expect(results).toEqual(['ok'])
  })

  it('works with concurrency of 1 (sequential)', async () => {
    const limit = pLimit(1)
    const order: number[] = []

    const tasks = [1, 2, 3].map((n) =>
      limit(async () => {
        await delay(10)
        order.push(n)
        return n
      }),
    )

    const values = await Promise.all(tasks)

    expect(values).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
  })

  it('works with concurrency higher than task count', async () => {
    const limit = pLimit(10)
    let active = 0
    let maxActive = 0

    const tasks = [1, 2, 3].map((n) =>
      limit(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await delay(20)
        active--
        return n
      }),
    )

    const values = await Promise.all(tasks)

    expect(values).toEqual([1, 2, 3])
    expect(maxActive).toBe(3)
  })

  it('throws RangeError for concurrency < 1', () => {
    expect(() => pLimit(0)).toThrow(RangeError)
    expect(() => pLimit(-1)).toThrow(RangeError)
  })

  it('works with Promise.allSettled', async () => {
    const limit = pLimit(2)

    const results = await Promise.allSettled([
      limit(async () => 'a'),
      limit(async () => {
        throw new Error('b')
      }),
      limit(async () => 'c'),
    ])

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'a' })
    expect(results[1]).toEqual({ status: 'rejected', reason: expect.any(Error) })
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'c' })
  })
})

describe('runConcurrently', () => {
  it('runs at most `concurrency` workers at once', async () => {
    let active = 0
    let maxActive = 0

    await runConcurrently([1, 2, 3, 4, 5, 6], 2, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(20)
      active--
    })

    expect(maxActive).toBe(2)
  })

  it('starts items in input order', async () => {
    const startOrder: number[] = []

    await runConcurrently([0, 1, 2, 3, 4], 2, async (item) => {
      startOrder.push(item)
      // Later items finish first, so completion order differs from start order.
      await delay(50 - item * 10)
    })

    expect(startOrder).toEqual([0, 1, 2, 3, 4])
  })

  it('returns every result by index when all workers succeed', async () => {
    const result = await runConcurrently(['a', 'b', 'c'], 2, async (item, index) => {
      await delay(10)
      return `${item}${index}`
    })

    expect(result).toEqual({
      results: ['a0', 'b1', 'c2'],
      errors: [],
      started: 3,
      stopped: false,
    })
  })

  it('resolves immediately for empty input without calling the worker', async () => {
    let calls = 0

    const result = await runConcurrently([], 3, async () => {
      calls++
    })

    expect(calls).toBe(0)
    expect(result).toEqual({ results: [], errors: [], started: 0, stopped: false })
  })

  it('starts nothing new after a failure and waits for in-flight workers', async () => {
    const started: number[] = []
    const finished: number[] = []
    let failed = false
    let startedAfterFailure = false

    const result = await runConcurrently([0, 1, 2, 3, 4, 5], 3, async (item) => {
      if (failed) startedAfterFailure = true
      started.push(item)
      if (item === 0) {
        await delay(5)
        failed = true
        throw new Error('transfer failed')
      }
      // Slow in-flight workers that are still running when item 0 fails.
      await delay(60)
      finished.push(item)
      return item
    })

    expect(startedAfterFailure).toBe(false)
    expect(started).toEqual([0, 1, 2])
    // The promise only resolved after the slow in-flight workers finished.
    expect(finished.sort()).toEqual([1, 2])
    expect(result.started).toBe(3)
    expect(result.stopped).toBe(true)
    expect(result.results).toEqual([undefined, 1, 2, undefined, undefined, undefined])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].index).toBe(0)
    expect(result.errors[0].error).toBeInstanceOf(Error)
  })

  it('collects every failure from workers that were already in flight', async () => {
    const result = await runConcurrently([0, 1, 2, 3], 3, async (item) => {
      await delay(10 + item * 5)
      if (item < 2) throw new Error(`fail ${item}`)
      return item
    })

    expect(result.errors.map((e) => e.index)).toEqual([0, 1])
    expect(result.errors.map((e) => (e.error as Error).message)).toEqual(['fail 0', 'fail 1'])
    expect(result.results).toEqual([undefined, undefined, 2, undefined])
    expect(result.started).toBe(3)
    expect(result.stopped).toBe(true)
  })

  it('treats a synchronous throw from the worker as a failure', async () => {
    const result = await runConcurrently([0, 1], 1, (item) => {
      if (item === 0) throw new Error('sync')
      return Promise.resolve(item)
    })

    expect(result.errors.map((e) => e.index)).toEqual([0])
    expect(result.started).toBe(1)
    expect(result.stopped).toBe(true)
  })

  it('checks shouldStop before starting each item', async () => {
    const started: number[] = []
    let stop = false

    const result = await runConcurrently(
      [0, 1, 2, 3, 4],
      1,
      async (item) => {
        started.push(item)
        if (item === 1) stop = true
        await delay(5)
        return item
      },
      { shouldStop: () => stop },
    )

    expect(started).toEqual([0, 1])
    expect(result.results).toEqual([0, 1, undefined, undefined, undefined])
    expect(result.errors).toEqual([])
    expect(result.started).toBe(2)
    expect(result.stopped).toBe(true)
  })

  it('starts nothing when shouldStop is already true', async () => {
    let calls = 0

    const result = await runConcurrently(
      [0, 1],
      2,
      async () => {
        calls++
      },
      { shouldStop: () => true },
    )

    expect(calls).toBe(0)
    expect(result).toEqual({ results: [undefined, undefined], errors: [], started: 0, stopped: true })
  })

  it('runs every item at once when concurrency exceeds the item count', async () => {
    let active = 0
    let maxActive = 0

    const result = await runConcurrently([1, 2, 3], 10, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await delay(20)
      active--
      return item
    })

    expect(maxActive).toBe(3)
    expect(result.results).toEqual([1, 2, 3])
    expect(result.stopped).toBe(false)
  })

  it('halts every lane when shouldStop throws and rejects after in-flight workers settle', async () => {
    const started: number[] = []
    const finished: number[] = []
    let threw = false
    let startedAfterThrow = false
    let checks = 0
    const stopError = new Error('shouldStop failed')

    const run = runConcurrently(
      [0, 1, 2, 3, 4],
      2,
      async (item) => {
        if (threw) startedAfterThrow = true
        started.push(item)
        // Item 0 finishes first, so the next check (the third) runs while item 1 is in flight.
        await delay(item === 0 ? 5 : 60)
        finished.push(item)
        return item
      },
      {
        shouldStop: () => {
          checks++
          if (checks === 3) {
            threw = true
            throw stopError
          }
          return false
        },
      },
    )

    await expect(run).rejects.toBe(stopError)
    expect(startedAfterThrow).toBe(false)
    expect(started).toEqual([0, 1])
    // The rejection only arrived after the slow in-flight worker finished.
    expect(finished).toEqual([0, 1])
  })

  it('rejects with RangeError for concurrency < 1', async () => {
    const worker = async () => undefined
    await expect(runConcurrently([1], 0, worker)).rejects.toThrow(RangeError)
    await expect(runConcurrently([1], -1, worker)).rejects.toThrow(RangeError)
    await expect(runConcurrently([], Number.NaN, worker)).rejects.toThrow(RangeError)
  })
})
