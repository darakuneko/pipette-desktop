// SPDX-License-Identifier: GPL-2.0-or-later
// The e2e shards CI runs as separate jobs: together they hold every spec
// once, the heavy specs are spread, and a malformed shard value throws
// instead of running fewer specs.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseShard, shardSpecs } from '../shard'

const SPECS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../specs')
const SPECS = readdirSync(SPECS_DIR)
  .filter((name) => name.endsWith('.e2e.ts'))
  .sort()

describe('parseShard', () => {
  it('reads <index>/<total>', () => {
    expect(parseShard('1/2')).toEqual({ index: 1, total: 2 })
    expect(parseShard('2/2')).toEqual({ index: 2, total: 2 })
  })

  it('means every spec without a value', () => {
    expect(parseShard(undefined)).toBeUndefined()
    expect(parseShard('')).toBeUndefined()
  })

  it.each(['0/2', '3/2', '1', '1/0', 'a/b', '1/2/3', ' 1/2'])('rejects %j', (value) => {
    expect(() => parseShard(value)).toThrow()
  })
})

describe('shardSpecs', () => {
  it.each([1, 2, 3])('puts every spec in exactly one of %i shards', (total) => {
    const all = Array.from({ length: total }, (_, i) => shardSpecs(SPECS, { index: i + 1, total })).flat()
    expect([...all].sort()).toEqual(SPECS)
  })

  it('keeps the order of the list', () => {
    for (const index of [1, 2]) {
      const mine = shardSpecs(SPECS, { index, total: 2 })
      expect(mine).toEqual([...mine].sort())
    }
  })

  it('spreads the heavy specs over two shards', () => {
    const first = shardSpecs(SPECS, { index: 1, total: 2 })
    const second = shardSpecs(SPECS, { index: 2, total: 2 })
    expect(first).toContain('sync.e2e.ts')
    expect(second).toEqual(expect.arrayContaining(['analytics.e2e.ts', 'hub.e2e.ts', 'resident.e2e.ts', 'tray-start-unlock.e2e.ts']))
  })

  it('weighs specs by name in any directory', () => {
    const paths = SPECS.map((name) => join(SPECS_DIR, name))
    expect(shardSpecs(paths, { index: 1, total: 2 })).toContain(join(SPECS_DIR, 'sync.e2e.ts'))
  })

  it('throws for a shard with no spec', () => {
    expect(() => shardSpecs(['a.e2e.ts'], { index: 2, total: 2 })).toThrow()
  })
})
