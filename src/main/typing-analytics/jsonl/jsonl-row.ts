// SPDX-License-Identifier: GPL-2.0-or-later
// JSONL row format for the per-device typing-analytics master files. Each
// line is a single self-contained row with a composite id, a kind tag, the
// payload, and an updated_at timestamp. See .claude/plans/typing-analytics.md
// for the design rationale (JSONL master + SQLite cache).

export const JSONL_SCHEMA_VERSION = 1

/** Active-application name attached to per-minute payloads. Resolved at
 * flush time from the OS focus state; null when Monitor App was off,
 * the lookup failed, or the minute observed a mix of apps (the
 * aggregator collapses size>1 sets to null so app-filtered analytics
 * always look at single-app minutes only). Optional on the wire for
 * backward compatibility with v7 master files written before this
 * field existed. */
export type AppNameField = string | null

export type JsonlRowKind =
  | 'scope'
  | 'char-minute'
  | 'matrix-minute'
  | 'minute-stats'
  | 'session'
  | 'bigram-minute'

export interface JsonlScopePayload {
  id: string
  machineHash: string
  osPlatform: string
  osRelease: string
  osArch: string
  keyboardUid: string
  keyboardVendorId: number
  keyboardProductId: number
  keyboardProductName: string
}

export interface JsonlCharMinutePayload {
  scopeId: string
  minuteTs: number
  char: string
  count: number
  appName?: AppNameField
}

export interface JsonlMatrixMinutePayload {
  scopeId: string
  minuteTs: number
  row: number
  col: number
  layer: number
  keycode: number
  count: number
  tapCount: number
  holdCount: number
  appName?: AppNameField
}

export interface JsonlMinuteStatsPayload {
  scopeId: string
  minuteTs: number
  keystrokes: number
  activeMs: number
  intervalAvgMs: number | null
  intervalMinMs: number | null
  intervalP25Ms: number | null
  intervalP50Ms: number | null
  intervalP75Ms: number | null
  intervalMaxMs: number | null
  appName?: AppNameField
}

export interface JsonlSessionPayload {
  id: string
  scopeId: string
  startMs: number
  endMs: number
}

/** Per-bigram aggregate within a single minute. `c` = count of pair
 * occurrences. `h` = 8-bucket IKI histogram (log-scale buckets, see
 * Plan-analyze-bigram.md). */
export interface JsonlBigramMinuteEntry {
  c: number
  h: number[]
}

export interface JsonlBigramMinutePayload {
  scopeId: string
  minuteTs: number
  /** Pair key format: `${prevKeycode}_${currKeycode}` (numeric keycodes
   * joined by underscore). One row per minute aggregates all bigrams. */
  bigrams: Record<string, JsonlBigramMinuteEntry>
  appName?: AppNameField
}

/** Number of buckets in the bigram IKI histogram. Kept as a constant so
 * writer / reader / cache layers stay in sync if the bucketing changes. */
export const BIGRAM_HIST_BUCKETS = 8

interface JsonlRowBase {
  id: string
  updated_at: number
  is_deleted?: boolean
}

export interface JsonlScopeRow extends JsonlRowBase {
  kind: 'scope'
  payload: JsonlScopePayload
}

export interface JsonlCharMinuteRow extends JsonlRowBase {
  kind: 'char-minute'
  payload: JsonlCharMinutePayload
}

export interface JsonlMatrixMinuteRow extends JsonlRowBase {
  kind: 'matrix-minute'
  payload: JsonlMatrixMinutePayload
}

export interface JsonlMinuteStatsRow extends JsonlRowBase {
  kind: 'minute-stats'
  payload: JsonlMinuteStatsPayload
}

export interface JsonlSessionRow extends JsonlRowBase {
  kind: 'session'
  payload: JsonlSessionPayload
}

export interface JsonlBigramMinuteRow extends JsonlRowBase {
  kind: 'bigram-minute'
  payload: JsonlBigramMinutePayload
}

export type JsonlRow =
  | JsonlScopeRow
  | JsonlCharMinuteRow
  | JsonlMatrixMinuteRow
  | JsonlMinuteStatsRow
  | JsonlSessionRow
  | JsonlBigramMinuteRow

const KNOWN_KINDS: ReadonlySet<string> = new Set<JsonlRowKind>([
  'scope',
  'char-minute',
  'matrix-minute',
  'minute-stats',
  'session',
  'bigram-minute',
])

function enc(value: string | number): string {
  return encodeURIComponent(String(value))
}

export function scopeRowId(scopeId: string): string {
  return `scope|${enc(scopeId)}`
}

export function charMinuteRowId(scopeId: string, minuteTs: number, char: string): string {
  return `char|${enc(scopeId)}|${minuteTs}|${enc(char)}`
}

export function matrixMinuteRowId(
  scopeId: string,
  minuteTs: number,
  row: number,
  col: number,
  layer: number,
): string {
  return `matrix|${enc(scopeId)}|${minuteTs}|${row}|${col}|${layer}`
}

export function minuteStatsRowId(scopeId: string, minuteTs: number): string {
  return `stats|${enc(scopeId)}|${minuteTs}`
}

export function sessionRowId(sessionId: string): string {
  return `session|${enc(sessionId)}`
}

export function bigramMinuteRowId(scopeId: string, minuteTs: number): string {
  return `bigram|${enc(scopeId)}|${minuteTs}`
}

