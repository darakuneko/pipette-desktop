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
 * backward compatibility with master files written before this field
 * existed. */
export type AppNameField = string | null

/** Typing test label attached to per-minute payloads (custom = text name,
 * normal = `mode (language)`). null / absent for ordinary REC input or a
 * minute that mixed multiple tests. Optional on the wire for backward
 * compatibility with master files written before this field existed. */
export type TypingTestField = string | null

/** Individual test run id attached to per-minute payloads. '' for
 * non-test (REC) input; a uuid for a specific run. Unlike appName /
 * typingTest this is part of the row's identity (it's in the SQLite
 * primary key) so two runs in one minute stay distinct. Optional on the
 * wire for backward compatibility — absent rows read back as ''. */
export type RunIdField = string

export type JsonlRowKind =
  | 'scope'
  | 'char-minute'
  | 'matrix-minute'
  | 'minute-stats'
  | 'session'
  | 'bigram-minute'
  | 'trigram-minute'

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
  typingTest?: TypingTestField
  runId?: RunIdField
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
  typingTest?: TypingTestField
  runId?: RunIdField
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
  typingTest?: TypingTestField
  runId?: RunIdField
}

export interface JsonlSessionPayload {
  id: string
  scopeId: string
  startMs: number
  endMs: number
}

/** Per-bigram aggregate within a single minute. `c` = count of pair
 * occurrences. `h` = 8-bucket IKI histogram (log-scale buckets, see
 * Plan-analyze-bigram.md). `s` / `sq` are the sum and sum-of-squares of
 * the raw IKI values that fed `h`, kept alongside the histogram so a
 * range aggregate can compute a true standard deviation instead of a
 * bucket-midpoint approximation. Optional and always a pair: rows
 * written before this field existed (or merged from an older peer)
 * omit both, and SD then reads as null rather than an approximation —
 * see isBigramMinuteEntry / isNgramMinuteEntry. */
export interface JsonlBigramMinuteEntry {
  c: number
  h: number[]
  s?: number
  sq?: number
}

export interface JsonlBigramMinutePayload {
  scopeId: string
  minuteTs: number
  /** Pair key format: `${prevKeycode}_${currKeycode}` (numeric keycodes
   * joined by underscore). One row per minute aggregates all bigrams. */
  bigrams: Record<string, JsonlBigramMinuteEntry>
  appName?: AppNameField
  typingTest?: TypingTestField
  runId?: RunIdField
}

/** Per-trigram aggregate within a single minute. Same shape as
 * {@link JsonlBigramMinuteEntry} (count / histogram / optional sum
 * pair) — trigram IKI values are already the 2-interval average by the
 * time they reach this layer (see MinuteBuffer.recordTrigram), so the
 * same histogram bucketing and sum/sumSq accumulation apply unchanged. */
export type JsonlTrigramMinuteEntry = JsonlBigramMinuteEntry

export interface JsonlTrigramMinutePayload {
  scopeId: string
  minuteTs: number
  /** Triple key format: `${k1}_${k2}_${k3}` (numeric keycodes joined by
   * underscore). One row per minute aggregates all trigrams. */
  trigrams: Record<string, JsonlTrigramMinuteEntry>
  appName?: AppNameField
  typingTest?: TypingTestField
  runId?: RunIdField
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

export interface JsonlTrigramMinuteRow extends JsonlRowBase {
  kind: 'trigram-minute'
  payload: JsonlTrigramMinutePayload
}

export type JsonlRow =
  | JsonlScopeRow
  | JsonlCharMinuteRow
  | JsonlMatrixMinuteRow
  | JsonlMinuteStatsRow
  | JsonlSessionRow
  | JsonlBigramMinuteRow
  | JsonlTrigramMinuteRow

const KNOWN_KINDS: ReadonlySet<string> = new Set<JsonlRowKind>([
  'scope',
  'char-minute',
  'matrix-minute',
  'minute-stats',
  'session',
  'bigram-minute',
  'trigram-minute',
])

function enc(value: string | number): string {
  return encodeURIComponent(String(value))
}

export function scopeRowId(scopeId: string): string {
  return `scope|${enc(scopeId)}`
}

// runId joins the per-minute row ids so two runs sharing a wall-clock
// minute stay distinct lines in the append log (it's part of the SQLite
// primary key too). '' is the non-test bucket; rows written before run
// tagging used the same id without the run segment, but the cache rebuild
// keys off the payload, not the id, so old files still merge correctly.
export function charMinuteRowId(scopeId: string, minuteTs: number, runId: string, char: string): string {
  return `char|${enc(scopeId)}|${minuteTs}|${enc(runId)}|${enc(char)}`
}

export function matrixMinuteRowId(
  scopeId: string,
  minuteTs: number,
  runId: string,
  row: number,
  col: number,
  layer: number,
): string {
  return `matrix|${enc(scopeId)}|${minuteTs}|${enc(runId)}|${row}|${col}|${layer}`
}

export function minuteStatsRowId(scopeId: string, minuteTs: number, runId: string): string {
  return `stats|${enc(scopeId)}|${minuteTs}|${enc(runId)}`
}

export function sessionRowId(sessionId: string): string {
  return `session|${enc(sessionId)}`
}

export function bigramMinuteRowId(scopeId: string, minuteTs: number, runId: string): string {
  return `bigram|${enc(scopeId)}|${minuteTs}|${enc(runId)}`
}

export function trigramMinuteRowId(scopeId: string, minuteTs: number, runId: string): string {
  return `trigram|${enc(scopeId)}|${minuteTs}|${enc(runId)}`
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
    isOptionalAppName(p) &&
    isOptionalTypingTest(p) &&
    isOptionalRunId(p)
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
    isOptionalAppName(p) &&
    isOptionalTypingTest(p) &&
    isOptionalRunId(p)
  )
}

