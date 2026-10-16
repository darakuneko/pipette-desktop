// SPDX-License-Identifier: GPL-2.0-or-later
// Hand-written JSONL lines appended to the seeded day so the fixtures cover
// what the seed never produces: LWW replacement and rejection inside one
// file, a tombstone row, a second scope sharing minutes with the first,
// char-minute rows with non-ASCII text, REAL values in INTEGER columns,
// out-of-range histogram buckets, n-gram entries given as an array, strings
// with a lone surrogate, a repeated key (JSON.parse keeps the last), lines
// the parser rejects (numbers that overflow to an infinity among them), CRLF / lone CR line breaks and a final line without a
// newline (skipped as partial).

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

export const SECOND_SCOPE_ID = 'fixture-scope-2'
export const SECOND_MACHINE_HASH = 'b'.repeat(64)

export interface EdgeContext {
  uid: string
  scopeId: string
  dayStartMs: number
  /** `updated_at` of every seeded row. */
  seededAt: number
}

const hist = (...values: number[]): number[] => [...values, ...new Array<number>(8 - values.length).fill(0)]

function line(row: Record<string, unknown>): string {
  return JSON.stringify(row)
}

/** JSON.stringify writes an infinity as `null`, so these markers stand in
 * for `1e400` / `-1e400`, literals JSON.parse reads as an infinity. */
const POS_INF = '__POS_INF__'
const NEG_INF = '__NEG_INF__'

function overflowLine(row: Record<string, unknown>): string {
  return line(row).replaceAll(`"${POS_INF}"`, '1e400').replaceAll(`"${NEG_INF}"`, '-1e400')
}

/** The edge lines, already joined with their line breaks. The returned text
 * starts with a newline-terminated line and ends WITHOUT a newline. */
