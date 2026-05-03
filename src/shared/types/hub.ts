// SPDX-License-Identifier: GPL-2.0-or-later
// Shared types for Hub upload operations

import type { FavoriteType } from './favorite-store'

export interface HubUploadPostParams {
  title: string
  keyboardName: string
  vilJson: string
  pipetteJson: string
  keymapC: string
  pdfBase64: string
  thumbnailBase64: string
}

export interface HubUploadResult {
  success: boolean
  postId?: string
  error?: string
}

export interface HubUpdatePostParams extends HubUploadPostParams {
  postId: string
}

export interface HubPatchPostParams {
  postId: string
  title: string
}

export interface HubDeleteResult {
  success: boolean
  error?: string
}

export interface HubPostFile {
  file_type: string
  original_filename: string
  file_size: number
}

export interface HubMyPost {
  id: string
  title: string
  keyboard_name: string
  description?: string | null
  created_at: string
  updated_at?: string
  uploaded_by?: string
  uploader_name?: string
  download_count?: number
  files?: HubPostFile[]
}

export interface HubPaginationMeta {
  total: number
  page: number
  per_page: number
  total_pages: number
}

export interface HubFetchMyPostsParams {
  page?: number
  per_page?: number
}

export interface HubFetchMyPostsResult {
  success: boolean
  posts?: HubMyPost[]
  pagination?: HubPaginationMeta
  error?: string
}

export type HubFetchMyKeyboardPostsResult = HubFetchMyPostsResult

export interface HubUser {
  id: string
  email: string
  display_name: string | null
  role: string
}

export const HUB_ERROR_DISPLAY_NAME_CONFLICT = 'DISPLAY_NAME_CONFLICT'
export const HUB_ERROR_ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED'
export const HUB_ERROR_RATE_LIMITED = 'RATE_LIMITED'

export interface HubUserResult {
  success: boolean
  user?: HubUser
  error?: string
}

export interface HubUploadFavoritePostParams {
  type: FavoriteType
  entryId: string
  title: string
  /** Vial protocol of the keyboard the entry was authored against. Written into the v3 export. */
  vialProtocol: number
}

export interface HubUpdateFavoritePostParams extends HubUploadFavoritePostParams {
  postId: string
}

// --- Analytics post types ---
//
// Wire format for "Analyze 集計データ" uploads. The full contract lives in
// `.claude/docs/HUB-ANALYTICS-API.md` (Hub agent's source of truth). The
// types below mirror that contract; the validators in
// `src/main/hub/hub-analytics.ts` enforce the runtime invariants.

/** Hub-side `analytics-export-v1.json` payload. */
export interface HubAnalyticsExportV1 {
  version: 1
  kind: 'analytics'
  exportedAt: string
  snapshot: HubAnalyticsSnapshot
  filters: HubAnalyticsFilters
  data: HubAnalyticsData
}

export interface HubAnalyticsSnapshot {
  keyboard: {
    uid: string
    productName: string
    vendorId: number
    productId: number
  }
  /** `'all'` / `'own'` / `{ kind: 'hash', machineHash }` — must match the
   * `DeviceScope` shape used by the Analyze panel. */
  deviceScope: 'all' | 'own' | { kind: 'hash'; machineHash: string }
  /** Snapshot of the active keymap at upload time. The exact shape is
   * `TypingKeymapSnapshot` (re-stated here so the Hub side does not
   * need to import the typing-analytics types directly). */
  keymapSnapshot: {
    savedAt: number
    productName: string
    layers: number
    matrix: { rows: number; cols: number }
    keymap: string[][][]
    layout: unknown
  }
  range: { fromMs: number; toMs: number }
  totalKeystrokes: number
  appScopes: string[]
}

/** Initial-value hints for the Hub's display controls. The Hub UI is
 * free to override every field — this is the value the desktop user
 * had selected when the post was uploaded. */
export interface HubAnalyticsFilters {
  analysisTab: string
  heatmap?: Record<string, unknown>
  wpm?: Record<string, unknown>
  interval?: Record<string, unknown>
  activity?: Record<string, unknown>
  layer?: Record<string, unknown>
  ergonomics?: Record<string, unknown>
  bigrams: { topLimit: 10; slowLimit: 10; fingerLimit: 20; pairIntervalThresholdMs?: number }
  layoutComparison?: Record<string, unknown>
  fingerOverrides?: Record<string, string>
}

/** Pre-aggregated chart data. Each array section is required; empty
 * arrays mean "no rows for this tab". Hub-side validators reject
 * missing keys with `<field> must be array`. */
