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
//
// The dataset below covers a 21-day "current" window (bounded by the
// current keymap snapshot's `savedAt` .. now) plus a sparser 7-week
// "historical" window before it (bounded by an older snapshot, only
// reachable by pivoting the Keymap filter — see the Learning Curve
// comment further down). Every chart tab reads from the current
// window by default, so it carries full minute-stats (not just
// matrix-minute) across many keys, two extra layers, varied WPM,
// multiple apps, and a handful of typing-test runs.

export const DUMMY_TA_UID = 'doc-ta-keyboard-1'
const DUMMY_TA_SCOPE_ID = 'doc-ta-scope-1'
const DUMMY_TA_PRODUCT_NAME = 'GPK60-63R (docs)'
export const DUMMY_TA_LAYERS = 3
const DUMMY_TA_ROWS = 5
const DUMMY_TA_COLS = 14
const DAY_MS = 86_400_000

// Layer-op keys on layer 0 (row category "number" per
// `rowCategoryForIndex` — row 0 of a 5-row layout) so the Activations
// view has more than one target layer.
const DUMMY_TA_LAYER_OPS: Record<string, string> = {
  '0,0,0': 'MO(1)',
  '0,0,1': 'LT1(KC_ESC)',
  '0,0,2': 'TG(2)',
  '0,0,3': 'TO(1)',
  '0,0,4': 'OSL(2)',
}

// Alpha row aligned with the matrix-minute seed (keycode = 4 + col on
// layer 0 row 1, the "top" row). Cols 0-5 (KC_A-KC_F) and 9-11
// (KC_J-KC_L) are the cells the fixed bigram set below references by
// keycode, so the Bigrams Finger IKI view shows both blue (left-start)
// and red (right-start) bars instead of a single-hand silhouette. Kept
// stable across the whole current window: `buildKeycodeFingerMap`
// resolves a bigram's keycode to a finger by matching this exact
// keymap text, so these cells must not be reassigned.
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

// Additional top-row keys (cols 6-8, 12) so the heatmap covers more of
// row 1 without touching the bigram-critical cells above.
const DUMMY_TA_TOP_EXTRA: Record<string, string> = {
  '0,1,6': 'KC_G',
  '0,1,7': 'KC_H',
  '0,1,8': 'KC_I',
  '0,1,12': 'KC_M',
}

// Dedicated Backspace cell (top row, last column) — keycode 42 is what
// the "backspace %" query (`selectBksMinuteInRangeForUidStmt`) filters
// on, so this is the only cell that should ever carry it.
const DUMMY_TA_BACKSPACE_POS = { row: 1, col: 13 }
const DUMMY_TA_BACKSPACE_KEYCODE = 42

// Home row (row category "home") is otherwise unused by the base
// dataset, so the whole row is free for wide heatmap / ergonomics
// coverage. Weighted center-heavy in `HOME_ROW_WEIGHTS` below to
// simulate touch-typing (index/middle fingers do more work than pinkies).
const DUMMY_TA_HOME_ROW: Record<string, string> = {
  '0,2,0': 'KC_N', '0,2,1': 'KC_O', '0,2,2': 'KC_P', '0,2,3': 'KC_Q',
  '0,2,4': 'KC_R', '0,2,5': 'KC_S', '0,2,6': 'KC_T', '0,2,7': 'KC_U',
  '0,2,8': 'KC_V', '0,2,9': 'KC_W',
}
const HOME_ROW_COLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const
const HOME_ROW_KEYCODES = [17, 18, 19, 20, 21, 22, 23, 24, 25, 26] as const
const HOME_ROW_WEIGHTS = [3, 5, 6, 8, 8, 8, 8, 6, 5, 3] as const

const TOP_EXTRA_COLS = [6, 7, 8, 12] as const
const TOP_EXTRA_KEYCODES = [10, 11, 12, 16] as const
const TOP_EXTRA_WEIGHTS = [2, 3, 3, 2] as const

