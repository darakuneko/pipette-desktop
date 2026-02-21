// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { pLimit } from '../concurrency'

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
