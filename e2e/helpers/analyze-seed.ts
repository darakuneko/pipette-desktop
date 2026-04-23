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

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
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

export interface TypingAnalyticsSeedBackup {
  jsonlPath: string
  snapshotPath: string
  syncStatePath: string
  dbPath: string
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
        const override = DUMMY_TA_LAYER_OPS[`${layer},${row},${col}`]
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

function buildDummyJsonlContent(machineHash: string, nowMs: number): string {
  const scopeRow = {
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

  const matrixRows: unknown[] = []
  const statsRows: unknown[] = []
  const minuteBase = Math.floor((nowMs - 60_000) / 60_000) * 60_000
  for (const offset of dummyMinuteOffsets()) {
    const minuteTs = minuteBase - offset * 60_000
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
      },
    })
  }

  const allRows = [scopeRow, sessionRow, ...matrixRows, ...statsRows]
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

  const jsonlPath = join(
    userDataPath,
    'sync',
    'keyboards',
    DUMMY_TA_UID,
    'devices',
    machineHash,
    `${toUtcDate(nowMs)}.jsonl`,
  )
  const snapshotSavedAt = nowMs - 4 * 3_600_000
  const snapshotPath = join(
    userDataPath,
    'typing-analytics',
    'keymaps',
    DUMMY_TA_UID,
    machineHash,
    `${snapshotSavedAt}.json`,
  )

  mkdirSync(join(userDataPath, 'sync', 'keyboards', DUMMY_TA_UID, 'devices', machineHash), {
    recursive: true,
  })
  mkdirSync(join(userDataPath, 'typing-analytics', 'keymaps', DUMMY_TA_UID, machineHash), {
    recursive: true,
  })

  writeFileSync(jsonlPath, buildDummyJsonlContent(machineHash, nowMs), 'utf-8')
  writeFileSync(
    snapshotPath,
    JSON.stringify(buildDummyKeymapSnapshot(machineHash, snapshotSavedAt)),
    'utf-8',
  )

  // Force ensureCacheIsFresh to rebuild from the JSONL master on next launch.
  try { unlinkSync(syncStatePath) } catch { /* ignore */ }

  return { jsonlPath, snapshotPath, syncStatePath, dbPath }
}

// Delete every file we seeded plus the cache artifacts so the next real
// app launch runs `ensureCacheIsFresh` on an empty JSONL master and
// rebuilds a clean DB. Restoring the original DB / sync_state would race
// against the Electron process's own shutdown writes.
export function restoreTypingAnalytics(backup: TypingAnalyticsSeedBackup): void {
  for (const path of [backup.jsonlPath, backup.snapshotPath, backup.syncStatePath, backup.dbPath]) {
    try { unlinkSync(path) } catch { /* ignore */ }
  }
}