export interface TypingAnalyticsSeedBackup {
  /** One JSONL master per day of the 21-day current window — see
   * `buildCurrentWindowDayContent`. */
  currentWindowJsonlPaths: string[]
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
  /** Typing-test History entries for the seeded keyboard — see
   * `buildPipetteSettingsContent`. `original` is the pre-existing file
   * content (`null` when none existed) so cleanup can restore it. */
  pipetteSettingsPath: string
  pipetteSettingsOriginal: string | null
}

// --- Historical seed for the Ergonomic Learning Curve view ---
//
// The current window (below) only reaches back 21 days, so the learning
// curve always falls into its empty state for anything older. Layering 7
// weeks of sparse matrix-minute history before the current window's start
// gives the Learning Curve 7 weekly buckets with a deliberate upward trend
// (more home-row stay and fewer index-finger collisions over time). The
// history is gated to the older snapshot's active window so it only
// appears when the user (or doc-capture) explicitly selects that snapshot
// — the default "Current keymap" range stays at the 21-day window and the
// other Analyze screenshots see the same data they always have.

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
        const override =
          DUMMY_TA_LAYER_OPS[key] ?? DUMMY_TA_ALPHA_ROW[key] ?? DUMMY_TA_TOP_EXTRA[key] ?? DUMMY_TA_HOME_ROW[key]
        cols.push(override ?? 'KC_A')
      }
      layerRows.push(cols)
    }
    keymap.push(layerRows)
  }
  keymap[0][DUMMY_TA_BACKSPACE_POS.row][DUMMY_TA_BACKSPACE_POS.col] = 'KC_BSPC'
  return keymap
}

// Recent-minute slices (offsets in minutes before "now") replayed on top of
// today's fixed-hour sessions so very-recent activity always exists
// regardless of what wall-clock hour doc-capture happens to run at.
function recentTailOffsetsMinutes(): number[] {
  return [50, 40, 30, 20, 10, 6, 4, 2, 1]
}

// Bucket centers mirror BIGRAM_BUCKET_CENTERS_MS in bigram-bucket.ts —
// treating every sample as sitting at its bucket center is the same
// estimate the histogram-only avgIki approximation already uses, so
// `s` / `sq` (see `sumsFromHist`) read as a natural companion to Avg
// IKI rather than an unrelated number.
const BUCKET_CENTERS_MS = [30, 80, 125, 175, 250, 400, 750, 1500] as const

/** Derives the sum and sum-of-squares of raw IKI a histogram implies,
 * by weighting each bucket's center by its count — see the module
 * comment above. Lets the bigram/trigram fixtures below carry only
 * `hist` instead of hand-computed `s` / `sq` duplicates. */
function sumsFromHist(hist: readonly number[]): { s: number; sq: number } {
  let s = 0
  let sq = 0
  hist.forEach((count, i) => {
    const center = BUCKET_CENTERS_MS[i]
    s += count * center
    sq += count * center * center
  })
  return { s, sq }
}

// Representative bigram pairs for the Bigrams tab. Histogram bucket
// boundaries (ms): [60, 100, 150, 200, 300, 500, 1000, Inf]. Each entry
// is replayed every minute so the Top quadrant shows count-leaders, the
// Slow quadrant ranks high-IKI pairs, and Finger / Pair quadrants show
// a varied avgIki distribution. Keycodes 4-9 are KC_A-KC_F; the alpha
// row in the dummy keymap pins them to layer-0 row 1 columns 0-5 so
// `buildKeycodeFingerMap` can resolve them to distinct fingers. `s` /
// `sq` are derived from `hist` via `sumsFromHist` at write time (see
// `buildMinuteRows`) so every entry gets a value — the SD column always
// shows a value instead of "—" in the seeded current window.
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

