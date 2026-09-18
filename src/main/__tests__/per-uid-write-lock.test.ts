// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi } from 'vitest'
import { withWriteLock, withWriteLocks } from '../per-uid-write-lock'

describe('withWriteLock', () => {
  it('serializes tasks for the same uid, running them in queue order', async () => {
    const order: number[] = []
    const first = withWriteLock('uid', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push(1)
    })
    const second = withWriteLock('uid', async () => {
      order.push(2)
    })
    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
  })

  it('a failed task does not stall the chain for the same uid', async () => {
    const first = withWriteLock('uid', async () => { throw new Error('boom') })
    const second = withWriteLock('uid', async () => 'ok')
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('ok')
  })
})

describe('withWriteLocks', () => {
  it('dedupes a repeated key so it is only locked once', async () => {
    const calls: string[] = []
    // Wrap withWriteLock's tracked chain state indirectly: run two
    // withWriteLocks calls sharing a duplicate key and confirm the task
    // still runs exactly once (a non-deduped repeat would deadlock,
    // since withWriteLock is not reentrant for the same key).
    await withWriteLocks(['a', 'a', 'a'], async () => {
      calls.push('task')
    })
    expect(calls).toEqual(['task'])
  })

  it('acquires shared keys in the same fixed order regardless of input order, so two overlapping callers never deadlock', async () => {
    const order: string[] = []

    // Both calls share keys 'a' and 'b', given in opposite input order. If
    // withWriteLocks trusted caller order instead of sorting internally,
    // callA could acquire 'b' then wait on 'a' while callB acquires 'a'
    // then waits on 'b' — a classic deadlock. Sorting both to the same
    // ['a','b'] order means callB simply queues behind callA on 'a'.
    const callA = withWriteLocks(['b', 'a'], async () => {
      order.push('A-start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('A-end')
    })
    const callB = withWriteLocks(['a', 'b'], async () => {
      order.push('B')
    })

    await expect(Promise.race([
      Promise.all([callA, callB]),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('deadlock')), 500)),
    ])).resolves.toBeDefined()
    // callB's task must not interleave with callA's — proof every shared
    // lock stayed held for callA's whole span, not released key-by-key.
    expect(order).toEqual(['A-start', 'A-end', 'B'])
  })

  it('holds every lock for the whole span of task, blocking a same-key withWriteLock until task settles', async () => {
    const order: string[] = []
    const locksHeld = withWriteLocks(['x', 'y'], async () => {
      order.push('multi-start')
      await new Promise((resolve) => setTimeout(resolve, 15))
      order.push('multi-end')
    })
    // Give withWriteLocks a tick to acquire its locks before racing a
    // single-key writer against 'x'.
    await new Promise((resolve) => setTimeout(resolve, 1))
    const single = withWriteLock('x', async () => {
      order.push('single')
    })
    await Promise.all([locksHeld, single])
    expect(order).toEqual(['multi-start', 'multi-end', 'single'])
  })

  it('runs the task immediately when keys is empty', async () => {
    const task = vi.fn(async () => 'done')
    const result = await withWriteLocks([], task)
    expect(result).toBe('done')
    expect(task).toHaveBeenCalledTimes(1)
  })
})
