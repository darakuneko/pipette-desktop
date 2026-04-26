// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard Analyze-tab filter settings (persisted via PipetteSettings).
// Literal unions live here so both the main-process validator and the
// renderer hook can depend on a single source of truth without the
// shared -> renderer direction the codebase forbids.

/** Static "all-hash" options. Dynamic per-hash selections live under
 * `HashDeviceScope` — the select UI mixes both. Keep this export name
 * so callers that iterate the built-in choices (`DEVICE_SCOPES.map`)
 * keep working without knowing about hash scopes. */
export const DEVICE_SCOPES = ['own', 'all'] as const
export type StaticDeviceScope = typeof DEVICE_SCOPES[number]

/** Individual remote machine-hash scope — picked from the Device
 * select when a user has data from another machine synced in. */
export interface HashDeviceScope {
  kind: 'hash'
  machineHash: string
}

export type DeviceScope = StaticDeviceScope | HashDeviceScope

export function isOwnScope(scope: DeviceScope): scope is 'own' {
  return scope === 'own'
}

export function isAllScope(scope: DeviceScope): scope is 'all' {
  return scope === 'all'
}

export function isHashScope(scope: DeviceScope): scope is HashDeviceScope {
  return typeof scope === 'object' && scope !== null && scope.kind === 'hash'
}

/** IPC boundary parser. Returns `null` for anything that isn't a
 * valid `DeviceScope` so main-side handlers can reject cleanly. */
export function parseDeviceScope(value: unknown): DeviceScope | null {
  if (value === 'own' || value === 'all') return value
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    if (
      o.kind === 'hash' &&
      typeof o.machineHash === 'string' &&
      o.machineHash.length > 0
    ) {
      return { kind: 'hash', machineHash: o.machineHash }
    }
  }
  return null
}

const HASH_SELECT_PREFIX = 'hash:'

/** `<select value>` serialiser. Static scopes round-trip as-is;
 * hash scopes are encoded as `'hash:<machineHash>'`. */
export function scopeToSelectValue(scope: DeviceScope): string {
  return isHashScope(scope) ? `${HASH_SELECT_PREFIX}${scope.machineHash}` : scope
}

/** Inverse of `scopeToSelectValue`. Returns `null` for unknown values
 * (e.g. stale option values after the remote hash list changed). */
export function scopeFromSelectValue(value: string): DeviceScope | null {
  if (value === 'own' || value === 'all') return value
  if (value.startsWith(HASH_SELECT_PREFIX)) {
    const hash = value.slice(HASH_SELECT_PREFIX.length)
    return hash.length > 0 ? { kind: 'hash', machineHash: hash } : null
  }
  return null
}

/** Cap on the Device filter. Held at 1 — Analyze charts each show a
 * single device's data; the array shape is kept (rather than a single
 * `DeviceScope`) to preserve the persisted filter format and the
 * `normalizeDeviceScopes` dedup / `'all'`-exclusivity invariants. */
export const MAX_DEVICE_SCOPES = 1

/** First entry of a (post-normalization) device-scope tuple, used as
 * the "primary" device by single-series charts and primary-only
 * summary cards. Falls back to `'own'` for the empty-array edge case
 * — the normalizer keeps that from happening in practice, but the
 * default keeps callers honest if they ever skip it. */
export function primaryDeviceScope(scopes: readonly DeviceScope[]): DeviceScope {
  return scopes[0] ?? 'own'
}

/** Shallow compare two scope tuples by select-value identity. Cheap
 * for the single-entry tuples the Device filter produces; lets the
 * setter avoid re-rendering when a normalized array matches the
 * previous one (e.g. user re-clicking an already-selected option). */
export function deviceScopesEqual(
  a: readonly DeviceScope[],
  b: readonly DeviceScope[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (scopeToSelectValue(a[i]) !== scopeToSelectValue(b[i])) return false
  }
  return true
}

/** Coerce raw scope arrays into the canonical shape the Analyze panel
 * relies on: at least one entry, deduped by select-value, `'all'` is
 * exclusive (drops siblings when picked), and the result never exceeds
 * `MAX_DEVICE_SCOPES`. UI / setter / validator all funnel through here
 * so the three layers can't drift apart. */
