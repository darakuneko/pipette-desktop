// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics shared types — see .claude/plans/typing-analytics.md.

export const TYPING_ANALYTICS_REV = 1
export const TYPING_ANALYTICS_VERSION = 1

export const DEFAULT_TYPING_SYNC_SPAN_DAYS = 7
export const ALLOWED_TYPING_SYNC_SPAN_DAYS = [1, 7, 30, 90] as const
export type TypingSyncSpanDays = typeof ALLOWED_TYPING_SYNC_SPAN_DAYS[number]

/** Anonymized fingerprint that scopes counts by machine / OS / keyboard. */
export interface TypingAnalyticsFingerprint {
  machineHash: string
  os: {
    platform: string
    release: string
    arch: string
  }
  keyboard: {
    uid: string
    vendorId: number
    productId: number
    productName: string
  }
}

/** Keyboard identification carried on each event so the main process can
 * resolve the scope without tracking the active device separately. */
export interface TypingAnalyticsKeyboard {
  uid: string
  vendorId: number
  productId: number
  productName: string
}

/** How a physical press resolved for masked (tap-hold style) keys. The
 * heatmap uses this to colour the outer (hold) and inner (tap) rects
 * independently. `undefined` is reserved for non-masked keys and for
 * release-edge data that the press-edge pipeline dispatches eagerly.*/
export type TypingMatrixAction = 'tap' | 'hold'

/** Partial event emitted by `useTypingTest` before the active keyboard is
 * attached. `useInputModes` wraps it into a full {@link TypingAnalyticsEvent}
 * before dispatching to the main process. */
export type TypingAnalyticsEventPayload =
  | { kind: 'char'; key: string; ts: number }
  | {
      kind: 'matrix'
      row: number
      col: number
      layer: number
      keycode: number
      ts: number
      /** Only set for masked keys (LT/MT/etc.) after the release edge
       * has been classified against TAPPING_TERM. Non-masked presses
       * and presses that have not yet seen a release leave this
       * undefined; the count still lands in the `count` total column. */
      action?: TypingMatrixAction
    }

/** Normalized analytics event carried over the IPC to the main process. */
export type TypingAnalyticsEvent = TypingAnalyticsEventPayload & {
  keyboard: TypingAnalyticsKeyboard
}

/** Summary of a keyboard that currently has typing analytics data
 * visible locally. Produced by the data-modal list API. */
export interface TypingKeyboardSummary {
  uid: string
  productName: string
  vendorId: number
  productId: number
}

/** Day-level aggregation of typing analytics data for a single keyboard,
 * summed across every scope (machine) sharing the uid. */
export interface TypingDailySummary {
  date: string
  keystrokes: number
  activeMs: number
}

/** Day-level inter-keystroke interval summary. The per-minute rows
 * already carry min/p25/p50/p75/max, and the aggregate picks the
 * envelope (min/max) plus the mean of the per-minute quartiles — an
 * approximation of the day's central tendency that is cheap to compute
 * on the existing schema. Days with no recorded intervals (e.g. only
 * a single keystroke per minute for the entire day) are omitted from
 * the result instead of returning all-`null` rows; the nullable field
 * types are kept broad for forward compatibility. */
export interface TypingIntervalDailySummary {
  date: string
  intervalMinMs: number | null
  intervalP25Ms: number | null
  intervalP50Ms: number | null
  intervalP75Ms: number | null
  intervalMaxMs: number | null
}

/** Keymap snapshot taken at record-start time. Stored per (uid,
 * machineHash) as a timestamped file so the Analyze key heatmap can
 * render the layout that was active for a given range. Writes are
 * skipped when the content matches the previous snapshot; the
 * timestamp only advances when something the heatmap cares about
 * actually changed. */
export interface TypingKeymapSnapshot {
  uid: string
  machineHash: string
  productName: string
  savedAt: number
  layers: number
  matrix: { rows: number; cols: number }
  /** `keymap[layer][row][col]` = serialized QMK id string (e.g.
   * `"KC_A"`, `"LT(0,KC_ESC)"`). The record-start side runs
   * `serialize(rawKeycode)` with the device's current context (vial
   * protocol version + layer count) so composite keycodes stay human
   * readable; the Analyze view can drop the label straight into
   * `KeyboardWidget` without re-resolving. */
  keymap: string[][][]
  /** Layout definition used to plot the grid. Shape mirrors the
   * subset of `KeyboardDefinition` the renderer needs to lay out
   * key widgets (labels, key positions). */
  layout: unknown
}

/** Metadata-only view of {@link TypingKeymapSnapshot}. Powers the
 * Analyze snapshot timeline — the heavy `keymap` / `layout` payloads
 * are omitted so the renderer only pays for what the tick markers
 * need. */
export interface TypingKeymapSnapshotSummary {
  uid: string
  machineHash: string
  productName: string
  savedAt: number
  layers: number
  matrix: { rows: number; cols: number }
}

