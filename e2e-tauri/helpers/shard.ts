// SPDX-License-Identifier: GPL-2.0-or-later
//
// Splits the e2e specs into shards that CI runs as separate jobs
// (PIPETTE_E2E_SHARD=<index>/<total>, see wdio.conf.ts). Every spec lands in
// exactly one shard, so a spec added later runs without a list to update;
// the weights only balance the shards' run times.

/** About how many seconds a spec takes on CI. A spec missing here counts as
 *  {@link DEFAULT_WEIGHT}. */
const SPEC_WEIGHTS: Readonly<Record<string, number>> = {
  'sync.e2e.ts': 240,
  'analytics.e2e.ts': 120,
  'tray-start-unlock.e2e.ts': 50,
  'resident.e2e.ts': 35,
  'hub.e2e.ts': 30,
}

const DEFAULT_WEIGHT = 5

export interface Shard {
  /** 1-based. */
  index: number
  total: number
}

/** The shard of `value` (`<index>/<total>`, 1-based), or undefined for no
 *  value (every spec). Anything else throws, so a mistyped value never
 *  drops specs. */
export function parseShard(value: string | undefined): Shard | undefined {
  if (value === undefined || value === '') return undefined
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value)
  if (!match) throw new Error(`PIPETTE_E2E_SHARD must be <index>/<total>, not ${JSON.stringify(value)}`)
  const index = Number(match[1])
  const total = Number(match[2])
  if (index > total) throw new Error(`PIPETTE_E2E_SHARD ${value}: the index is above the total`)
  return { index, total }
}

function weightOf(spec: string): number {
  const name = spec.split(/[\\/]/).pop() ?? spec
  return SPEC_WEIGHTS[name] ?? DEFAULT_WEIGHT
}

/** The specs of `shard`, in the order of `specs`. Heaviest first, each spec
 *  goes to the shard with the least weight so far (the lowest index on a
 *  tie), so the split depends only on the list of specs. Throws when the
 *  shard gets no spec. */
export function shardSpecs(specs: readonly string[], shard: Shard): string[] {
  const byWeight = [...specs].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0))
  const loads = new Array<number>(shard.total).fill(0)
  const assigned = new Map<string, number>()
  for (const spec of byWeight) {
    let target = 0
    for (let i = 1; i < loads.length; i++) if (loads[i] < loads[target]) target = i
    loads[target] += weightOf(spec)
    assigned.set(spec, target + 1)
  }
  const mine = specs.filter((spec) => assigned.get(spec) === shard.index)
  if (mine.length === 0) throw new Error(`shard ${shard.index}/${shard.total} has no spec`)
  return mine
}