/** Serialize a single row as a newline-terminated JSON line. */
export function serializeRow(row: JsonlRow): string {
  return JSON.stringify(row) + '\n'
}

function isKnownKind(value: unknown): value is JsonlRowKind {
  return typeof value === 'string' && KNOWN_KINDS.has(value)
}

function hasStringField(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === 'string'
}

function hasNumberField(obj: Record<string, unknown>, key: string): boolean {
  return typeof obj[key] === 'number' && Number.isFinite(obj[key])
}

function isScopePayload(p: Record<string, unknown>): boolean {
  return (
    hasStringField(p, 'id') &&
    hasStringField(p, 'machineHash') &&
    hasStringField(p, 'osPlatform') &&
    hasStringField(p, 'osRelease') &&
    hasStringField(p, 'osArch') &&
    hasStringField(p, 'keyboardUid') &&
    hasNumberField(p, 'keyboardVendorId') &&
    hasNumberField(p, 'keyboardProductId') &&
    hasStringField(p, 'keyboardProductName')
  )
}

function isCharMinutePayload(p: Record<string, unknown>): boolean {
  return (
    hasStringField(p, 'scopeId') &&
    hasNumberField(p, 'minuteTs') &&
    hasStringField(p, 'char') &&
    hasNumberField(p, 'count') &&
    isOptionalAppName(p)
  )
}

function isMatrixMinutePayload(p: Record<string, unknown>): boolean {
  return (
    hasStringField(p, 'scopeId') &&
    hasNumberField(p, 'minuteTs') &&
    hasNumberField(p, 'row') &&
    hasNumberField(p, 'col') &&
    hasNumberField(p, 'layer') &&
    hasNumberField(p, 'keycode') &&
    hasNumberField(p, 'count') &&
    hasNumberField(p, 'tapCount') &&
    hasNumberField(p, 'holdCount') &&
    isOptionalAppName(p)
  )
}

function isNumericOrNull(p: Record<string, unknown>, key: string): boolean {
  const value = p[key]
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** appName is optional on the wire (v7 master files predate it). When
 * present it must be string | null; missing is treated the same as
 * null on read. Anything else (number, object, etc.) rejects the row. */
function isOptionalAppName(p: Record<string, unknown>): boolean {
  if (!('appName' in p)) return true
  const v = p.appName
  return v === null || typeof v === 'string'
}

function isMinuteStatsPayload(p: Record<string, unknown>): boolean {
  return (
    hasStringField(p, 'scopeId') &&
    hasNumberField(p, 'minuteTs') &&
    hasNumberField(p, 'keystrokes') &&
    hasNumberField(p, 'activeMs') &&
    isNumericOrNull(p, 'intervalAvgMs') &&
    isNumericOrNull(p, 'intervalMinMs') &&
    isNumericOrNull(p, 'intervalP25Ms') &&
    isNumericOrNull(p, 'intervalP50Ms') &&
    isNumericOrNull(p, 'intervalP75Ms') &&
    isNumericOrNull(p, 'intervalMaxMs') &&
    isOptionalAppName(p)
  )
}

function isSessionPayload(p: Record<string, unknown>): boolean {
  return (
    hasStringField(p, 'id') &&
    hasStringField(p, 'scopeId') &&
    hasNumberField(p, 'startMs') &&
    hasNumberField(p, 'endMs')
  )
}

function isBigramHist(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== BIGRAM_HIST_BUCKETS) return false
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false
  }
  return true
}

function isBigramMinuteEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.c === 'number' && Number.isFinite(o.c) && isBigramHist(o.h)
}

function isBigramMinutePayload(p: Record<string, unknown>): boolean {
  if (!hasStringField(p, 'scopeId') || !hasNumberField(p, 'minuteTs')) return false
  if (!isOptionalAppName(p)) return false
  const bigrams = p.bigrams
  if (typeof bigrams !== 'object' || bigrams === null) return false
  for (const value of Object.values(bigrams as Record<string, unknown>)) {
    if (!isBigramMinuteEntry(value)) return false
  }
  return true
}

/** Parse one JSONL line into a typed row. Returns `null` for malformed
 * JSON, missing required fields, or unknown row kinds so readers can skip
 * bad lines without aborting the whole file. */
export function parseRow(line: string): JsonlRow | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (!hasStringField(obj, 'id')) return null
  if (!isKnownKind(obj.kind)) return null
  if (!hasNumberField(obj, 'updated_at')) return null
  if ('is_deleted' in obj && typeof obj.is_deleted !== 'boolean') return null
  const payload = obj.payload
  if (typeof payload !== 'object' || payload === null) return null
  const payloadObj = payload as Record<string, unknown>

  switch (obj.kind) {
    case 'scope':
      if (!isScopePayload(payloadObj)) return null
      break
    case 'char-minute':
      if (!isCharMinutePayload(payloadObj)) return null
      break
    case 'matrix-minute':
      if (!isMatrixMinutePayload(payloadObj)) return null
      break
    case 'minute-stats':
      if (!isMinuteStatsPayload(payloadObj)) return null
      break
    case 'session':
      if (!isSessionPayload(payloadObj)) return null
      break
    case 'bigram-minute':
      if (!isBigramMinutePayload(payloadObj)) return null
      break
  }

  return obj as unknown as JsonlRow
}