export function normalizeDeviceScopes(input: readonly DeviceScope[] | null | undefined): DeviceScope[] {
  if (!Array.isArray(input) || input.length === 0) {
    return ['own']
  }
  const seen = new Set<string>()
  const unique: DeviceScope[] = []
  for (const scope of input) {
    const key = scopeToSelectValue(scope)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(scope)
  }
  if (unique.some(isAllScope)) return ['all']
  return unique.slice(0, MAX_DEVICE_SCOPES)
}

export const HEATMAP_NORMALIZATIONS = ['absolute', 'perHour', 'shareOfTotal'] as const
export type HeatmapNormalization = typeof HEATMAP_NORMALIZATIONS[number]

export const AGGREGATE_MODES = ['cell', 'char'] as const
export type AggregateMode = typeof AGGREGATE_MODES[number]

export const KEY_GROUPS = ['all', 'char', 'modifier', 'layerOp'] as const
export type KeyGroupFilter = typeof KEY_GROUPS[number]

export const WPM_VIEW_MODES = ['timeSeries', 'timeOfDay'] as const
export type WpmViewMode = typeof WPM_VIEW_MODES[number]

export const INTERVAL_UNITS = ['sec', 'ms'] as const
export type IntervalUnit = typeof INTERVAL_UNITS[number]

export const INTERVAL_VIEW_MODES = ['timeSeries', 'distribution'] as const
export type IntervalViewMode = typeof INTERVAL_VIEW_MODES[number]

export const ACTIVITY_METRICS = ['keystrokes', 'wpm', 'sessions'] as const
export type ActivityMetric = typeof ACTIVITY_METRICS[number]

export const LAYER_VIEW_MODES = ['keystrokes', 'activations'] as const
export type LayerViewMode = typeof LAYER_VIEW_MODES[number]

export const BIGRAM_VIEWS = ['top', 'slow'] as const
export type BigramView = typeof BIGRAM_VIEWS[number]

/** `'auto'` hands the bucket decision to `pickBucketMs`; a positive
 * integer overrides it (must be one of the allowed `GRANULARITIES`
 * entries but the store only validates shape — drift is rejected on
 * read-back by the chart's select fallback). */
export type GranularityChoice = 'auto' | number

export interface HeatmapFilters {
  selectedLayers?: number[]
  groups?: number[][]
  frequentUsedN?: number
  aggregateMode?: AggregateMode
  normalization?: HeatmapNormalization
  keyGroupFilter?: KeyGroupFilter
}

export interface WpmFilters {
  viewMode?: WpmViewMode
  minActiveMs?: number
  granularity?: GranularityChoice
}

/** Interval tab shares `WpmFilters.granularity` with the WPM tab —
 * the filter row control is the same select and the two view-modes
 * always lock-step on edit, so persisting a second copy would just
 * invite drift. */
export interface IntervalFilters {
  unit?: IntervalUnit
  viewMode?: IntervalViewMode
}

export interface ActivityFilters {
  metric?: ActivityMetric
}

export interface LayerFilters {
  viewMode?: LayerViewMode
  baseLayer?: number
}

export interface BigramFilters {
  view?: BigramView
  /** Min sample threshold for the Slow view. Top view ignores this. */
  minSample?: number
}

/** Per-keyboard Analyze filter state. `range` is intentionally absent —
 * it lives as renderer-local state (default 7 days) so the absolute
 * `fromMs` / `toMs` never get restored and make the view look stale.
 *
 * `deviceScopes` is held as an array (capped at `MAX_DEVICE_SCOPES = 1`)
 * rather than a single `DeviceScope` so the persisted filter shape and
 * `normalizeDeviceScopes` invariants stay stable. The persisted shape
 * always goes through `normalizeDeviceScopes` so dedup, the `'all'`
 * exclusivity rule, and the cap can't drift between caller, persister,
 * and reader. */
export interface AnalyzeFilterSettings {
  deviceScopes?: DeviceScope[]
  heatmap?: HeatmapFilters
  wpm?: WpmFilters
  interval?: IntervalFilters
  activity?: ActivityFilters
  layer?: LayerFilters
  bigrams?: BigramFilters
}