// Representative trigram triples for the 3-gram Bigrams-tab view.
// Reuses the same alpha-row keycodes (4-9 = KC_A-KC_F, 13-15 = KC_J-L)
// as the bigram set above so the trigram pair labels resolve through
// the same dummy keymap. `s` / `sq` are derived the same way as
// `DUMMY_TA_BIGRAM_PER_MINUTE`; trigram IKI values are already the
// 2-interval average by the time they reach the histogram (see
// MinuteBuffer.recordNgramChain), so no extra scaling is needed here.
const DUMMY_TA_TRIGRAM_PER_MINUTE: ReadonlyArray<{
  k1: number
  k2: number
  k3: number
  c: number
  hist: readonly number[]
}> = [
  { k1: 4, k2: 5, k3: 6, c: 7, hist: [2, 3, 2, 0, 0, 0, 0, 0] },
  { k1: 5, k2: 6, k3: 7, c: 5, hist: [0, 2, 2, 1, 0, 0, 0, 0] },
  { k1: 13, k2: 14, k3: 15, c: 4, hist: [1, 2, 1, 0, 0, 0, 0, 0] },
  { k1: 6, k2: 5, k3: 4, c: 3, hist: [0, 0, 1, 1, 1, 0, 0, 0] },
]

// --- Current-window seed (21 days, full minute-stats) ---
//
// This is what every Analyze tab reads by default: the current keymap
// snapshot's `savedAt` sits at the start of day 0, so the default
// "Current keymap" range covers the whole window. Each day plays a
// fixed set of local-hour "sessions" (so the goal/streak/fatigue
// classifiers see clean calendar-day boundaries and repeatable
// hour-of-day buckets regardless of the host machine's timezone).

const CURRENT_WINDOW_DAYS = 21
// Local wall-clock hours typed each day. Order also encodes the
// intra-day fatigue slope consumed by `classifyFatigue` — later
// sessions type slower than the day's morning session.
const DAILY_SESSION_HOURS = [9, 13, 17, 21] as const
const SESSION_MINUTES = 6
const WPM_MIN = 30
const WPM_MAX = 80
// Fixed per-minute contribution from the bigram-critical alpha cells
// (87), the layer-op cells (15), and the layer-1/2 samples (5 + 2).
// Kept constant across every WPM level so Activations / Bigrams Finger
// stay populated even on the slowest seeded days; the variable cells
// below make up the rest of the target keystroke count.
const AUX_KEYSTROKES_PER_MINUTE = 87 + 15 + 5 + 2
// Apps cycle by (day, hour-slot) so the By App donut / WPM-by-App bars
// show a real multi-app split. Typing-test runs stay untagged (a real
// typing test isn't "in" a monitored app), matching production.
const APP_CYCLE = ['Code', 'Slack', 'Chrome'] as const

interface MinuteTag {
  typingTest?: string
  runId?: string
}

/** One seeded typing-test run: material label + run id planted on a
 * specific (dayIndex, hourIndex) session. `historyName` is `undefined`
 * for a nameless History entry (falls back to its saved date) and
 * `null` when no History entry should be written at all — the run
 * still exists in analytics, exercising the `firstMs` fallback in
 * `useRunLabels`. Every `dayIndex` here is `< CURRENT_WINDOW_DAYS - 1`
 * so the run always lands on a fully-past day. */
interface DummyRunPlan {
  dayIndex: number
  hourIndex: number
  runId: string
  typingTest: string
  mode: 'tatoeba' | 'fileImport'
  language?: string
  fileImportTextName?: string
  historyName?: string | null
}

const FILE_IMPORT_TEXT_NAME = '走れメロス（太宰 治）'

