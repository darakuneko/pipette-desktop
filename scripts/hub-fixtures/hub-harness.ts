// SPDX-License-Identifier: GPL-2.0-or-later
// The harness the Hub fixture generators run the Electron main process's
// Hub code in (setup.ts installs it before every test file, on top of the
// sync fixture harness in ../sync-fixtures/harness.ts). It keeps the code
// away from everything real and makes every run give the same bytes.
//
// Safety:
//   - `fetch` is the sync harness's guarded fetch: it sends only to
//     127.0.0.1 and throws for any other destination, redirects included,
//     before connecting. While a scenario runs, a scripted Hub answers
//     the requests to HUB_BASE without connecting at all; a request to
//     any other origin throws, and so does a request no rule answers.
//   - `app.getPath` answers a temporary userData only and throws for the
//     real userData of Pipette or Electron (`~/.config/pipette-desktop`,
//     `~/.config/Electron` and their places on the other systems).
//   - `getIdToken` (Google) answers a fixed fake value, or null.
//
// Determinism (every input the recorded bytes depend on):
//   - the clock: `Date.now()` / `new Date()` are FIXED_NOW, so the
//     multipart boundaries (`----Pipette…Boundary{Date.now()}`), the
//     `exportedAt` of a language pack upload and the stores' `updatedAt`
//     are fixed; the boundary is also written as a template with `{now}`;
//   - `randomUUID` / `randomBytes` / `Math.random`: the sync harness's
//     fixed sequences (new store ids, temporary file names);
//   - the machine hash: the generators that need one mock it;
//   - the Hub's answers (ids, JWTs, `updated_at`): literal values in the
//     scenario's rules, numbered in the order the scenario lists them;
//   - the waits of a 429: `setTimeout` from src/main/hub is recorded and
//     fires at once, so no run sleeps and the waits are part of the log;
//   - requests sent in parallel (the timestamps in chunks of 100, the
//     downloads of the startup auto-update): a scenario marked `unordered`
//     has its log sorted;
//   - error stacks (the startup auto-update keeps `err.stack`): only the
//     first line is recorded;
//   - writes that are not awaited: a userData tree is read only after the
//     tree, the change notices and the events have stopped changing for
//     SETTLE_QUIET_MS (a time limit, never a count of yields).

import { readTree, type Tree } from '../sync-fixtures/harness'
import { logRequest, type LoggedRequest } from './request-log'

/** The Hub every generator points the Electron code at
 *  (`PIPETTE_HUB_URL`, honoured with `PIPETTE_HUB_TEST=1`). Nothing
 *  listens on port 9; the scripted Hub answers before any connection. */
export const HUB_BASE = 'http://127.0.0.1:9'

/** The fake Google id_token `getIdToken` answers by default. */
export const FAKE_ID_TOKEN = 'fixture-google-id-token'

/** An answer of the scripted Hub. `json` is sent as `JSON.stringify` of
 *  the value, `text` as it is. */
export interface ScriptedResponse {
  status: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
  /** Something that happens while this request is in flight, before the
   *  answer arrives (setAnswerActions names what each one does). */
  during?: string
}

/** A rule of the scripted Hub: the first rule whose method and path
 *  match, and that has answers left, answers. `path` matches the path
 *  without the query; `query` (when set) must equal the query string. */
export interface HubRule {
  method: string
  path: string
  query?: string
  /** When set, the request's JSON body must be this value. */
  body?: unknown
  /** Answers in order; the last one repeats when `repeat` is set. */
  responses: ScriptedResponse[]
  repeat?: boolean
}

interface HubState {
  idToken: string | null
  rules: Array<HubRule & { used: number }>
  requests: LoggedRequest[]
  sleeps: number[]
  events: Array<{ channel: string; args: unknown[] }>
  notified: string[]
  logs: Array<{ level: string; message: string }>
}

const state: HubState = {
  idToken: FAKE_ID_TOKEN,
  rules: [],
  requests: [],
  sleeps: [],
  events: [],
  notified: [],
  logs: [],
}

export function resetHubHarness(): void {
  state.idToken = FAKE_ID_TOKEN
  state.rules = []
  state.requests = []
  state.sleeps = []
  state.events = []
  state.notified = []
  state.logs = []
}

// --- Google ---

export function setIdToken(value: string | null): void {
  state.idToken = value
}

export function currentIdToken(): string | null {
  return state.idToken
}

// --- Recorders the module mocks of setup.ts call ---

export function recordEvent(channel: string, args: unknown[]): void {
  state.events.push({ channel, args })
}

export function recordNotified(unit: string): void {
  state.notified.push(unit)
}

export function recordLog(level: string, message: string): void {
  state.logs.push({ level, message: firstLine(message) })
}

/** The first line of `text`: an error stack keeps only its message. */
export function firstLine(text: string): string {
  const end = text.indexOf('\n')
  return end === -1 ? text : text.slice(0, end)
}

