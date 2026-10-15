// SPDX-License-Identifier: GPL-2.0-or-later
// enqueue() runs the tasks of one key one at a time in the order they were
// queued, whatever order they would finish in, lets a failed task release
// the key, and leaves other keys free.

import { describe, expect, it } from 'vitest'
import { enqueue } from '../key-queue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('enqueue', () => {
  it('starts a task only after the one before it with the same key has finished', async () => {
    const log: string[] = []
    const first = deferred()
    const a = enqueue('k', async () => {
      log.push('a start')
      await first.promise
      log.push('a end')
      return 'a'
    })
    const b = enqueue('k', async () => {
      log.push('b')
      return 'b'
    })
    await settle()
    expect(log).toEqual(['a start'])
    first.resolve()
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b'])
    expect(log).toEqual(['a start', 'a end', 'b'])
  })

  it('runs the next task after a failed one and keeps the failure for its caller', async () => {
    const failed = enqueue('k', () => Promise.reject(new Error('boom')))
    const next = enqueue('k', () => Promise.resolve('next'))
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('next')
  })

  it('does not hold up other keys', async () => {
    const held = deferred()
    const blocked = enqueue('a', () => held.promise)
    await expect(enqueue('b', () => Promise.resolve('free'))).resolves.toBe('free')
    held.resolve()
    await blocked
  })
})