const DUMMY_RUN_PLANS: readonly DummyRunPlan[] = [
  {
    dayIndex: 2, hourIndex: 0, runId: 'doc-run-tatoeba-1', typingTest: 'tatoeba-japanese',
    mode: 'tatoeba', language: 'japanese', historyName: 'Tatoeba warm-up',
  },
  {
    dayIndex: 6, hourIndex: 1, runId: 'doc-run-tatoeba-2', typingTest: 'tatoeba-japanese',
    mode: 'tatoeba', language: 'japanese', historyName: undefined,
  },
  {
    dayIndex: 10, hourIndex: 2, runId: 'doc-run-fileimport-1', typingTest: FILE_IMPORT_TEXT_NAME,
    mode: 'fileImport', fileImportTextName: FILE_IMPORT_TEXT_NAME, historyName: 'Melos best run',
  },
  {
    dayIndex: 14, hourIndex: 3, runId: 'doc-run-fileimport-2', typingTest: FILE_IMPORT_TEXT_NAME,
    mode: 'fileImport', fileImportTextName: FILE_IMPORT_TEXT_NAME, historyName: undefined,
  },
  // No History entry at all — exercises the `firstMs` fallback tier.
  {
    dayIndex: 18, hourIndex: 0, runId: 'doc-run-fileimport-3', typingTest: FILE_IMPORT_TEXT_NAME,
    mode: 'fileImport', fileImportTextName: FILE_IMPORT_TEXT_NAME, historyName: null,
  },
]

function planFor(dayIndex: number, hourIndex: number): DummyRunPlan | null {
  return DUMMY_RUN_PLANS.find((p) => p.dayIndex === dayIndex && p.hourIndex === hourIndex) ?? null
}

/** Local midnight of `baseMs`'s calendar day, shifted by `dayOffset`
 * days. Uses `Date` component arithmetic (not raw ms math) so a
 * session built as `dayStart + hour * 3_600_000` always lands on the
 * same *local* calendar day the goal/streak classifiers group by —
 * a pure-UTC anchor would split a day's sessions across two local
 * dates in most non-UTC timezones and silently break the streak. */
function localMidnightMs(baseMs: number, dayOffset: number): number {
  const d = new Date(baseMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, 0, 0, 0, 0).getTime()
}

/** Ramps 30→80 WPM across the window with a small deterministic
 * wiggle so the WPM chart isn't a perfectly straight line. */
function dayWpmBase(dayIndex: number): number {
  const t = dayIndex / (CURRENT_WINDOW_DAYS - 1)
  const ramp = WPM_MIN + (WPM_MAX - WPM_MIN) * t
  const wiggle = 4 * Math.sin(dayIndex * 0.9)
  return Math.min(WPM_MAX, Math.max(WPM_MIN, ramp + wiggle))
}

/** Session WPM = the day's base minus a per-slot fatigue drop (later
 * sessions are slower) plus a small deterministic jitter. Feeds
 * `classifyFatigue`'s hour-of-day buckets directly since the same 4
 * hours repeat every day. */
function sessionWpm(dayIndex: number, hourIndex: number): number {
  const fatigueDrop = hourIndex * 3
  const jitter = 2 * Math.cos(dayIndex * 1.7 + hourIndex)
  return Math.round(Math.min(WPM_MAX, Math.max(20, dayWpmBase(dayIndex) - fatigueDrop + jitter)))
}

/** Classic QMK/WPM formula, inverted: keystrokes needed in one active
 * minute to read back as `wpm` (mirrors `computeWpm` in
 * `analyze-wpm.ts`: `wpm = (keystrokes / 5) * 60_000 / activeMs`). */
function keystrokesPerMinuteForWpm(wpm: number): number {
  return Math.max(1, Math.round(wpm * 5))
}

function distributeByWeights(total: number, weights: readonly number[]): number[] {
  if (total <= 0) return weights.map(() => 0)
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => Math.round((total * w) / sum))
}

/** Builds every row for one seeded minute: the fixed aux cells (alpha
 * row + layer-ops + layer 1/2 samples), the wide top-row/home-row
 * distribution sized to reach `keystrokesTarget`, a dedicated
 * Backspace cell, the minute-stats row, and a bigram-minute row. */
