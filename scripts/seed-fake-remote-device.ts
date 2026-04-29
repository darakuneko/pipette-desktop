// SPDX-License-Identifier: GPL-2.0-or-later
// Seed a fake remote-device's analytics data for the Analyze tab's
// multi-device Device-diff overlay. Generates a synthetic
// `machine_hash` distinct from your own and writes JSONL master files
// under that hash for the chosen keyboard uid, then clears the
// SQLite cache + sync_state so the main process rebuilds from the
// fresh JSONL on next launch.
//
// Usage:
//   1. Quit the Pipette desktop app.
//   2. `npx tsx scripts/seed-fake-remote-device.ts <keyboardUid> [--days N]`
//   3. Restart the app and open Analyze.
//
// The fake hash is derived from a fixed prefix + a random suffix on
// each run, so successive runs add a *new* fake device rather than
// rewriting the same one. Delete the resulting
// `sync/keyboards/<uid>/devices/<fakeHash>/` directory + cache to
// remove a fake device.

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

const USER_DATA_PATH = join(homedir(), '.config', 'pipette-desktop')
const FAKE_HASH_PREFIX = 'fakedemo' // distinct from real 64-char hex hashes
const DEFAULT_DAYS = 7
const MINUTES_PER_DAY = 60
const KEYS_PER_BURST = 6
const ROWS = 5
const COLS = 14
const FAKE_VENDOR_ID = 0x4153
const FAKE_PRODUCT_ID = 0x4d47
const FAKE_PRODUCT_NAME = 'Fake Remote Device'

interface SeedArgs {
  uid: string
  days: number
}

function parseArgs(argv: readonly string[]): SeedArgs {
  let uid: string | null = null
  let days = DEFAULT_DAYS
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--days') {
      const next = argv[i + 1]
      const parsed = next === undefined ? Number.NaN : Number.parseInt(next, 10)
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`--days must be a positive integer (got ${next})`)
      }
      days = parsed
      i += 1
      continue
    }
    if (uid === null) {
      uid = arg
    }
  }
  if (uid === null) {
    throw new Error(
      'Missing keyboardUid argument.\nUsage: npx tsx scripts/seed-fake-remote-device.ts <keyboardUid> [--days N]',
    )
  }
  return { uid, days }
}

function generateFakeMachineHash(): string {
  // 56 hex chars after the 8-char prefix gives us 64-char total to
  // line up with real sha256-shaped hashes elsewhere in the codebase.
  return FAKE_HASH_PREFIX + randomBytes(28).toString('hex')
}

function toUtcDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear().toString().padStart(4, '0')
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildScopeId(machineHash: string, keyboardUid: string): string {
  // Format mirrors the live `canonicalScopeKey` output that the main
  // process writes — keeping the format identical means the cache
  // rebuild treats the seeded scope just like a real one.
  return `${machineHash}|linux|6.8.0-fake|${keyboardUid}|${FAKE_VENDOR_ID}|${FAKE_PRODUCT_ID}`
}

interface JsonlRow {
  id: string
  kind: string
  updated_at: number
  payload: Record<string, unknown>
}

function buildScopeRow(scopeId: string, machineHash: string, keyboardUid: string, nowMs: number): JsonlRow {
  return {
    id: `scope|${encodeURIComponent(scopeId)}`,
    kind: 'scope',
    updated_at: nowMs,
    payload: {
      id: scopeId,
      machineHash,
      osPlatform: 'linux',
      osRelease: '6.8.0-fake',
      osArch: 'x64',
      keyboardUid,
      keyboardVendorId: FAKE_VENDOR_ID,
      keyboardProductId: FAKE_PRODUCT_ID,
      keyboardProductName: FAKE_PRODUCT_NAME,
    },
  }
}

function buildMinuteStatsRow(scopeId: string, minuteTs: number, nowMs: number): JsonlRow {
  // Spread the keystroke counts a bit over time so the chart shape
  // doesn't read as "exactly the same flat line on every minute".
  const seed = (minuteTs / 60_000) % 17
  const keystrokes = 40 + Math.round(seed * 4)
  const activeMs = 35_000 + Math.round((seed % 5) * 2_000)
  return {
    id: `stats|${encodeURIComponent(scopeId)}|${minuteTs}`,
    kind: 'minute-stats',
    updated_at: nowMs,
    payload: {
      scopeId,
      minuteTs,
      keystrokes,
      activeMs,
      intervalAvgMs: 120 + Math.round((seed % 7) * 5),
      intervalMinMs: 30,
      intervalP25Ms: 80 + Math.round((seed % 4) * 4),
      intervalP50Ms: 130 + Math.round((seed % 6) * 6),
      intervalP75Ms: 220 + Math.round((seed % 5) * 8),
      intervalMaxMs: 480 + Math.round((seed % 3) * 12),
    },
  }
}