export interface Recorded {
  requests: LoggedRequest[]
  sleeps: number[]
  events: Array<{ channel: string; args: unknown[] }>
  notified: string[]
  logs: Array<{ level: string; message: string }>
}

/** What the scenario recorded so far; the lists are emptied. */
export function takeRecorded(): Recorded {
  const taken = {
    requests: state.requests,
    sleeps: state.sleeps,
    events: state.events,
    notified: state.notified,
    logs: state.logs,
  }
  state.requests = []
  state.sleeps = []
  state.events = []
  state.notified = []
  state.logs = []
  return taken
}

// --- The scripted Hub ---

export function setRules(rules: readonly HubRule[]): void {
  state.rules = rules.map((rule) => ({ ...rule, used: 0 }))
}

/** Rules that still have answers nobody asked for. */
export function unusedRules(): HubRule[] {
  return state.rules.filter((rule) => !rule.repeat && rule.used < rule.responses.length)
}

let answerActions: Record<string, () => void> = {}

/** What each `during` of a scripted answer does. */
export function setAnswerActions(actions: Record<string, () => void>): void {
  answerActions = actions
}

function answer(rule: HubRule & { used: number }): Response {
  const index = Math.min(rule.used, rule.responses.length - 1)
  rule.used++
  const scripted = rule.responses[index]
  if (scripted.during !== undefined) {
    const action = answerActions[scripted.during]
    if (action === undefined) throw new Error(`hub fixture harness: no action ${scripted.during}`)
    action()
  }
  const body = scripted.json !== undefined ? JSON.stringify(scripted.json) : (scripted.text ?? '')
  const headers = new Headers(scripted.headers)
  if (scripted.json !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  // A 204 / 304 can carry no body.
  return new Response(scripted.status === 204 || scripted.status === 304 ? null : body, { status: scripted.status, headers })
}

/** `fetch` of a scenario: logs each request to HUB_BASE and answers it
 *  from the rules without connecting; throws for any other origin and
 *  for a request no rule answers. */
export function scriptedFetch(): typeof fetch {
  const base = new URL(HUB_BASE)
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.origin !== base.origin) throw new Error(`hub fixture harness: refused a request to ${url.host || url.href}`)
    state.requests.push(logRequest(url, init))
    const method = (init?.method ?? 'GET').toUpperCase()
    const query = url.search.startsWith('?') ? url.search.slice(1) : url.search
    const body = typeof init?.body === 'string' ? init.body : undefined
    const rule = state.rules.find(
      (r) =>
        r.method === method &&
        r.path === url.pathname &&
        (r.query === undefined || r.query === query) &&
        (r.body === undefined || (body !== undefined && body === JSON.stringify(r.body))) &&
        (r.repeat === true || r.used < r.responses.length),
    )
    if (rule === undefined) throw new Error(`hub fixture harness: no rule answers ${method} ${url.pathname}${url.search}`)
    return answer(rule)
  }) as typeof fetch
}

// --- The waits of src/main/hub ---

/** Runs `run` with `setTimeout` calls made from src/main/hub recorded
 *  and fired at once; every other timer is left alone. */
export async function withRecordedHubSleeps<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout
  const patched = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    // The frame that called setTimeout: the `sleep` of a Hub client module.
    const caller = (new Error().stack ?? '').split('\n')[2] ?? ''
    if (/[\\/]src[\\/]main[\\/]hub[\\/]/.test(caller)) {
      state.sleeps.push(ms ?? 0)
      return real(handler, 0, ...args)
    }
    return real(handler, ms, ...args)
  }) as typeof setTimeout
  globalThis.setTimeout = patched
  try {
    return await run()
  } finally {
    globalThis.setTimeout = real
  }
}

// --- Settling ---

/** How long the tree, the change notices and the events must stay the
 *  same before a tree is read. */
export const SETTLE_QUIET_MS = 30
/** How long settling may take before the generator fails. */
export const SETTLE_DEADLINE_MS = 5_000

function snapshotKey(dir: string): string {
  return JSON.stringify([readTree(dir), state.notified.length, state.events.length, state.logs.length])
}

/** The userData tree once nothing has changed for SETTLE_QUIET_MS:
 *  broadcasts, `notifyChange` and writes nobody awaited have landed. */
export async function settledTree(dir: string): Promise<Tree> {
  // `performance.now()` keeps running; the harness fixes only `Date`.
  const deadline = performance.now() + SETTLE_DEADLINE_MS
  let last = snapshotKey(dir)
  let quietSince = performance.now()
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const now = performance.now()
    const current = snapshotKey(dir)
    if (current !== last) {
      last = current
      quietSince = now
    } else if (now - quietSince >= SETTLE_QUIET_MS) {
      return readTree(dir)
    }
    if (now > deadline) throw new Error('hub fixture harness: the userData did not settle')
  }
}