function buildMinuteRows(
  minuteTs: number,
  nowMs: number,
  keystrokesTarget: number,
  appName: string | null,
  tag: MinuteTag,
): unknown[] {
  const rows: unknown[] = []
  let total = 0

  const pushMatrix = (row: number, col: number, layer: number, keycode: number, count: number, tapCount: number, holdCount: number): void => {
    if (count <= 0) return
    rows.push({
      id: `matrix|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}|${row}|${col}|${layer}`,
      kind: 'matrix-minute',
      updated_at: nowMs,
      payload: {
        scopeId: DUMMY_TA_SCOPE_ID, minuteTs, row, col, layer, keycode, count, tapCount, holdCount,
        appName, ...tag,
      },
    })
    total += count
  }

  // Bigram-critical alpha cells (top row, cols 0-5 = KC_A-KC_F).
  for (let col = 0; col < 6; col += 1) {
    pushMatrix(1, col, 0, 4 + col, 12 + col, 12 + col, 0)
  }
  // Layer-op keys — feeds MO/TG/TO/OSL (count) and LT1 (holdCount) activations.
  // col 1 is the LT1 key, which only counts as a layer activation when held.
  for (let col = 0; col < 5; col += 1) {
    const isLtHold = col === 1
    pushMatrix(0, col, 0, 0, 3, isLtHold ? 1 : 3, isLtHold ? 2 : 0)
  }
  // Layer 1 / 2 samples so the Keystrokes / Activations views show multi-bar.
  pushMatrix(2, 3, 1, 7, 5, 5, 0)
  pushMatrix(2, 5, 2, 9, 2, 2, 0)

  // Variable cells make up the rest of the target: Backspace (5%),
  // top-row extras (35% of the remainder), home row (65%).
  const remaining = Math.max(0, keystrokesTarget - AUX_KEYSTROKES_PER_MINUTE)
  const bkspCount = Math.round(remaining * 0.05)
  const distributable = remaining - bkspCount
  const topExtraTotal = Math.round(distributable * 0.35)
  const homeTotal = distributable - topExtraTotal

  pushMatrix(DUMMY_TA_BACKSPACE_POS.row, DUMMY_TA_BACKSPACE_POS.col, 0, DUMMY_TA_BACKSPACE_KEYCODE, bkspCount, bkspCount, 0)
  distributeByWeights(topExtraTotal, TOP_EXTRA_WEIGHTS).forEach((count, i) => {
    pushMatrix(1, TOP_EXTRA_COLS[i], 0, TOP_EXTRA_KEYCODES[i], count, count, 0)
  })
  distributeByWeights(homeTotal, HOME_ROW_WEIGHTS).forEach((count, i) => {
    pushMatrix(2, HOME_ROW_COLS[i], 0, HOME_ROW_KEYCODES[i], count, count, 0)
  })

  const avgIntervalMs = 60_000 / Math.max(1, total)
  rows.push({
    id: `stats|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}`,
    kind: 'minute-stats',
    updated_at: nowMs,
    payload: {
      scopeId: DUMMY_TA_SCOPE_ID,
      minuteTs,
      keystrokes: total,
      activeMs: 60_000,
      // Ratios mirror the original hand-tuned single-session seed
      // (avg 180 / min 40 / p25 90 / p50 160 / p75 260 / max 520ms)
      // scaled to this minute's own average interval (60s / count,
      // guarded against a zero-keystroke minute).
      intervalAvgMs: Math.round(avgIntervalMs),
      intervalMinMs: Math.round(avgIntervalMs * 0.22),
      intervalP25Ms: Math.round(avgIntervalMs * 0.5),
      intervalP50Ms: Math.round(avgIntervalMs * 0.89),
      intervalP75Ms: Math.round(avgIntervalMs * 1.44),
      intervalMaxMs: Math.round(avgIntervalMs * 2.89),
      appName, ...tag,
    },
  })

  const bigrams: Record<string, { c: number; h: readonly number[]; s: number; sq: number }> = {}
  for (const pair of DUMMY_TA_BIGRAM_PER_MINUTE) {
    bigrams[`${pair.prev}_${pair.curr}`] = { c: pair.c, h: pair.hist, ...sumsFromHist(pair.hist) }
  }
  rows.push({
    id: `bigram|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}`,
    kind: 'bigram-minute',
    updated_at: nowMs,
    payload: { scopeId: DUMMY_TA_SCOPE_ID, minuteTs, bigrams, appName, ...tag },
  })

  const trigrams: Record<string, { c: number; h: readonly number[]; s: number; sq: number }> = {}
  for (const triple of DUMMY_TA_TRIGRAM_PER_MINUTE) {
    trigrams[`${triple.k1}_${triple.k2}_${triple.k3}`] = { c: triple.c, h: triple.hist, ...sumsFromHist(triple.hist) }
  }
  rows.push({
    id: `trigram|${encodeURIComponent(DUMMY_TA_SCOPE_ID)}|${minuteTs}`,
    kind: 'trigram-minute',
    updated_at: nowMs,
    payload: { scopeId: DUMMY_TA_SCOPE_ID, minuteTs, trigrams, appName, ...tag },
  })

  return rows
}