/** Minute-level row returned by the Analyze fetch. The Analyze view
 * pulls minute-raw data and buckets it on the client so the SQL layer
 * doesn't have to know about a user-chosen bucket size. `keystrokes`
 * and `activeMs` are summed across every scope that contributed to
 * that minute; the interval columns carry the SQL MIN/AVG/MAX across
 * the contributing scopes and stay `null` when no scope recorded
 * intervals. */
export interface TypingMinuteStatsRow {
  minuteMs: number
  keystrokes: number
  activeMs: number
  intervalMinMs: number | null
  intervalP25Ms: number | null
  intervalP50Ms: number | null
  intervalP75Ms: number | null
  intervalMaxMs: number | null
}

/** One bucket of the Analyze activity heatmap (hour-of-day × day-of-week).
 * `dow` follows SQLite's `strftime('%w', ...)`: 0 = Sunday ... 6 =
 * Saturday. `hour` is local-time 0..23. `keystrokes` is the sum across
 * every scope the query kept in scope. */
export interface TypingActivityCell {
  dow: number
  hour: number
  keystrokes: number
}

/** One live row from `typing_sessions`, used by the Analyze session
 * distribution view. `id` is the stable session identifier; duration
 * is computed at the renderer as `endMs - startMs`. */
export interface TypingSessionRow {
  id: string
  startMs: number
  endMs: number
}

/** One bucket of the Analyze > Layer tab, showing how many keystrokes
 * were recorded while a given layer was the active one (so the value
 * reflects both how often the layer is reached AND how much was typed
 * once there). Sourced from `typing_matrix_minute` grouped by its
 * `layer` column — that column records the live-active layer at
 * press time, so it already reflects MO / LT / TG / etc. activations
 * without re-decoding keycodes. Layers with zero keystrokes in the
 * window are omitted; the renderer zero-fills against the current
 * snapshot's layer count. */
export interface TypingLayerUsageRow {
  layer: number
  keystrokes: number
}

/** Per-cell press totals for the Analyze > Layer activations view.
 * Aggregated across every machine hash (or scoped to one via the
 * `*ForHash` variant) and every minute in the window. The
 * renderer maps (layer, row, col) to `snapshot.keymap[layer][row][col]`
 * to recover the serialized QMK id, then dispatches layer-op keycodes
 * to their target layer via {@link getLayerOpTarget}. `count` is the
 * total press count for the cell; `tap` / `hold` split that total for
 * LT / LM keys (tap goes to the inner keycode, hold activates the
 * layer). Non-tap-hold keys leave tap/hold at 0. */
export interface TypingMatrixCellRow {
  layer: number
  row: number
  col: number
  count: number
  tap: number
  hold: number
}

/** Per-minute Backspace count aggregate used by the Analyze
 * error-proxy overlay. Sourced from `typing_matrix_minute` so every
 * path (matrix HID reads, typing-test, Vial input) contributes — not
 * just typing-test. Tap-hold keys (e.g. `LT(1, KC_BSPC)`) count only
 * their `tap_count` (actual Backspace taps); holds that mean a layer
 * activation are excluded. Total keystrokes for the ratio come from
 * the minute-stats fetch the WPM chart already runs, so this IPC
 * stays narrow. */
export interface TypingBksMinuteRow {
  minuteMs: number
  backspaceCount: number
}

/** Wire format for the Peak Records summary cards at the top of the
 * Analyze view. Each field is null when there is no data in the
 * queried range. Per-minute peaks come from typing_minute_stats;
 * per-day peaks roll up the same table by local calendar day;
 * longest session is the biggest duration from typing_sessions. */
export interface PeakRecords {
  peakWpm: { value: number; atMs: number } | null
  lowestWpm: { value: number; atMs: number } | null
  peakKeystrokesPerMin: { value: number; atMs: number } | null
  peakKeystrokesPerDay: { value: number; day: string } | null
  longestSession: { durationMs: number; startedAtMs: number } | null
}

/** One cell of the typing-view heatmap. `total` is the overall press
 * count for the cell; `tap` and `hold` are the portions of that total
 * that the release-edge classifier routed to the tap vs hold arm of
 * an LT/MT key. Non-tap-hold presses leave both at 0 and consumers
 * fall back to `total` as a single intensity. */
export interface TypingHeatmapCell {
  total: number
  tap: number
  hold: number
}

/** Wire format for the heatmap IPC. Keyed by `"row,col"` so the
 * renderer can plug it straight into KeyWidget without reshaping. */
export type TypingHeatmapByCell = Record<string, TypingHeatmapCell>

/** Row counts returned from a tombstone / delete-all call. The renderer
 * uses the total to decide whether to surface a "no rows changed" notice. */
export interface TypingTombstoneResult {
  charMinutes: number
  matrixMinutes: number
  minuteStats: number
  sessions: number
}

/** Build the canonical scope key from a fingerprint. Excludes productName
 * so that cross-OS descriptor variation doesn't fragment the same device. */
export function canonicalScopeKey(fp: TypingAnalyticsFingerprint): string {
  return [
    fp.machineHash,
    fp.os.platform,
    fp.os.release,
    fp.keyboard.uid,
    fp.keyboard.vendorId,
    fp.keyboard.productId,
  ].join('|')
}
