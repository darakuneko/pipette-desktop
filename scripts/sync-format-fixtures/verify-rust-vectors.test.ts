// SPDX-License-Identifier: GPL-2.0-or-later
// Rust → TypeScript check for src-tauri/crates/pipette-sync-format: opens
// the envelopes the crate's tests write (`cargo test -p pipette-sync-format`)
// with the real `decrypt` (sync-crypto.ts), checks that a wrong password and
// another sync unit do not open them, and, for the pinned case, that the
// real `encrypt` given the same salt, IV and clock writes the identical JSON.
//
// Run: pnpm run verify:sync-format-rust-vectors

import { describe, it, expect, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RUST_ENVELOPES_DIR } from './paths'

const pinned = vi.hoisted(() => ({ randomQueue: [] as Buffer[] }))

// Same pinning as the generator: queued buffers first, then real randomness.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const randomBytes = (size: number): Buffer => {
    const next = pinned.randomQueue.shift()
    if (next === undefined) return actual.randomBytes(size)
    if (next.length !== size) throw new Error(`queued ${next.length} random bytes, ${size} requested`)
    return next
  }
  return { ...actual, default: { ...actual, randomBytes }, randomBytes }
})

import { encrypt, decrypt } from '../../src/main/sync/sync-crypto'
import type { SyncEnvelope } from '../../src/shared/types/sync'

interface RustCase {
  name: string
  password: string
  plaintext: string
  /** The envelope as the exact text the Rust crate serializes. */
  json: string
  pinned: { saltHex: string; ivHex: string; updatedAt: string } | null
}

/** The cases `tests/rust_envelopes.rs` writes. */
const EXPECTED_CASES = [
  'empty-plaintext-empty-password',
  'favorite-ascii',
  'password-check',
  'pinned-salt-iv-and-clock',
  'snapshot-unicode',
  'typing-day-jsonl',
]

function envelopeOf(c: RustCase): SyncEnvelope {
  return JSON.parse(c.json) as SyncEnvelope
}

function loadCases(): RustCase[] {
  if (!existsSync(RUST_ENVELOPES_DIR)) {
    throw new Error(`${RUST_ENVELOPES_DIR} is missing; run cargo test -p pipette-sync-format first`)
  }
  return readdirSync(RUST_ENVELOPES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(RUST_ENVELOPES_DIR, file), 'utf-8')) as RustCase)
}

const AUTH_FAILURE = 'Unsupported state or unable to authenticate data'

describe('envelopes written by the Rust crate', () => {
  const cases = loadCases()

  it('has every case', () => {
    expect(cases.map((c) => c.name).sort()).toEqual(EXPECTED_CASES)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s opens with the real decrypt', async (_name, c) => {
    // Re-serializing gives the same text: serde's output is what
    // JSON.stringify writes (field order included).
    expect(JSON.stringify(envelopeOf(c))).toBe(c.json)
    expect(await decrypt(envelopeOf(c), c.password)).toBe(c.plaintext)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s rejects a wrong password', async (_name, c) => {
    await expect(decrypt(envelopeOf(c), `${c.password}!`)).rejects.toThrow(AUTH_FAILURE)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s rejects another sync unit', async (_name, c) => {
    const envelope = envelopeOf(c)
    const retargeted = { ...envelope, syncUnit: `${envelope.syncUnit}/other` }
    await expect(decrypt(retargeted, c.password)).rejects.toThrow(AUTH_FAILURE)
  })

  it('pinned case matches the real encrypt byte for byte', async () => {
    const c = cases.find((x) => x.pinned !== null)
    if (!c?.pinned) throw new Error('no pinned case')
    pinned.randomQueue.push(Buffer.from(c.pinned.saltHex, 'hex'), Buffer.from(c.pinned.ivHex, 'hex'))
    vi.setSystemTime(new Date(c.pinned.updatedAt))
    try {
      const ours = await encrypt(c.plaintext, c.password, envelopeOf(c).syncUnit)
      expect(JSON.stringify(ours)).toBe(c.json)
    } finally {
      vi.useRealTimers()
    }
  })
})