interface CurrentWindowDayResult {
  content: string
  /** `runId -> session start ms`, used to date the History entries
   * `buildPipetteSettingsContent` writes for this day's tagged runs. */
  runDates: Map<string, number>
}

/** Builds one day's JSONL master: up to `DAILY_SESSION_HOURS.length`
 * fixed-hour sessions (skipped once their start would land in the
 * future — only relevant for the last, "today" day), plus a recent-
 * minute tail on the last day so very-recent activity always exists. */
function buildCurrentWindowDayContent(
  dayIndex: number,
  dayStartMs: number,
  nowMs: number,
  machineHash: string,
): CurrentWindowDayResult {
  const rows: unknown[] = [buildScopeRow(machineHash, nowMs)]
  const runDates = new Map<string, number>()
  let firstMinuteTs: number | null = null
  let lastMinuteTs: number | null = null
  const isLastDay = dayIndex === CURRENT_WINDOW_DAYS - 1

  DAILY_SESSION_HOURS.forEach((hour, hourIndex) => {
    const sessionStartMs = dayStartMs + hour * 3_600_000
    if (sessionStartMs + SESSION_MINUTES * 60_000 > nowMs) return // not reached yet (today only)

    const plan = planFor(dayIndex, hourIndex)
    const tag: MinuteTag = plan ? { typingTest: plan.typingTest, runId: plan.runId } : {}
    const appName = plan ? null : APP_CYCLE[(dayIndex * DAILY_SESSION_HOURS.length + hourIndex) % APP_CYCLE.length]
    const target = keystrokesPerMinuteForWpm(sessionWpm(dayIndex, hourIndex))
    if (plan) runDates.set(plan.runId, sessionStartMs)

    for (let m = 0; m < SESSION_MINUTES; m += 1) {
      const minuteTs = Math.floor((sessionStartMs + m * 60_000) / 60_000) * 60_000
      if (minuteTs >= nowMs) break
      firstMinuteTs = firstMinuteTs === null ? minuteTs : Math.min(firstMinuteTs, minuteTs)
      lastMinuteTs = lastMinuteTs === null ? minuteTs : Math.max(lastMinuteTs, minuteTs)
      rows.push(...buildMinuteRows(minuteTs, nowMs, target, appName, tag))
    }
  })

  if (isLastDay) {
    const target = keystrokesPerMinuteForWpm(sessionWpm(dayIndex, 0))
    for (const offsetMin of recentTailOffsetsMinutes()) {
      const minuteTs = Math.floor((nowMs - offsetMin * 60_000) / 60_000) * 60_000
      if (minuteTs >= nowMs) continue
      firstMinuteTs = firstMinuteTs === null ? minuteTs : Math.min(firstMinuteTs, minuteTs)
      lastMinuteTs = lastMinuteTs === null ? minuteTs : Math.max(lastMinuteTs, minuteTs)
      rows.push(...buildMinuteRows(minuteTs, nowMs, target, APP_CYCLE[0], {}))
    }
  }

  if (firstMinuteTs !== null && lastMinuteTs !== null) {
    const sessionId = `doc-ta-session-${dayIndex}`
    rows.push({
      id: `session|${encodeURIComponent(sessionId)}`,
      kind: 'session',
      updated_at: nowMs,
      payload: { id: sessionId, scopeId: DUMMY_TA_SCOPE_ID, startMs: firstMinuteTs, endMs: lastMinuteTs + 60_000 },
    })
  }

  return { content: rows.map((r) => JSON.stringify(r)).join('\n') + '\n', runDates }
}