export interface HubAnalyticsData {
  minuteStats: Array<{
    minuteMs: number
    keystrokes: number
    activeMs: number
    intervalMinMs: number | null
    intervalP25Ms: number | null
    intervalP50Ms: number | null
    intervalP75Ms: number | null
    intervalMaxMs: number | null
  }>
  matrixCells: Array<{ layer: number; row: number; col: number; count: number; tap: number; hold: number }>
  matrixCellsByDay: Array<{ dayMs: number; layer: number; row: number; col: number; count: number; tap: number; hold: number }>
  layerUsage: Array<{ layer: number; keystrokes: number }>
  sessions: Array<{ id: string; startMs: number; endMs: number }>
  bksMinute: Array<{ minuteMs: number; backspaceCount: number }>
  bigramTop: Array<{ bigramId: string; count: number; hist: number[]; avgIki: number | null }>
  bigramSlow: Array<{ bigramId: string; count: number; hist: number[]; avgIki: number | null; p95: number | null }>
  appUsage: Array<{ name: string; keystrokes: number; activeMs: number }>
  wpmByApp: Array<{ name: string; keystrokes: number; activeMs: number }>
  peakRecords: {
    peakWpm: { value: number; atMs: number } | null
    lowestWpm: { value: number; atMs: number } | null
    peakKeystrokesPerMin: { value: number; atMs: number } | null
    peakKeystrokesPerDay: { value: number; day: string } | null
    longestSession: { durationMs: number; startedAtMs: number } | null
  }
  layoutComparison: {
    sourceLayoutId: string
    targets: Array<{
      layoutId: string
      totalEvents: number
      skippedEvents: number
      skipRate: number
      fingerLoad?: Record<string, number>
      unmappedFinger?: number
      handBalance?: { left: number; right: number }
      rowDist?: Record<string, number>
      homeRowStay?: number
      cellCounts?: Record<string, number>
    }>
  } | null
}

/** Layout Comparison inputs the renderer pre-resolves from
 * `LAYOUT_BY_ID` / key-label-store before triggering the upload. Main
 * does not have access to the renderer-side keyboard layout catalog,
 * so we cross the IPC boundary with the resolved maps + KleKey
 * geometry already in hand. `null` skips the comparison entirely. */
export interface HubAnalyticsLayoutComparisonInputs {
  source: { id: string; map: Record<string, string> }
  target: { id: string; map: Record<string, string> }
  /** Subset of metrics the live chart computed; an empty array is fine
   * (Hub still gets totalEvents + skipRate). */
  metrics: string[]
  /** Pre-parsed KleKey geometry from `snapshot.layout`. The renderer
   * already has this for the live chart. Typed as `unknown[]` here so
   * the shared types module stays decoupled from KLE internals; the
   * main-side handler casts to `KleKey[]`. */
  kleKeys: unknown[]
  /** Layer to read source labels from. Defaults to 0 main-side. */
  layer?: number
}

/** Per-tab toggles the renderer ships with the upload IPC. Mirrors the
 * AnalyzeExportModal's category set so the user's "what to ship"
 * choice maps 1:1 between CSV export and Hub upload. Each entry is
 * the modal category id (`heatmap`, `wpm`, `interval`, `activity`,
 * `ergonomics`, `bigrams`, `layoutComparison`, `layer`). Sections not
 * in the set are skipped at fetch time and ship as empty arrays — the
 * Hub side already renders empty arrays as the per-tab empty state. */
export type HubAnalyticsCategoryId =
  | 'heatmap' | 'wpm' | 'interval' | 'activity'
  | 'ergonomics' | 'bigrams' | 'layoutComparison' | 'layer'

/** Renderer → main upload trigger. The handler reads the saved entry
 * from analyze-filter-store, builds the export, and uploads. The
 * renderer pre-fetches the inputs main can't reach (snapshot keyboard
 * meta, layout comparison maps, thumbnail capture, finger overrides)
 * and passes them in. */
export interface HubUploadAnalyticsPostParams {
  uid: string
  entryId: string
  title: string
  /** JPEG thumbnail base64 string. Same encoding the keymap upload
   * already uses. */
  thumbnailBase64: string
  /** Keyboard meta resolved from `typingAnalyticsListKeyboards()`. */
  keyboard: { productName: string; vendorId: number; productId: number }
  /** Per-cell finger assignments the live Ergonomics chart uses. The
   * renderer reads these from `pipetteSettingsGet(uid).analyze.
   * fingerAssignments` so the Hub upload mirrors the user's current
   * mapping. Empty / absent ships `{}`. */
  fingerOverrides: Record<string, string>
  /** Optional Layout Comparison inputs (`null` ships
   * `data.layoutComparison: null`). */
  layoutComparisonInputs: HubAnalyticsLayoutComparisonInputs | null
  /** User's category picks from the upload modal. Absent / undefined
   * ships every category (back-compat with the early build that did
   * not surface the picker). */
  categories?: HubAnalyticsCategoryId[]
}

export interface HubUpdateAnalyticsPostParams extends HubUploadAnalyticsPostParams {
  postId: string
}

/** Pre-flight payload for the upload dialog. Mirrors the upload
 * params minus the thumbnail (the dialog does not need to capture the
 * screenshot until the user confirms). */
export interface HubPreviewAnalyticsPostParams {
  uid: string
  entryId: string
  keyboard: { productName: string; vendorId: number; productId: number }
  fingerOverrides: Record<string, string>
  layoutComparisonInputs: HubAnalyticsLayoutComparisonInputs | null
}

/** Renderer-side preview shown before the user confirms the upload —
 * the dialog checks the validation and the byte size without paying
 * for the network round-trip. */
export interface HubAnalyticsPreview {
  totalKeystrokes: number
  rangeMs: number
  estimatedBytes: number
  validation:
    | { ok: true }
    | { ok: false; reason: string }
}