function buildMatrixMinuteRows(scopeId: string, minuteTs: number, nowMs: number): JsonlRow[] {
  const rows: JsonlRow[] = []
  // Spread presses across the home-row so Heatmap / Ergonomics show
  // recognisable shapes when the user picks the fake device.
  for (let col = 0; col < KEYS_PER_BURST; col += 1) {
    rows.push({
      id: `matrix|${encodeURIComponent(scopeId)}|${minuteTs}|2|${col}|0`,
      kind: 'matrix-minute',
      updated_at: nowMs,
      payload: {
        scopeId,
        minuteTs,
        row: 2,
        col,
        layer: 0,
        // KC_A starts at 0x04, so offsetting by `col` walks A..F across
        // the row — recognisable when it lights up the heatmap.
        keycode: 4 + col,
        count: 6 + (col % 3),
        tapCount: 6 + (col % 3),
        holdCount: 0,
      },
    })
  }
  return rows
}

function buildSessionRow(scopeId: string, dayStartMs: number, nowMs: number): JsonlRow {
  return {
    id: `session|${encodeURIComponent(scopeId)}|${dayStartMs}`,
    kind: 'session',
    updated_at: nowMs,
    payload: {
      id: `${scopeId}|${dayStartMs}`,
      scopeId,
      startMs: dayStartMs,
      // A single 60-minute session per day keeps the Activity grid /
      // Sessions histogram populated without flooding the JSONL.
      endMs: dayStartMs + MINUTES_PER_DAY * 60_000,
    },
  }
}

function ensureUidExists(uid: string): void {
  // Sanity check the uid actually has a sync directory — typing the
  // hex wrong would otherwise silently seed a hash for a phantom
  // keyboard the user can't see in the sidebar.
  const keyboardDir = join(USER_DATA_PATH, 'sync', 'keyboards', uid)
  if (!existsSync(keyboardDir)) {
    throw new Error(
      `Keyboard uid "${uid}" not found under ${join(USER_DATA_PATH, 'sync', 'keyboards')}.\n` +
        'Connect the keyboard at least once so the userData directory is initialised first.',
    )
  }
}

function clearCacheArtifacts(): void {
  const syncStatePath = join(USER_DATA_PATH, 'local', 'typing-analytics', 'sync_state.json')
  const dbPath = join(USER_DATA_PATH, 'local', 'typing-analytics.db')
  for (const path of [syncStatePath, dbPath]) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone — `ensureCacheIsFresh` will rebuild on next launch
      // either way.
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  ensureUidExists(args.uid)

  const machineHash = generateFakeMachineHash()
  const scopeId = buildScopeId(machineHash, args.uid)
  const nowMs = Date.now()

  const deviceDir = join(USER_DATA_PATH, 'sync', 'keyboards', args.uid, 'devices', machineHash)
  mkdirSync(deviceDir, { recursive: true })

  // Group rows per UTC day so the JSONL master path matches the
  // production layout (one file per scope per UTC date).
  const rowsByDay = new Map<string, JsonlRow[]>()
  const seenDays = new Set<string>()

  for (let dayBack = 0; dayBack < args.days; dayBack += 1) {
    const dayStartMs = nowMs - dayBack * 24 * 60 * 60_000
    const dateKey = toUtcDate(dayStartMs)
    const entries: JsonlRow[] = rowsByDay.get(dateKey) ?? []
    if (!seenDays.has(dateKey)) {
      // Each JSONL must self-describe the scope and hold at least one
      // session so the rebuilder can register the device cleanly.
      entries.push(buildScopeRow(scopeId, machineHash, args.uid, nowMs))
      entries.push(buildSessionRow(scopeId, dayStartMs - (dayStartMs % (24 * 60 * 60_000)), nowMs))
      seenDays.add(dateKey)
    }
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
      const minuteTs = Math.floor((dayStartMs - minute * 60_000) / 60_000) * 60_000
      entries.push(buildMinuteStatsRow(scopeId, minuteTs, nowMs))
      entries.push(...buildMatrixMinuteRows(scopeId, minuteTs, nowMs))
    }
    rowsByDay.set(dateKey, entries)
  }

  for (const [date, rows] of rowsByDay) {
    const jsonlPath = join(deviceDir, `${date}.jsonl`)
    const content = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
    writeFileSync(jsonlPath, content, 'utf-8')
  }

  clearCacheArtifacts()

  const totalMinutes = Array.from(rowsByDay.values()).reduce(
    (acc, rows) => acc + rows.filter((r) => r.kind === 'minute-stats').length,
    0,
  )
  console.log(`Seeded fake remote device for keyboard ${args.uid}`)
  console.log(`  machineHash : ${machineHash}`)
  console.log(`  device dir  : ${deviceDir}`)
  console.log(`  days        : ${args.days}`)
  console.log(`  minutes     : ${totalMinutes}`)
  console.log(`  files       : ${rowsByDay.size}`)
  console.log('')
  console.log('Cache + sync_state cleared. Restart Pipette to let ensureCacheIsFresh rebuild.')
  console.log('')
  console.log('To remove this fake device later:')
  console.log(`  rm -rf "${deviceDir}"`)
  console.log(`  rm -f "${join(USER_DATA_PATH, 'local', 'typing-analytics', 'sync_state.json')}"`)
  console.log(`  rm -f "${join(USER_DATA_PATH, 'local', 'typing-analytics.db')}"`)
}

main()