interface DummyTypingTestHistoryEntry {
  date: string
  runId: string
  name?: string
  wpm: number
  accuracy: number
  wordCount: number
  correctChars: number
  incorrectChars: number
  durationSeconds: number
  mode: 'tatoeba' | 'fileImport'
  language?: string
  fileImportTextName?: string
}

/** Builds the seeded keyboard's `pipette_settings.json` content —
 * History entries for every {@link DUMMY_RUN_PLANS} plan except the
 * one with `historyName: null` (which exists only in analytics, so
 * `useRunLabels` falls back to the run's first-minute timestamp). */
function buildPipetteSettingsContent(runDates: ReadonlyMap<string, number>): string {
  const typingTestResults: DummyTypingTestHistoryEntry[] = []
  for (const plan of DUMMY_RUN_PLANS) {
    if (plan.historyName === null) continue
    const startMs = runDates.get(plan.runId)
    if (startMs === undefined) continue
    const wpm = sessionWpm(plan.dayIndex, plan.hourIndex)
    const wordCount = Math.round((SESSION_MINUTES * wpm))
    const correctChars = Math.round(wordCount * 5 * 0.97)
    const incorrectChars = Math.max(0, wordCount * 5 - correctChars)
    typingTestResults.push({
      date: new Date(startMs).toISOString(),
      runId: plan.runId,
      name: plan.historyName,
      wpm,
      accuracy: 97,
      wordCount,
      correctChars,
      incorrectChars,
      durationSeconds: SESSION_MINUTES * 60,
      mode: plan.mode,
      language: plan.language,
      fileImportTextName: plan.fileImportTextName,
    })
  }
  return JSON.stringify({
    _rev: 1,
    keyboardLayout: 'qwerty',
    autoAdvance: true,
    layerNames: [],
    typingTestResults,
  })
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
  const pipetteSettingsPath = join(userDataPath, 'sync', 'keyboards', DUMMY_TA_UID, 'pipette_settings.json')

  // Current window: 21 local-calendar days ending "today". The current
  // snapshot's savedAt sits at the start of day 0, so the default
  // "Current keymap" range covers the whole window without any pivot.
  const currentWindowStartMs = localMidnightMs(nowMs, -(CURRENT_WINDOW_DAYS - 1))
  const snapshotSavedAt = currentWindowStartMs
  const snapshotPath = join(keymapsDir, `${snapshotSavedAt}.json`)
  // Older snapshot anchors the Learning Curve range. Selecting it in the
  // Analyze timeline expands the range to [olderSavedAt, snapshotSavedAt),
  // bringing the historical matrix-minute rows below into scope. The
  // 2-day buffer keeps the earliest seeded day well above the range
  // floor even when the developer's timezone shifts the SQL-derived
  // `dayMs` (local-midnight of localtime date) by up to ~14 hours.
  const olderSnapshotSavedAt = currentWindowStartMs - (HISTORICAL_WEEKS * 7 + 2) * DAY_MS
  const olderSnapshotPath = join(keymapsDir, `${olderSnapshotSavedAt}.json`)

  // Idempotency: wipe both dirs before writing so leftover JSONLs / snapshot
  // JSONs from a prior interrupted run don't shadow the current seed.
  // Stale snapshots (which `getKeymapSnapshotForRange` picks newest-in-range)
  // can otherwise carry old layouts and break the Learning Curve render.
  rmSync(deviceDir, { recursive: true, force: true })
  rmSync(keymapsDir, { recursive: true, force: true })
  mkdirSync(deviceDir, { recursive: true })
  mkdirSync(keymapsDir, { recursive: true })

  // Per-day current-window jsonl masters, plus the runId -> start-ms map
  // used to date the pipette_settings History entries below.
  const currentWindowJsonlPaths: string[] = []
  const runDates = new Map<string, number>()
  for (let dayIndex = 0; dayIndex < CURRENT_WINDOW_DAYS; dayIndex += 1) {
    const dayStartMs = localMidnightMs(currentWindowStartMs, dayIndex)
    const { content, runDates: dayRunDates } = buildCurrentWindowDayContent(dayIndex, dayStartMs, nowMs, machineHash)
    const path = join(deviceDir, `${toUtcDate(dayStartMs)}.jsonl`)
    writeFileSync(path, content, 'utf-8')
    currentWindowJsonlPaths.push(path)
    for (const [runId, startMs] of dayRunDates) runDates.set(runId, startMs)
  }

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

  // Per-day historical jsonl masters, anchored to the start of the current
  // window (not "today") so they always precede it and the Learning Curve
  // pivot's [olderSavedAt, snapshotSavedAt) range stays exclusively
  // historical. Each file holds rows for its own UTC day, matching the v7
  // layout the cache rebuild expects.
  const historicalJsonlPaths: string[] = []
  for (let weekIdx = 0; weekIdx < HISTORICAL_WEEKS; weekIdx += 1) {
    const weekStartMs = currentWindowStartMs - (HISTORICAL_WEEKS - weekIdx) * 7 * DAY_MS
    for (const dayOffset of HISTORICAL_DAY_OFFSETS_PER_WEEK) {
      const dayMs = weekStartMs + dayOffset * DAY_MS
      const path = join(deviceDir, `${toUtcDate(dayMs)}.jsonl`)
      writeFileSync(path, buildHistoricalDayJsonlContent(machineHash, dayMs, weekIdx, nowMs), 'utf-8')
      historicalJsonlPaths.push(path)
    }
  }

  // Typing-test History entries for the seeded runs — back up whatever
  // pre-existing file is there (should be none for this dummy uid) so
  // cleanup restores it exactly.
  const pipetteSettingsOriginal = existsSync(pipetteSettingsPath)
    ? readFileSync(pipetteSettingsPath, 'utf-8')
    : null
  mkdirSync(join(userDataPath, 'sync', 'keyboards', DUMMY_TA_UID), { recursive: true })
  writeFileSync(pipetteSettingsPath, buildPipetteSettingsContent(runDates), 'utf-8')

  // Force ensureCacheIsFresh to rebuild from the JSONL master on next launch.
  try { unlinkSync(syncStatePath) } catch { /* ignore */ }

  return {
    currentWindowJsonlPaths,
    historicalJsonlPaths,
    snapshotPath,
    olderSnapshotPath,
    syncStatePath,
    dbPath,
    pipetteSettingsPath,
    pipetteSettingsOriginal,
  }
}

// Delete every file we seeded plus the cache artifacts so the next real
// app launch runs `ensureCacheIsFresh` on an empty JSONL master and
// rebuilds a clean DB. Restoring the original DB / sync_state would race
// against the Electron process's own shutdown writes. pipette_settings.json
// is a plain sync file (not cache-derived), so its original content is
// restored (or deleted, if it didn't exist before seeding) instead.
export function restoreTypingAnalytics(backup: TypingAnalyticsSeedBackup): void {
  if (backup.pipetteSettingsOriginal !== null) {
    try { writeFileSync(backup.pipetteSettingsPath, backup.pipetteSettingsOriginal, 'utf-8') } catch { /* ignore */ }
  } else {
    try { unlinkSync(backup.pipetteSettingsPath) } catch { /* ignore */ }
  }

  const paths = [
    ...backup.currentWindowJsonlPaths,
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
