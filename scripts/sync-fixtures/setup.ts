// SPDX-License-Identifier: GPL-2.0-or-later
// Installs the sync fixture harness (harness.ts) before every test file:
// the guarded `fetch`, the fixed clock and randomness, and a fresh state
// before and after each test.

import { afterEach, beforeEach, vi } from 'vitest'
import { FIXED_NOW, fixedRandom, fixedRandomBytes, fixedUuid, guardedFetch, resetHarness } from './harness'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const overrides = { randomUUID: fixedUuid, randomBytes: fixedRandomBytes }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

const realFetch = globalThis.fetch
globalThis.fetch = guardedFetch(realFetch)

beforeEach(() => {
  resetHarness()
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] })
  vi.spyOn(Math, 'random').mockImplementation(fixedRandom)
})

afterEach(() => {
  vi.useRealTimers()
  resetHarness()
})
