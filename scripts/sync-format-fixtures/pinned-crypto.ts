// SPDX-License-Identifier: GPL-2.0-or-later
// The `node:crypto` the generator and the verifier in this directory mock
// in, built around the real module:
//
// - `randomBytes` hands out the queued buffers first, so `encrypt` uses the
//   salt and IV a vector names; with the queue empty it is the real one.
// - `pbkdf2` remembers each derived key, so decrypting again with the same
//   password and salt does not repeat the 600,000 iterations. The key is
//   still the real `pbkdf2` output.
//
// Only types come from `node:crypto` here: the module is loaded from inside
// the `vi.mock('node:crypto')` factory.

import type * as NodeCrypto from 'node:crypto'

type Pbkdf2Callback = (err: Error | null, derivedKey: Buffer) => void

function hexOf(value: NodeCrypto.BinaryLike): string {
  const bytes = typeof value === 'string'
    ? Buffer.from(value, 'utf-8')
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return bytes.toString('hex')
}

export function pinnedCrypto(actual: typeof NodeCrypto, randomQueue: Buffer[]): typeof NodeCrypto {
  const randomBytes = (size: number): Buffer => {
    const next = randomQueue.shift()
    if (next === undefined) return actual.randomBytes(size)
    if (next.length !== size) throw new Error(`queued ${next.length} random bytes, ${size} requested`)
    return next
  }

  const keys = new Map<string, Buffer>()
  const pbkdf2 = (
    password: NodeCrypto.BinaryLike,
    salt: NodeCrypto.BinaryLike,
    iterations: number,
    keylen: number,
    digest: string,
    callback: Pbkdf2Callback,
  ): void => {
    const id = [iterations, keylen, digest, hexOf(password), hexOf(salt)].join(':')
    const known = keys.get(id)
    if (known) {
      callback(null, Buffer.from(known))
      return
    }
    actual.pbkdf2(password, salt, iterations, keylen, digest, (err, key) => {
      if (!err) keys.set(id, Buffer.from(key))
      callback(err, key)
    })
  }

  const overrides = { randomBytes, pbkdf2 } as unknown as Partial<typeof NodeCrypto>
  return { ...actual, ...overrides, default: { ...actual, ...overrides } } as typeof NodeCrypto
}
