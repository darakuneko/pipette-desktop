// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics shared types — see .claude/plans/typing-analytics.md.

import type { FingerType, RowCategory } from '../kle/kle-ergonomics'

export const TYPING_ANALYTICS_REV = 1
export const TYPING_ANALYTICS_VERSION = 1

/** Sentinel name returned by Monitor App aggregates for minutes that
 * have NULL app_name (Monitor App off, lookup failed, or mixed apps).
 * Shared between the SQL COALESCE and the chart-side label mapping so
 * the two sides can't drift. */
export const TYPING_APP_UNKNOWN_NAME = '__unknown__'

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

/** Compact per-device record used to label scopes in the Analyze
 * Device filter. Carries the bits needed to render a human-readable
 * "{platform} - {release} ({hash})" entry without leaking the full
 * fingerprint structure to the renderer. */
export interface TypingAnalyticsDeviceInfo {
  machineHash: string
  osPlatform: string
  osRelease: string
}

/** Bundle returned by `typingAnalyticsListDeviceInfos`. `own` is built
 * from the local OS module + machineHash so the Device filter can
 * label the local entry even before the first event has been
 * persisted to typing_scopes. */
export interface TypingAnalyticsDeviceInfoBundle {
  own: TypingAnalyticsDeviceInfo
  remotes: readonly TypingAnalyticsDeviceInfo[]
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

/** Per-(localDay, layer, row, col) press totals for the Analyze
 * Ergonomic Learning Curve view. The renderer buckets these by week
 * / month and folds each bucket into ergonomic sub-scores (finger
 * load deviation / hand balance / home row stay). `dayMs` is the
 * local-midnight epoch in milliseconds; SQL groups by
 * `strftime('%Y-%m-%d', …, 'localtime')` so day boundaries align with
 * the user's wall clock and match the existing daily summary IPCs. */
export interface TypingMatrixCellDailyRow {
  dayMs: number
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

/** Sub-view requested from the bigram aggregate IPC. `top` ranks by
 * occurrence count; `slow` ranks by avg IKI with a min-sample filter
 * to suppress single-event outliers. The remaining views (`fingerIki`,
 * `heatmap`) are reserved for future expansion alongside their UI
 * surfaces and are not yet implemented at the IPC layer. */
export type TypingBigramAggregateView = 'top' | 'slow'

export interface TypingBigramAggregateOptions {
  /** Minimum pair count to be included. Used by `slow` to drop outliers
   * caused by a single late press. Ignored by `top`. */
  minSampleCount?: number
  /** Maximum number of pairs returned. Defaults to 30 at the handler
   * level if absent. */
  limit?: number
}

/** Per-pair entry in a `top` view response. `avgIki` is null when the
 * pair has no recorded IKI samples (count = 0 — usually filtered
 * upstream but kept defensive). */
export interface TypingBigramTopEntry {
  bigramId: string
  count: number
  hist: number[]
  avgIki: number | null
}

/** Per-pair entry in a `slow` view response. Adds `p95` so the UI can
 * show "occasionally very slow" pairs distinctly from "consistently
 * slow" pairs. */
export interface TypingBigramSlowEntry extends TypingBigramTopEntry {
  p95: number | null
}

/** Discriminated result for the bigram aggregate IPC. The view tag
 * matches the request so the renderer can narrow without inspecting
 * fields. */
export type TypingBigramAggregateResult =
  | { view: 'top'; entries: TypingBigramTopEntry[] }
  | { view: 'slow'; entries: TypingBigramSlowEntry[] }

/** Phase 1 metrics for the Layout Comparison. Bigram-derived ones
 * (travel distance / SFB) are added in Phase 2. */
export type LayoutComparisonMetric =
  | 'fingerLoad'
  | 'handBalance'
  | 'rowDist'
  | 'homeRow'

// Aliased to the geometry-side unions so adding a new finger or row
// category in `shared/kle/kle-ergonomics.ts` automatically widens the
// optimizer result shape — re-exporting prevents drift between the
// two modules.
export type LayoutComparisonFingerKey = FingerType
export type LayoutComparisonRowKey = RowCategory

/** A target / source layout shape sent over IPC. The renderer holds
 * `KEYBOARD_LAYOUTS` and forwards just the `id` and `map` slice the
 * resolver needs, so the main process stays data-agnostic. */
export interface LayoutComparisonInputLayout {
  id: string
  map: Record<string, string>
}

export interface LayoutComparisonOptions {
  source: LayoutComparisonInputLayout
  /** 1〜3 layouts in Phase 1; UI guard but main accepts any length. */
  targets: LayoutComparisonInputLayout[]
  /** Subset of metrics to compute. Empty array yields just the
   * total / skipped event counts. */
  metrics: LayoutComparisonMetric[]
}

export interface LayoutComparisonTargetResult {
  layoutId: string
  /** Events whose source-layout char resolved AND landed on a target
   * physical position. */
  totalEvents: number
  /** Events the resolver could not place (no source char, no target
   * char, or no target position on this snapshot). */
  skippedEvents: number
  /** skippedEvents / (totalEvents + skippedEvents); 0 when both are 0. */
  skipRate: number
  /** Each finger's share of `totalEvents`. Sum ≤ 1 (entries with no
   * geometry-derived finger fall through `unmappedFinger`). */
  fingerLoad?: Partial<Record<LayoutComparisonFingerKey, number>>
  unmappedFinger?: number
  /** Left/right share of `totalEvents`. */
  handBalance?: { left: number; right: number }
  /** number / top / home / bottom / thumb / function share of
   * `totalEvents`. */
  rowDist?: Partial<Record<LayoutComparisonRowKey, number>>
  /** Share of `totalEvents` whose target row is the home row. */
  homeRowStay?: number
  /** posKey → events whose source-pos resolved to this target physical
   * position. Always populated (independent of `metrics`) because the
   * Heatmap Diff sub-view consumes it without paying a separate IPC
   * round-trip; the renderer derives the diff from the entries. */
  cellCounts?: Record<string, number>
}

export interface LayoutComparisonResult {
  sourceLayoutId: string
  targets: LayoutComparisonTargetResult[]
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