function isNumericOrNull(p: Record<string, unknown>, key: string): boolean {
  const value = p[key]
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** appName is optional on the wire (master files written before the
 * field was added omit it). When present it must be string | null;
 * missing is treated the same as null on read. Anything else (number,
 * object, etc.) rejects the row. */
function isOptionalAppName(p: Record<string, unknown>): boolean {
  if (!('appName' in p)) return true
  const v = p.appName
  return v === null || typeof v === 'string'
}

/** Same optional string|null contract as {@link isOptionalAppName}, for the
 * typing-test dimension. Missing reads as null. */
function isOptionalTypingTest(p: Record<string, unknown>): boolean {
  if (!('typingTest' in p)) return true
  const v = p.typingTest
  return v === null || typeof v === 'string'
}

/** runId is optional on the wire (rows written before run tagging omit
 * it; they read back as ''). When present it must be a string — '' for
 * non-test input or a run uuid. */
function isOptionalRunId(p: Record<string, unknown>): boolean {
  if (!('runId' in p)) return true
  return typeof p.runId === 'string'
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
    isOptionalAppName(p) &&
    isOptionalTypingTest(p) &&
    isOptionalRunId(p)
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

/** `s` / `sq` are optional but must appear as a pair: both absent is a
 * legacy row (valid), both present must be finite numbers, and exactly
 * one present is malformed (rejected). This keeps the DB layer's "only
 * a complete sum pair yields a real SD" invariant enforceable straight
 * off the wire. */
function hasValidSumPair(o: Record<string, unknown>): boolean {
  const hasS = 's' in o
  const hasSq = 'sq' in o
  if (!hasS && !hasSq) return true
  if (!hasS || !hasSq) return false
  return typeof o.s === 'number' && Number.isFinite(o.s) && typeof o.sq === 'number' && Number.isFinite(o.sq)
}

/** Shared validator for bigram and trigram minute entries — both use
 * the identical `{c, h, s?, sq?}` shape (see JsonlTrigramMinuteEntry). */
function isNgramMinuteEntry(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  return typeof o.c === 'number' && Number.isFinite(o.c) && isBigramHist(o.h) && hasValidSumPair(o)
}

/** Shared validator for bigram-minute / trigram-minute payloads — same
 * shape except for the entries field name (`bigrams` vs `trigrams`). */
function isNgramMinutePayload(p: Record<string, unknown>, field: 'bigrams' | 'trigrams'): boolean {
  if (!hasStringField(p, 'scopeId') || !hasNumberField(p, 'minuteTs')) return false
  if (!isOptionalAppName(p)) return false
  if (!isOptionalTypingTest(p)) return false
  if (!isOptionalRunId(p)) return false
  const entries = p[field]
  if (typeof entries !== 'object' || entries === null) return false
  for (const value of Object.values(entries as Record<string, unknown>)) {
    if (!isNgramMinuteEntry(value)) return false
  }
  return true
}

function isBigramMinutePayload(p: Record<string, unknown>): boolean {
  return isNgramMinutePayload(p, 'bigrams')
}

function isTrigramMinutePayload(p: Record<string, unknown>): boolean {
  return isNgramMinutePayload(p, 'trigrams')
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
    case 'trigram-minute':
      if (!isTrigramMinutePayload(payloadObj)) return null
      break
  }

  return obj as unknown as JsonlRow
}