export function buildEdgeLines(ctx: EdgeContext): string {
  const { uid, scopeId, dayStartMs, seededAt } = ctx
  const t13 = dayStartMs + 13 * HOUR_MS
  const t13b = t13 + MINUTE_MS
  const newer = seededAt + 1000
  const older = seededAt - 1000

  const stats = (sid: string, minuteTs: number, updatedAt: number, keystrokes: number, extra: Record<string, unknown> = {}): string => line({
    id: `stats|${sid}|${minuteTs}|`,
    kind: 'minute-stats',
    updated_at: updatedAt,
    payload: {
      scopeId: sid, minuteTs, keystrokes, activeMs: 30_000,
      intervalAvgMs: 123.5, intervalMinMs: 40, intervalP25Ms: 90, intervalP50Ms: 101.25, intervalP75Ms: 180, intervalMaxMs: 400,
      appName: 'Code', ...extra,
    },
  })
  const char = (sid: string, minuteTs: number, ch: string, count: number, updatedAt: number, extra: Record<string, unknown> = {}): string => line({
    id: `char|${sid}|${minuteTs}|${ch}`,
    kind: 'char-minute',
    updated_at: updatedAt,
    payload: { scopeId: sid, minuteTs, char: ch, count, ...extra },
  })

  const lines: string[] = [
    // Second scope of the same keyboard on another machine.
    line({
      id: `scope|${SECOND_SCOPE_ID}`, kind: 'scope', updated_at: seededAt,
      payload: {
        id: SECOND_SCOPE_ID, machineHash: SECOND_MACHINE_HASH, osPlatform: 'darwin', osRelease: '25.0.0', osArch: 'arm64',
        keyboardUid: uid, keyboardVendorId: 0x4153, keyboardProductId: 0x4d47, keyboardProductName: 'GPK60-63R (fixture)',
      },
    }),
    stats(SECOND_SCOPE_ID, t13, seededAt, 120, { pollP50Ms: null, pollP95Ms: 27.25 }),
    stats(SECOND_SCOPE_ID, t13b, seededAt, 95, { appName: null }),
    // LWW on the seeded scope's minute: newer replaces, older and equal lose.
    stats(scopeId, t13, newer, 333, { pollP50Ms: 22.5, pollP95Ms: 31 }),
    stats(scopeId, t13, older, 1),
    stats(scopeId, t13, newer, 2),
    char(scopeId, t13, 'a', 7, seededAt, { appName: '日本語エディタ' }),
    char(scopeId, t13, 'a', 99, older),
    char(scopeId, t13, '😀', 2, seededAt, { runId: 'run/with spaces%', typingTest: 'テスト' }),
    char(SECOND_SCOPE_ID, t13, '日', 3, seededAt, { appName: null, typingTest: null }),
    // Tombstone of one seeded matrix cell.
    line({
      id: `matrix|${scopeId}|${t13}|1|0|0`, kind: 'matrix-minute', updated_at: newer, is_deleted: true,
      payload: { scopeId, minuteTs: t13, row: 1, col: 0, layer: 0, keycode: 4, count: 0, tapCount: 0, holdCount: 0, appName: 'Code' },
    }),
    line({
      id: `matrix|${SECOND_SCOPE_ID}|${t13}|3|3|0`, kind: 'matrix-minute', updated_at: seededAt,
      payload: {
        scopeId: SECOND_SCOPE_ID, minuteTs: t13, row: 3, col: 3, layer: 0, keycode: 44.5, count: 4, tapCount: 3, holdCount: 1,
        dh: hist(0, 1, 2.9, -1, 1), ds: 512.75, dq: 70000.125,
      },
    }),
    line({
      id: `bigram|${SECOND_SCOPE_ID}|${t13}`, kind: 'bigram-minute', updated_at: seededAt,
      payload: {
        scopeId: SECOND_SCOPE_ID, minuteTs: t13, appName: 'Code',
        bigrams: { '4_5': { c: 3, h: hist(1, 0, 2.7, -3), s: 300.5, sq: 30100.25, oc: 1, on: 2 }, '5_6': { c: 1, h: hist(0, 1) } },
      },
    }),
    line({
      id: `bigram|${SECOND_SCOPE_ID}|${t13b}`, kind: 'bigram-minute', updated_at: seededAt,
      payload: { scopeId: SECOND_SCOPE_ID, minuteTs: t13b, bigrams: [{ c: 2, h: hist(2) }] },
    }),
    line({
      id: `trigram|${SECOND_SCOPE_ID}|${t13}`, kind: 'trigram-minute', updated_at: seededAt,
      payload: { scopeId: SECOND_SCOPE_ID, minuteTs: t13, trigrams: { '4_5_6': { c: 1, h: hist(0, 0, 1), s: 100, sq: 10000 } } },
    }),
    line({
      id: 'session|fixture-session-2', kind: 'session', updated_at: seededAt,
      payload: { id: 'fixture-session-2', scopeId: SECOND_SCOPE_ID, startMs: t13, endMs: t13b + MINUTE_MS },
    }),
    // Lone surrogates in a value and in an n-gram id (better-sqlite3 writes
    // each as U+FFFD), and a repeated key.
    char(scopeId, t13b, '\ud800', 9, seededAt, { appName: 'App\udfff' }),
    line({
      id: `bigram|${SECOND_SCOPE_ID}|${t13b}|lone`, kind: 'bigram-minute', updated_at: seededAt,
      payload: { scopeId: SECOND_SCOPE_ID, minuteTs: t13b, runId: 'lone', bigrams: { 'x\ud83d': { c: 4, h: hist(4) } } },
    }),
    `{"id":"dup","kind":"char-minute","updated_at":${seededAt},"payload":{"scopeId":"${scopeId}","minuteTs":${t13b},"char":"q","count":1,"count":3}}`,
    // Lines the parser rejects.
    'not json',
    line({ id: 'x', kind: 'future-kind', updated_at: 1, payload: {} }),
    line({ id: 'x', kind: 'bigram-minute', updated_at: 1, payload: { scopeId, minuteTs: t13, bigrams: { '1_2': { c: 1, h: hist(1), s: 1 } } } }),
    line({ id: 'x', kind: 'bigram-minute', updated_at: 1, payload: { scopeId, minuteTs: t13, bigrams: { '1_2': { c: 1, h: hist(1), oc: 3, on: 2 } } } }),
    line({ id: 'x', kind: 'bigram-minute', updated_at: 1, payload: { scopeId, minuteTs: t13, bigrams: { '1_2': { c: 1, h: hist(1), oc: 0.5, on: 2 } } } }),
    line({ id: 'x', kind: 'bigram-minute', updated_at: 1, payload: { scopeId, minuteTs: t13, bigrams: { '1_2': { c: 1, h: [1, 2] } } } }),
    line({ id: 'x', kind: 'char-minute', updated_at: 1, is_deleted: null, payload: { scopeId, minuteTs: t13, char: 'z', count: 1 } }),
    line({ id: 'x', kind: 'char-minute', updated_at: 1, payload: { scopeId, minuteTs: t13, char: 'z', count: 1, runId: null } }),
    line({ id: 'x', kind: 'matrix-minute', updated_at: 1, payload: { scopeId, minuteTs: t13, row: 0, col: 0, layer: 0, keycode: 1, count: 1, tapCount: 0, holdCount: 0, dh: hist(1) } }),
    line({ id: 'x', kind: 'minute-stats', updated_at: 1, payload: { scopeId, minuteTs: t13, keystrokes: 1, activeMs: 1 } }),
    line({ id: 'x', kind: 'minute-stats', updated_at: 1, payload: { scopeId, minuteTs: t13, keystrokes: 1, activeMs: 1, intervalAvgMs: null, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null, pollP50Ms: 1 } }),
    line({ id: 'x', kind: 'scope', updated_at: 1, payload: { id: 's' } }),
    line({ id: 'x', kind: 'session', updated_at: '1', payload: { id: 's', scopeId, startMs: 1, endMs: 2 } }),
    '[1,2,3]',
    // Numbers that overflow to an infinity. The tombstone would beat every
    // finite updated_at of the seeded minute if it were stored.
    overflowLine({
      id: `stats|${scopeId}|${t13}|`, kind: 'minute-stats', updated_at: POS_INF, is_deleted: true,
      payload: { scopeId, minuteTs: t13, keystrokes: 0, activeMs: 0, intervalAvgMs: null, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null },
    }),
    overflowLine({ id: 'inf-1', kind: 'char-minute', updated_at: NEG_INF, payload: { scopeId, minuteTs: t13, char: 'i', count: 1 } }),
    overflowLine({ id: 'inf-2', kind: 'char-minute', updated_at: 1, payload: { scopeId, minuteTs: t13, char: 'j', count: POS_INF } }),
    overflowLine({ id: 'inf-3', kind: 'minute-stats', updated_at: 1, payload: { scopeId, minuteTs: t13b + MINUTE_MS, keystrokes: 1, activeMs: 1, intervalAvgMs: NEG_INF, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null, pollP50Ms: null, pollP95Ms: POS_INF } }),
    overflowLine({ id: 'inf-4', kind: 'matrix-minute', updated_at: 1, payload: { scopeId, minuteTs: t13b, row: 5, col: 5, layer: 0, keycode: 1, count: 1, tapCount: 1, holdCount: 0, dh: hist(1, NEG_INF as unknown as number), ds: 1, dq: 1 } }),
    overflowLine({ id: 'inf-5', kind: 'matrix-minute', updated_at: 1, payload: { scopeId, minuteTs: t13b, row: 5, col: 6, layer: 0, keycode: 1, count: 1, tapCount: 1, holdCount: 0, dh: hist(1), ds: POS_INF, dq: 1 } }),
    overflowLine({ id: 'inf-6', kind: 'bigram-minute', updated_at: 1, payload: { scopeId, minuteTs: t13b, runId: 'inf', bigrams: { '7_8': { c: 1, h: hist(1), s: 1, sq: POS_INF } } } }),
    overflowLine({ id: 'inf-7', kind: 'trigram-minute', updated_at: 1, payload: { scopeId, minuteTs: t13b, runId: 'inf', trigrams: { '7_8_9': { c: NEG_INF, h: hist(1) } } } }),
    overflowLine({ id: 'inf-8', kind: 'session', updated_at: 1, payload: { id: 'inf-session', scopeId, startMs: t13, endMs: POS_INF } }),
    overflowLine({
      id: 'scope|inf-scope', kind: 'scope', updated_at: 1,
      payload: { id: 'inf-scope', machineHash: 'c'.repeat(64), osPlatform: 'linux', osRelease: '1', osArch: 'x64', keyboardUid: uid, keyboardVendorId: POS_INF, keyboardProductId: 1, keyboardProductName: 'x' },
    }),
    '',
  ]

  // A CRLF line, then two rows separated by a lone CR (readline splits on
  // both), then the partial final line.
  return lines.join('\n') + '\n'
    + char(scopeId, t13b, 'b', 4, seededAt) + '\r\n'
    + char(scopeId, t13b, 'c', 5, seededAt) + '\r' + char(scopeId, t13b, 'd', 6, seededAt) + '\n'
    + char(scopeId, t13b, 'e', 8, seededAt)
}

/** A file whose last row points at a scope that does not exist: the
 * foreign key fails and the whole apply must roll back, including the
 * valid row before it. */
export function buildOrphanFile(ctx: EdgeContext): string {
  const t21 = ctx.dayStartMs + 21 * HOUR_MS
  return [
    line({ id: 'c1', kind: 'char-minute', updated_at: ctx.seededAt + 5000, payload: { scopeId: SECOND_SCOPE_ID, minuteTs: t21, char: 'q', count: 1 } }),
    line({ id: 'c2', kind: 'char-minute', updated_at: ctx.seededAt + 5000, payload: { scopeId: 'missing-scope', minuteTs: t21, char: 'q', count: 1 } }),
  ].join('\n') + '\n'
}