/** Shared primitive guards. Exported so the main-process store
 * validator can reuse them instead of re-defining its own copy. */
export function includesAs<T extends string>(arr: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (arr as readonly string[]).includes(v)
}

export function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

export function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1
}

function isGranularity(v: unknown): v is GranularityChoice {
  if (v === 'auto') return true
  return isPositiveInt(v)
}

function isLayerArray(v: unknown): v is number[] {
  if (!Array.isArray(v)) return false
  return v.every((n) => isNonNegativeInt(n))
}

function isLayerGroups(v: unknown): v is number[][] {
  if (!Array.isArray(v)) return false
  return v.every(isLayerArray)
}

function isValidHeatmapFilters(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.selectedLayers !== undefined && !isLayerArray(o.selectedLayers)) return false
  if (o.groups !== undefined && !isLayerGroups(o.groups)) return false
  if (o.frequentUsedN !== undefined && !isPositiveInt(o.frequentUsedN)) return false
  if (o.aggregateMode !== undefined && !includesAs(AGGREGATE_MODES, o.aggregateMode)) return false
  if (o.normalization !== undefined && !includesAs(HEATMAP_NORMALIZATIONS, o.normalization)) return false
  if (o.keyGroupFilter !== undefined && !includesAs(KEY_GROUPS, o.keyGroupFilter)) return false
  return true
}

function isValidWpmFilters(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.viewMode !== undefined && !includesAs(WPM_VIEW_MODES, o.viewMode)) return false
  if (o.minActiveMs !== undefined && !isPositiveInt(o.minActiveMs)) return false
  if (o.granularity !== undefined && !isGranularity(o.granularity)) return false
  return true
}

function isValidIntervalFilters(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.unit !== undefined && !includesAs(INTERVAL_UNITS, o.unit)) return false
  if (o.viewMode !== undefined && !includesAs(INTERVAL_VIEW_MODES, o.viewMode)) return false
  return true
}

function isValidActivityFilters(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.metric !== undefined && !includesAs(ACTIVITY_METRICS, o.metric)) return false
  return true
}

function isValidLayerFilters(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.viewMode !== undefined && !includesAs(LAYER_VIEW_MODES, o.viewMode)) return false
  if (o.baseLayer !== undefined && !isNonNegativeInt(o.baseLayer)) return false
  return true
}

function isValidBigramFilters(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.view !== undefined && !includesAs(BIGRAM_VIEWS, o.view)) return false
  if (o.minSample !== undefined && !isPositiveInt(o.minSample)) return false
  return true
}

/** Validates the persisted multi-select shape. Anything that survives
 * here is already in the form `normalizeDeviceScopes` would produce —
 * reject malformed data outright instead of silently reshaping it so
 * a downstream consumer can't accidentally rely on the old single-
 * scope shape. */
function isValidDeviceScopesArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  if (value.length === 0 || value.length > MAX_DEVICE_SCOPES) return false
  const parsed: DeviceScope[] = []
  for (const entry of value) {
    const scope = parseDeviceScope(entry)
    if (scope === null) return false
    parsed.push(scope)
  }
  // `'all'` is exclusive — combined with anything else it would mean
  // "all-devices aggregate plus a strict subset of all-devices", which
  // makes no sense in either UI or chart terms.
  if (parsed.some(isAllScope) && parsed.length !== 1) return false
  // Dedup check by select-value identity matches the normalizer's rule.
  const seen = new Set<string>()
  for (const scope of parsed) {
    const key = scopeToSelectValue(scope)
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

export function isValidAnalyzeFilterSettings(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.deviceScopes !== undefined && !isValidDeviceScopesArray(o.deviceScopes)) return false
  if (!isValidHeatmapFilters(o.heatmap)) return false
  if (!isValidWpmFilters(o.wpm)) return false
  if (!isValidIntervalFilters(o.interval)) return false
  if (!isValidActivityFilters(o.activity)) return false
  if (!isValidLayerFilters(o.layer)) return false
  if (!isValidBigramFilters(o.bigrams)) return false
  return true
}
