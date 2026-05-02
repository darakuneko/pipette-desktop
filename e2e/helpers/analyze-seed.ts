// SPDX-License-Identifier: GPL-2.0-or-later

// Shared seed/restore helpers for the Analyze page. Used by both the
// screenshot-capture workflow (doc-capture.ts) and the Analyze e2e tests.
//
// Strategy: write JSONL / JSON master files under the Playwright-managed
// userData directory, then let Electron's `ensureCacheIsFresh` rebuild the
// SQLite cache on next launch. Cleanup deletes the cache + sync_state so
// the next launch starts from empty — restoring them would race against
// the Electron process's own shutdown writes.
//
// See `.claude/docs/TESTING-POLICY.md` §7 for the full rationale.

import { mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import nodeMachineId from 'node-machine-id'

// --- Dummy snapshot data (File tab keyboards list) ---

export const DUMMY_SNAPSHOTS = [
  {
    uid: 'doc-dummy-uid-1',
    name: 'Corne',
    entries: [
      { id: 'doc-snap-1', label: 'Default', filename: 'Corne_2026-03-10T12-00-00.pipette', savedAt: '2026-03-10T12:00:00.000Z', updatedAt: '2026-03-15T09:30:00.000Z', vilVersion: 2 },
      { id: 'doc-snap-2', label: 'Gaming', filename: 'Corne_2026-03-12T14-30-00.pipette', savedAt: '2026-03-12T14:30:00.000Z', vilVersion: 2 },
    ],
  },
  {
    uid: 'doc-dummy-uid-2',
    name: 'Sofle',
    entries: [
      { id: 'doc-snap-3', label: 'Work', filename: 'Sofle_2026-03-08T09-00-00.pipette', savedAt: '2026-03-08T09:00:00.000Z', vilVersion: 2 },
    ],
  },
]

export function seedDummySnapshots(snapshotBase: string): Map<string, string | null> {
  const backups = new Map<string, string | null>()
  for (const kb of DUMMY_SNAPSHOTS) {
    const dir = join(snapshotBase, kb.uid, 'snapshots')
    mkdirSync(dir, { recursive: true })
    const indexPath = join(dir, 'index.json')
    backups.set(indexPath, existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null)
    writeFileSync(indexPath, JSON.stringify({ uid: kb.uid, entries: kb.entries }, null, 2), 'utf-8')
  }
  return backups
}

export function restoreSnapshots(backups: Map<string, string | null>): void {
  for (const [path, original] of backups) {
    if (original != null) {
      writeFileSync(path, original, 'utf-8')
    } else {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  }
}

// --- Dummy typing-analytics data (Analyze page) ---

export const DUMMY_TA_UID = 'doc-ta-keyboard-1'
const DUMMY_TA_SCOPE_ID = 'doc-ta-scope-1'
const DUMMY_TA_SESSION_ID = 'doc-ta-session-1'
const DUMMY_TA_PRODUCT_NAME = 'GPK60-63R (docs)'
export const DUMMY_TA_LAYERS = 3
const DUMMY_TA_ROWS = 5
const DUMMY_TA_COLS = 14

// Layer-op keys on layer 0 so the Activations view has more than one target layer.
const DUMMY_TA_LAYER_OPS: Record<string, string> = {
  '0,0,0': 'MO(1)',
  '0,0,1': 'LT1(KC_ESC)',
  '0,0,2': 'TG(2)',
  '0,0,3': 'TO(1)',
  '0,0,4': 'OSL(2)',
}

// Alpha row aligned with the matrix-minute seed (keycode = 4 + col on
// layer 0 row 1, left half) plus right-hand alphas at cols 9-11 so the
// Bigrams Finger IKI view shows both blue (left-start) and red
// (right-start) bars instead of a single-hand silhouette.
const DUMMY_TA_ALPHA_ROW: Record<string, string> = {
  '0,1,0': 'KC_A',
  '0,1,1': 'KC_B',
  '0,1,2': 'KC_C',
  '0,1,3': 'KC_D',
  '0,1,4': 'KC_E',
  '0,1,5': 'KC_F',
  '0,1,9': 'KC_J',
  '0,1,10': 'KC_K',
  '0,1,11': 'KC_L',
}

export interface TypingAnalyticsSeedBackup {
  jsonlPath: string
  /** Per-day jsonl masters seeded for the Ergonomic Learning Curve so the
   * `analyze-ergonomics-learning` screenshot has multiple weekly buckets to
   * draw a trend through. Each file holds rows for its own UTC day. */
  historicalJsonlPaths: string[]
  snapshotPath: string
  /** Older snapshot used by the Learning Curve capture. Selecting this
   * snapshot in the Analyze timeline expands the range to
   * `[olderSavedAt, latestSavedAt)`, which is what brings the historical
   * matrix-minute rows above into scope. */
  olderSnapshotPath: string
  syncStatePath: string
  dbPath: string
}

// --- Historical seed for the Ergonomic Learning Curve view ---
//
// The base seed only covers the last 4 hours of "today", so the learning
// curve always falls into its empty state. Layering 7 weeks of sparse
// matrix-minute history onto the same scope gives the Learning Curve
// 7 weekly buckets with a deliberate upward trend (more home-row stay
// and fewer index-finger collisions over time). The history is gated to
// the older snapshot's active window so it only appears when the user
// (or doc-capture) explicitly selects that snapshot — the default
// "Current keymap" range stays at -4h..now and the other Analyze
// screenshots see the same data they always have.

const HISTORICAL_WEEKS = 7
const HISTORICAL_DAY_OFFSETS_PER_WEEK = [0, 2, 4] as const // Mon-ish / Wed-ish / Fri-ish
const HISTORICAL_KEYSTROKES_PER_DAY = 500
// Cols 3..10 cover both hands and all 8 non-thumb fingers symmetrically
// (left pinky/ring/middle/index + right index/middle/ring/pinky), so the
// hand-balance and finger-load scores are well-defined per bucket.
const HISTORICAL_COLS = [3, 4, 5, 6, 7, 8, 9, 10] as const

function lerp(weekIdx: number, fromVal: number, toVal: number): number {
  if (HISTORICAL_WEEKS <= 1) return toVal
  return fromVal + ((toVal - fromVal) * weekIdx) / (HISTORICAL_WEEKS - 1)
}

function historicalHomeFraction(weekIdx: number): number {
  // 0.30 (oldest, top-row dominant) → 0.65 (newest, home-row dominant)
  return lerp(weekIdx, 0.3, 0.65)
}

function historicalColWeights(weekIdx: number): number[] {
  // Index columns (6 = left index, 7 = right index) carry extra weight at
  // week 0 and equal weight at week 6. Drives a finger-load deviation
  // improvement from "index-overloaded" to "evenly spread".
  const indexBoost = lerp(weekIdx, 2, 0)
  return HISTORICAL_COLS.map((col) => 1 + (col === 6 || col === 7 ? indexBoost : 0))
}

interface HistoricalCellRow {
  matrixRow: number
  col: number
  count: number
}

function distributeHistoricalCells(weekIdx: number): HistoricalCellRow[] {
  const homeTotal = Math.round(HISTORICAL_KEYSTROKES_PER_DAY * historicalHomeFraction(weekIdx))
  const topTotal = HISTORICAL_KEYSTROKES_PER_DAY - homeTotal
  const weights = historicalColWeights(weekIdx)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const out: HistoricalCellRow[] = []
  HISTORICAL_COLS.forEach((col, i) => {
    const share = weights[i] / totalWeight
    for (const [matrixRow, total] of [[2, homeTotal], [1, topTotal]] as const) {
      const count = Math.round(total * share)
      if (count > 0) out.push({ matrixRow, col, count })
    }
  })
  return out
}

function buildScopeRow(machineHash: string, nowMs: number): Record<string, unknown> {
  return {
    id: `scope|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}`,
    kind: 'scope',
    updated_at: nowMs,
    payload: {
      id: DUMMY_TA_SCOPE_ID,
      machineHash,
      osPlatform: 'linux',
      osRelease: '6.8.0-docs',
      osArch: 'x64',
      keyboardUid: DUMMY_TA_UID,
      keyboardVendorId: 0x4153,
      keyboardProductId: 0x4d47,
      keyboardProductName: DUMMY_TA_PRODUCT_NAME,
    },
  }
}

const NOON_OFFSET_MS = 12 * 3_600_000

function buildHistoricalDayJsonlContent(machineHash: string, dayMs: number, weekIdx: number, nowMs: number): string {
  // Match the FK-resolution dance in apply-to-cache: each historical
  // day file ships its own scope row at the top so the matrix-minute
  // rows below resolve their FK target even when this file is the
  // first one ingested in the rebuild order.
  const minuteTs = Math.floor((dayMs + NOON_OFFSET_MS) / 60_000) * 60_000
  const matrixRows = distributeHistoricalCells(weekIdx).map((cell) => ({
    id: `matrix|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}|${cell.matrixRow}|${cell.col}|0`,
    kind: 'matrix-minute',
    updated_at: nowMs,
    payload: {
      scopeId: DUMMY_TA_SCOPE_ID,
      minuteTs,
      row: cell.matrixRow,
      col: cell.col,
      layer: 0,
      keycode: 4 + cell.col,
      count: cell.count,
      tapCount: cell.count,
      holdCount: 0,
      appName: 'Code',
    },
  }))
  return [buildScopeRow(machineHash, nowMs), ...matrixRows]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n'
}

function readMachineHashFromSyncState(syncStatePath: string): string | null {
  if (!existsSync(syncStatePath)) return null
  try {
    const raw = readFileSync(syncStatePath, 'utf-8')
    const parsed = JSON.parse(raw) as { my_device_id?: unknown }
    return typeof parsed.my_device_id === 'string' ? parsed.my_device_id : null
  } catch {
    return null
  }
}

// Mirrors the algorithm in src/main/typing-analytics/machine-hash.ts so
// the seed lands in the same `own` device scope the main process computes
// on app launch — even when a prior run's restore pass deleted sync_state.
async function computeMachineHash(userDataPath: string): Promise<string> {
  const installationIdPath = join(userDataPath, 'local', 'installation-id')
  const installationId = readFileSync(installationIdPath, 'utf-8').trim()
  const rawMachineId = await nodeMachineId.machineId(true)
  return createHash('sha256').update(rawMachineId).update(installationId).digest('hex')
}

function buildDummyKeymap(): string[][][] {
  const keymap: string[][][] = []
  for (let layer = 0; layer < DUMMY_TA_LAYERS; layer += 1) {
    const layerRows: string[][] = []
    for (let row = 0; row < DUMMY_TA_ROWS; row += 1) {
      const cols: string[] = []
      for (let col = 0; col < DUMMY_TA_COLS; col += 1) {
        const key = `${layer},${row},${col}`
        const override = DUMMY_TA_LAYER_OPS[key] ?? DUMMY_TA_ALPHA_ROW[key]
        cols.push(override ?? 'KC_A')
      }
      layerRows.push(cols)
    }
    keymap.push(layerRows)
  }
  return keymap
}

// Minute-sized slices over the last 4 hours give WPM / Interval / Activity some shape.
function dummyMinuteOffsets(): number[] {
  return [240, 180, 120, 60, 30, 15, 10, 5, 3, 1]
}

// Representative bigram pairs for the Bigrams tab. Histogram bucket
// boundaries (ms): [60, 100, 150, 200, 300, 500, 1000, Inf]. Each entry
// is replayed every minute so the Top quadrant shows count-leaders, the
// Slow quadrant ranks high-IKI pairs, and Finger / Pair quadrants show
// a varied avgIki distribution. Keycodes 4-9 are KC_A-KC_F; the alpha
// row in the dummy keymap pins them to layer-0 row 1 columns 0-5 so
// `buildKeycodeFingerMap` can resolve them to distinct fingers.
const DUMMY_TA_BIGRAM_PER_MINUTE: ReadonlyArray<{
  prev: number
  curr: number
  c: number
  hist: readonly number[]
}> = [
  // Frequent fast pairs — drive the Top ranking.
  { prev: 4, curr: 4, c: 10, hist: [3, 5, 2, 0, 0, 0, 0, 0] },
  { prev: 4, curr: 5, c: 8, hist: [2, 4, 2, 0, 0, 0, 0, 0] },
  { prev: 5, curr: 6, c: 6, hist: [1, 3, 2, 0, 0, 0, 0, 0] },
  { prev: 6, curr: 7, c: 5, hist: [0, 1, 2, 2, 0, 0, 0, 0] },
  { prev: 6, curr: 5, c: 5, hist: [1, 1, 1, 1, 1, 0, 0, 0] },
  { prev: 7, curr: 8, c: 4, hist: [0, 0, 2, 2, 0, 0, 0, 0] },
  { prev: 7, curr: 4, c: 4, hist: [1, 2, 1, 0, 0, 0, 0, 0] },
  { prev: 8, curr: 9, c: 3, hist: [0, 0, 0, 1, 2, 0, 0, 0] },
  { prev: 8, curr: 5, c: 3, hist: [0, 1, 1, 1, 0, 0, 0, 0] },
  { prev: 4, curr: 6, c: 3, hist: [1, 2, 0, 0, 0, 0, 0, 0] },
  // Mid-IKI pairs — fill the Pair heatmap mid-range.
  { prev: 9, curr: 4, c: 2, hist: [0, 0, 0, 0, 0, 1, 1, 0] },
  { prev: 9, curr: 6, c: 2, hist: [0, 0, 0, 0, 1, 1, 0, 0] },
  { prev: 5, curr: 7, c: 2, hist: [0, 0, 1, 1, 0, 0, 0, 0] },
  { prev: 6, curr: 8, c: 2, hist: [0, 0, 0, 0, 0, 1, 1, 0] },
  { prev: 8, curr: 6, c: 2, hist: [0, 0, 0, 0, 1, 1, 0, 0] },
  { prev: 9, curr: 7, c: 2, hist: [0, 0, 0, 0, 0, 1, 1, 0] },
  // Rare slow pairs — anchor the Slow ranking head.
  { prev: 4, curr: 9, c: 1, hist: [0, 0, 0, 0, 0, 0, 1, 0] },
  { prev: 5, curr: 8, c: 1, hist: [0, 0, 0, 0, 0, 0, 0, 1] },
  { prev: 7, curr: 9, c: 1, hist: [0, 0, 0, 1, 0, 0, 0, 0] },
  { prev: 4, curr: 7, c: 1, hist: [1, 0, 0, 0, 0, 0, 0, 0] },
  { prev: 5, curr: 9, c: 1, hist: [0, 0, 0, 0, 0, 0, 0, 1] },
  { prev: 9, curr: 5, c: 1, hist: [0, 0, 0, 0, 0, 0, 0, 1] },
  // Right-hand-start pairs (KC_J=13, KC_K=14, KC_L=15) so the Finger
  // IKI heatmap shows red bars alongside the blue ones.
  { prev: 13, curr: 4, c: 6, hist: [1, 3, 2, 0, 0, 0, 0, 0] },
  { prev: 14, curr: 5, c: 4, hist: [0, 1, 2, 1, 0, 0, 0, 0] },
  { prev: 15, curr: 6, c: 3, hist: [0, 0, 1, 1, 1, 0, 0, 0] },
  { prev: 13, curr: 14, c: 5, hist: [1, 2, 2, 0, 0, 0, 0, 0] },
  { prev: 14, curr: 15, c: 4, hist: [0, 1, 2, 1, 0, 0, 0, 0] },
  { prev: 15, curr: 13, c: 2, hist: [0, 0, 0, 0, 1, 1, 0, 0] },
]

function buildDummyJsonlContent(machineHash: string, nowMs: number): string {
  const scopeRow = buildScopeRow(machineHash, nowMs)
  const sessionRow = {
    id: `session|${encodeURIComponent(DUMMY_TA_SESSION_ID)}`,
    kind: 'session',
    updated_at: nowMs,
    payload: {
      id: DUMMY_TA_SESSION_ID,
      scopeId: DUMMY_TA_SCOPE_ID,
      startMs: nowMs - 4 * 3_600_000,
      endMs: nowMs - 60_000,
    },
  }

  // Round-robin app tag across the dummy minutes so the App Usage
  // pie has multiple slices and WPM-by-App has multiple bars. The
  // 4-cycle includes a `null` so docs / e2e also exercise the
  // "mixed/unknown" bucket without a separate seed pass.
  const APP_CYCLE: (string | null)[] = ['Code', 'Slack', 'Chrome', null]

  const matrixRows: unknown[] = []
  const statsRows: unknown[] = []
  const bigramRows: unknown[] = []
  const minuteBase = Math.floor((nowMs - 60_000) / 60_000) * 60_000
  for (const offset of dummyMinuteOffsets()) {
    const minuteTs = minuteBase - offset * 60_000
    const appName = APP_CYCLE[offset % APP_CYCLE.length] ?? null

    const bigrams: Record<string, { c: number; h: readonly number[] }> = {}
    for (const pair of DUMMY_TA_BIGRAM_PER_MINUTE) {
      bigrams[`${pair.prev}_${pair.curr}`] = { c: pair.c, h: pair.hist }
    }
    bigramRows.push({
      id: `bigram|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}`,
      kind: 'bigram-minute',
      updated_at: nowMs,
      payload: {
        scopeId: DUMMY_TA_SCOPE_ID,
        minuteTs,
        bigrams,
        appName,
      },
    })
    // Layer 0 bulk typing — base layer covers most presses.
    for (let col = 0; col < 6; col += 1) {
      matrixRows.push({
        id: `matrix|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}|1|${col}|0`,
        kind: 'matrix-minute',
        updated_at: nowMs,
        payload: {
          scopeId: DUMMY_TA_SCOPE_ID,
          minuteTs,
          row: 1,
          col,
          layer: 0,
          keycode: 4 + col,
          count: 12 + col,
          tapCount: 12 + col,
          holdCount: 0,
          appName,
        },
      })
    }
    // Layer 0 layer-op keys — feeds MO/TG/TO/OSL (count) and LT1 (holdCount) activations.
    // col 1 is the LT1 key, which only counts as a layer activation when held.
    for (let col = 0; col < 5; col += 1) {
      const isLtHold = col === 1
      matrixRows.push({
        id: `matrix|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}|0|${col}|0`,
        kind: 'matrix-minute',
        updated_at: nowMs,
        payload: {
          scopeId: DUMMY_TA_SCOPE_ID,
          minuteTs,
          row: 0,
          col,
          layer: 0,
          keycode: 0,
          count: 3,
          tapCount: isLtHold ? 1 : 3,
          holdCount: isLtHold ? 2 : 0,
          appName,
        },
      })
    }
    // Layer 1 / 2 — a few keystrokes so Keystrokes view shows multi-bar.
    matrixRows.push({
      id: `matrix|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}|2|3|1`,
      kind: 'matrix-minute',
      updated_at: nowMs,
      payload: {
        scopeId: DUMMY_TA_SCOPE_ID,
        minuteTs,
        row: 2,
        col: 3,
        layer: 1,
        keycode: 7,
        count: 5,
        tapCount: 5,
        holdCount: 0,
        appName,
      },
    })
    matrixRows.push({
      id: `matrix|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}|2|5|2`,
      kind: 'matrix-minute',
      updated_at: nowMs,
      payload: {
        scopeId: DUMMY_TA_SCOPE_ID,
        minuteTs,
        row: 2,
        col: 5,
        layer: 2,
        keycode: 9,
        count: 2,
        tapCount: 2,
        holdCount: 0,
        appName,
      },
    })
    // Mirror the matrix rows above: layer-0 bulk (6 cols, 12..17) + layer-0 ops (5 × 3) + layer 1 (5) + layer 2 (2).
    let minuteKeystrokes = 0
    for (let col = 0; col < 6; col += 1) minuteKeystrokes += 12 + col
    minuteKeystrokes += 5 * 3 + 5 + 2
    statsRows.push({
      id: `stats|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}`,
      kind: 'minute-stats',
      updated_at: nowMs,
      payload: {
        scopeId: DUMMY_TA_SCOPE_ID,
        minuteTs,
        keystrokes: minuteKeystrokes,
        activeMs: 60_000,
        intervalAvgMs: 180,
        intervalMinMs: 40,
        intervalP25Ms: 90,
        intervalP50Ms: 160,
        intervalP75Ms: 260,
        intervalMaxMs: 520,
        appName,
      },
    })
  }

  const allRows = [scopeRow, sessionRow, ...matrixRows, ...statsRows, ...bigramRows]
  return allRows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

// Minimal KLE layout so the Heatmap / Ergonomics views have a geometry to
// render against. Each (row, col) becomes a unit 1x1 key at (col, row).
function buildDummyLayout(): Record<string, unknown> {
  const keys: Record<string, unknown>[] = []
  for (let row = 0; row < DUMMY_TA_ROWS; row += 1) {
    for (let col = 0; col < DUMMY_TA_COLS; col += 1) {
      keys.push({
        x: col,
        y: row,
        width: 1,
        height: 1,
        x2: 0,
        y2: 0,
        width2: 0,
        height2: 0,
        rotation: 0,
        rotationX: 0,
        rotationY: 0,
        color: '#cccccc',
        labels: Array(12).fill(''),
        textColor: Array(12).fill(null),
        textSize: Array(12).fill(null),
        row,
        col,
        encoderIdx: -1,
        encoderDir: -1,
        layoutIndex: -1,
        layoutOption: -1,
        decal: false,
        nub: false,
        stepped: false,
        ghost: false,
      })
    }
  }
  return { keys }
}

function buildDummyKeymapSnapshot(machineHash: string, savedAt: number): Record<string, unknown> {
  return {
    uid: DUMMY_TA_UID,
    machineHash,
    productName: DUMMY_TA_PRODUCT_NAME,
    savedAt,
    layers: DUMMY_TA_LAYERS,
    matrix: { rows: DUMMY_TA_ROWS, cols: DUMMY_TA_COLS },
    keymap: buildDummyKeymap(),
    layout: buildDummyLayout(),
  }
}

function toUtcDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear().toString().padStart(4, '0')
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0')
  const day = d.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

export async function seedDummyTypingAnalytics(
  userDataPath: string,
  nowMs: number,
): Promise<TypingAnalyticsSeedBackup> {
  const syncStatePath = join(userDataPath, 'local', 'typing-analytics', 'sync_state.json')
  const dbPath = join(userDataPath, 'local', 'typing-analytics.db')

  // Fast path: read cached hash from sync_state when it already exists.
  // Fallback: recompute from node-machine-id + installation-id so the seed
  // still lands in the user's `own` scope after a prior restore pass.
  const machineHash =
    readMachineHashFromSyncState(syncStatePath) ?? (await computeMachineHash(userDataPath))

  const deviceDir = join(userDataPath, 'sync', 'keyboards', DUMMY_TA_UID, 'devices', machineHash)
  const keymapsDir = join(userDataPath, 'typing-analytics', 'keymaps', DUMMY_TA_UID, machineHash)
  const jsonlPath = join(deviceDir, `${toUtcDate(nowMs)}.jsonl`)
  const snapshotSavedAt = nowMs - 4 * 3_600_000
  const snapshotPath = join(keymapsDir, `${snapshotSavedAt}.json`)
  // Older snapshot anchors the Learning Curve range. Selecting it in the
  // Analyze timeline expands the range to [olderSavedAt, snapshotSavedAt),
  // bringing the historical matrix-minute rows below into scope. The
  // 2-day buffer keeps the earliest seeded day well above the range
  // floor even when the developer's timezone shifts the SQL-derived
  // `dayMs` (local-midnight of localtime date) by up to ~14 hours.
  const olderSnapshotSavedAt = nowMs - (HISTORICAL_WEEKS * 7 + 2) * 86400_000
  const olderSnapshotPath = join(keymapsDir, `${olderSnapshotSavedAt}.json`)

  // Idempotency: wipe both dirs before writing so leftover JSONLs / snapshot
  // JSONs from a prior interrupted run don't shadow the current seed.
  // Stale snapshots (which `getKeymapSnapshotForRange` picks newest-in-range)
  // can otherwise carry old layouts and break the Learning Curve render.
  rmSync(deviceDir, { recursive: true, force: true })
  rmSync(keymapsDir, { recursive: true, force: true })
  mkdirSync(deviceDir, { recursive: true })
  mkdirSync(keymapsDir, { recursive: true })

  writeFileSync(jsonlPath, buildDummyJsonlContent(machineHash, nowMs), 'utf-8')
  writeFileSync(
    snapshotPath,
    JSON.stringify(buildDummyKeymapSnapshot(machineHash, snapshotSavedAt)),
    'utf-8',
  )
  writeFileSync(
    olderSnapshotPath,
    JSON.stringify(buildDummyKeymapSnapshot(machineHash, olderSnapshotSavedAt)),
    'utf-8',
  )

  // Per-day historical jsonl masters. Each file holds rows for its own UTC
  // day, matching the v7 layout the cache rebuild expects. We snap each
  // bucket to UTC midnight before adding a noon offset inside
  // `buildHistoricalDayJsonlContent`, so the file name and the minute_ts
  // it carries always describe the same UTC calendar day.
  const todayUtcMidnightMs = Math.floor(nowMs / 86400_000) * 86400_000
  const historicalJsonlPaths: string[] = []
  for (let weekIdx = 0; weekIdx < HISTORICAL_WEEKS; weekIdx += 1) {
    const weekStartMs = todayUtcMidnightMs - (HISTORICAL_WEEKS - weekIdx) * 7 * 86400_000
    for (const dayOffset of HISTORICAL_DAY_OFFSETS_PER_WEEK) {
      const dayMs = weekStartMs + dayOffset * 86400_000
      const path = join(deviceDir, `${toUtcDate(dayMs)}.jsonl`)
      writeFileSync(path, buildHistoricalDayJsonlContent(machineHash, dayMs, weekIdx, nowMs), 'utf-8')
      historicalJsonlPaths.push(path)
    }
  }

  // Force ensureCacheIsFresh to rebuild from the JSONL master on next launch.
  try { unlinkSync(syncStatePath) } catch { /* ignore */ }

  return {
    jsonlPath,
    historicalJsonlPaths,
    snapshotPath,
    olderSnapshotPath,
    syncStatePath,
    dbPath,
  }
}

// Delete every file we seeded plus the cache artifacts so the next real
// app launch runs `ensureCacheIsFresh` on an empty JSONL master and
// rebuilds a clean DB. Restoring the original DB / sync_state would race
// against the Electron process's own shutdown writes.
export function restoreTypingAnalytics(backup: TypingAnalyticsSeedBackup): void {
  const paths = [
    backup.jsonlPath,
    ...backup.historicalJsonlPaths,
    backup.snapshotPath,
    backup.olderSnapshotPath,
    backup.syncStatePath,
    backup.dbPath,
  ]
  for (const path of paths) {
    try { unlinkSync(path) } catch { /* ignore */ }
  }
}

// --- Dummy Analyze filter store entries ---
//
// Lays down a minimal `index.json` plus per-entry payloads under the same
// keyboard UID seeded by seedDummyTypingAnalytics, so the Analyze "Saved
// search conditions" panel renders with two example entries for the
// operation guide screenshot. Each payload is a no-op snapshot of the
// active filters (range + empty `filters`) so the load button works
// without forcing the seeded view into an unexpected sub-tab.

export const DUMMY_FILTER_STORE_UID = DUMMY_TA_UID

export const DUMMY_FILTER_STORE_ENTRIES = [
  {
    id: 'doc-filter-1',
    label: 'Last 7 days · all apps',
    summary: 'All apps · This device · Last 7 days',
    filename: 'doc-filter-1.json',
    savedAt: '2026-04-20T10:00:00.000Z',
  },
  {
    id: 'doc-filter-2',
    label: 'Coding sessions',
    summary: 'Code · This device · Last 30 days',
    filename: 'doc-filter-2.json',
    savedAt: '2026-04-25T14:30:00.000Z',
  },
]

export function seedDummyFilterStore(snapshotBase: string): Map<string, string | null> {
  const backups = new Map<string, string | null>()
  const dir = join(snapshotBase, DUMMY_FILTER_STORE_UID, 'analyze_filters')
  mkdirSync(dir, { recursive: true })

  const indexPath = join(dir, 'index.json')
  backups.set(indexPath, existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null)
  writeFileSync(
    indexPath,
    JSON.stringify({ uid: DUMMY_FILTER_STORE_UID, entries: DUMMY_FILTER_STORE_ENTRIES }, null, 2),
    'utf-8',
  )

  for (const entry of DUMMY_FILTER_STORE_ENTRIES) {
    const payloadPath = join(dir, entry.filename)
    backups.set(payloadPath, existsSync(payloadPath) ? readFileSync(payloadPath, 'utf-8') : null)
    const savedAtMs = Date.parse(entry.savedAt)
    const payload = {
      version: 1,
      analysisTab: 'summary',
      range: { fromMs: savedAtMs - 7 * 86400_000, toMs: savedAtMs },
      filters: {},
    }
    writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf-8')
  }
  return backups
}

export function restoreFilterStore(backups: Map<string, string | null>): void {
  for (const [path, original] of backups) {
    if (original != null) {
      writeFileSync(path, original, 'utf-8')
    } else {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  }
}
