// SPDX-License-Identifier: GPL-2.0-or-later
// A fake startup-notice server for the notice tests: it stands in for the
// endpoint `fetchNotifications` (src/main/notification-store.ts) POSTs its
// query to, answers each POST with the scripted response, logs every
// request with its body, and takes faults for the next requests. It keeps
// its state in memory and listens on 127.0.0.1 only.
//
// The answer is the script as it is: the fake does not apply the query's
// filter, order or limit, so a test decides exactly what the app receives
// (the renderer sorts the notices itself). Without a script it answers
// `{"notifications":[]}`.
//
// Control endpoints (JSON bodies; every write answers `{}`):
//   POST /__control/script  {notifications: unknown[]}  answer `{notifications}`
//                           {response: unknown}          answer this JSON value as it is
//                                                        (exactly one of the two)
//   POST /__control/faults  Fault   the next `count` notice requests get this instead;
//                                   faults queue up in the order they are given
//   POST /__control/reset           default script, no faults, empty log
//   POST /__control/clear-requests  empties the log
//   GET  /__control/requests        the log
// A Fault is one of
//   {kind: 'status', count, status, body?}  that HTTP status with `body` (default a JSON error)
//   {kind: 'notJson', count}                200 with a body that is not JSON
//   {kind: 'delay', count, delayMs}         the scripted answer after `delayMs` (at most 60 s)
//
// Every path outside /__control/ is the notice endpoint, since the real one
// is the root of its host.
//
// The Tauri build reaches it through `PIPETTE_NOTIFICATION_URL`
// (`fakeNotificationEnv`). Run on its own:
//   npx tsx scripts/fake-notification/server.ts [port]
// prints the URL and the variables as JSON and serves until it is stopped.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { listenOnLoopback, readBody, runStandalone } from '../fake-server/server-support'

const MAX_BODY_BYTES = 1024 * 1024
export const MAX_DELAY_MS = 60_000
const DEFAULT_ERROR_BODY = JSON.stringify({ error: 'Internal Server Error' })
const NOT_JSON_BODY = '<html>not json</html>'

export type Fault =
  | { kind: 'status'; count: number; status: number; body?: string }
  | { kind: 'notJson'; count: number }
  | { kind: 'delay'; count: number; delayMs: number }

export interface LoggedNoticeRequest {
  method: string
  path: string
  /** The Content-Type without its parameters; null without one. */
  contentType: string | null
  /** The body as UTF-8 text, byte for byte what the app sent. */
  bodyText: string
  /** The body parsed as JSON; absent when it is not JSON. */
  json?: unknown
  /** `Date.now()` when the request arrived. */
  receivedAt: number
}

export interface FakeNotification {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** Each notice request in turn, the control endpoints left out. */
  requests: LoggedNoticeRequest[]
  /** Answers `{notifications}` from now on. */
  setNotifications: (notifications: unknown[]) => void
  /** Answers `response` as it is from now on. */
  setResponse: (response: unknown) => void
  /** Queues a fault for the next `count` notice requests. */
  inject: (fault: Fault) => void
  /** The default script, no faults and an empty log. */
  reset: () => void
  close: () => Promise<void>
}

/** The variables that point a development build at the fake server. */
export function fakeNotificationEnv(url: string): Record<string, string> {
  return { PIPETTE_NOTIFICATION_URL: url }
}

/** A Firestore timestamp as the notice endpoint sends `publishedAt`. */
export function firestoreTimestamp(ms: number, nanoseconds = 0): { _seconds: number; _nanoseconds: number } {
  return { _seconds: Math.floor(ms / 1000), _nanoseconds: nanoseconds }
}

/** A well-formed notice; `publishedAt` is a string or a Firestore timestamp. */
export function notice(fields: { title?: string; body?: string; type?: string; publishedAt: unknown }): Record<string, unknown> {
  return { title: fields.title ?? 'Notice', body: fields.body ?? 'Body', type: fields.type ?? 'Info', publishedAt: fields.publishedAt }
}

/** `body` as a fault, refused unless every field has its type and range. */
export function checkedFault(body: Record<string, unknown>): Fault {
  const { kind, count } = body
  if (!Number.isInteger(count) || (count as number) < 1) throw new Error('count must be a positive integer')
  switch (kind) {
    case 'status': {
      const { status } = body
      if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) throw new Error('status must be an HTTP status')
      if (body.body !== undefined && typeof body.body !== 'string') throw new Error('body must be a string')
      return { kind, count: count as number, status: status as number, ...(body.body === undefined ? {} : { body: body.body as string }) }
    }
    case 'notJson':
      return { kind, count: count as number }
    case 'delay': {
      const { delayMs } = body
      if (!Number.isInteger(delayMs) || (delayMs as number) < 0 || (delayMs as number) > MAX_DELAY_MS) {
        throw new Error(`delayMs must be an integer from 0 to ${MAX_DELAY_MS}`)
      }
      return { kind, count: count as number, delayMs: delayMs as number }
    }
    default:
      throw new Error('kind must be status, notJson or delay')
  }
}

/** The script of `body`: exactly one of `notifications` (an array) and `response`. */
function checkedScript(body: Record<string, unknown>): unknown {
  const hasList = 'notifications' in body
  if (hasList === 'response' in body) throw new Error('give exactly one of notifications and response')
  if (!hasList) return body.response
  if (!Array.isArray(body.notifications)) throw new Error('notifications must be an array')
  return { notifications: body.notifications }
}

function send(res: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(body)
}

class NoticeState {
  response: unknown = { notifications: [] }
  readonly faults: Fault[] = []
  readonly requests: LoggedNoticeRequest[] = []

  reset(): void {
    this.response = { notifications: [] }
    this.faults.length = 0
    this.requests.length = 0
  }

  /** The fault for the request now arriving, used up by one. */
  takeFault(): Fault | null {
    const fault = this.faults[0]
    if (!fault) return null
    const taken = { ...fault }
    fault.count -= 1
    if (fault.count === 0) this.faults.shift()
    return taken
  }
}

function control(state: NoticeState, method: string, path: string, body: Record<string, unknown>): unknown {
  if (method === 'GET' && path === '/__control/requests') return state.requests
  if (method !== 'POST') return undefined
  switch (path) {
    case '/__control/script':
      state.response = checkedScript(body)
      return {}
    case '/__control/faults':
      state.faults.push(checkedFault(body))
      return {}
    case '/__control/reset':
      state.reset()
      return {}
    case '/__control/clear-requests':
      state.requests.length = 0
      return {}
    default:
      return undefined
  }
}

function logRequest(req: IncomingMessage, path: string, body: Buffer): LoggedNoticeRequest {
  const bodyText = body.toString('utf8')
  const contentType = req.headers['content-type']
  const logged: LoggedNoticeRequest = {
    method: req.method ?? 'GET',
    path,
    contentType: contentType ? contentType.split(';')[0].trim() : null,
    bodyText,
    receivedAt: Date.now(),
  }
  try {
    logged.json = JSON.parse(bodyText)
  } catch {
    // Not JSON: the text alone is logged.
  }
  return logged
}

/** Starts a fake notice server on 127.0.0.1 (on `port`, or a free one). */
export async function startFakeNotification(options: { port?: number } = {}): Promise<FakeNotification> {
  const state = new NoticeState()
  const delays = new Set<NodeJS.Timeout>()

  const answer = (res: ServerResponse): void => send(res, 200, JSON.stringify(state.response))

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const method = req.method ?? 'GET'
    const body = await readBody(req, MAX_BODY_BYTES)
    if (path.startsWith('/__control/')) {
      let result: unknown
      try {
        result = control(state, method, path, body.length === 0 ? {} : (JSON.parse(body.toString('utf8')) as Record<string, unknown>))
      } catch (err) {
        return send(res, 400, JSON.stringify({ error: String(err) }))
      }
      return send(res, result === undefined ? 404 : 200, result === undefined ? '{}' : JSON.stringify(result))
    }
    state.requests.push(logRequest(req, path, body))
    if (method !== 'POST') return send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }))
    const fault = state.takeFault()
    if (fault?.kind === 'status') return send(res, fault.status, fault.body ?? DEFAULT_ERROR_BODY)
    if (fault?.kind === 'notJson') return send(res, 200, NOT_JSON_BODY)
    if (fault?.kind === 'delay') {
      const timer = setTimeout(() => {
        delays.delete(timer)
        answer(res)
      }, fault.delayMs)
      delays.add(timer)
      return
    }
    answer(res)
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, JSON.stringify({ error: String(err) }))
      else res.destroy()
    })
  })
  const { url, close } = await listenOnLoopback(server, options.port, 'fake notice server')
  return {
    url,
    requests: state.requests,
    setNotifications: (notifications) => {
      state.response = { notifications }
    },
    setResponse: (response) => {
      state.response = response
    },
    inject: (fault) => {
      state.faults.push(checkedFault(fault as unknown as Record<string, unknown>))
    },
    reset: () => state.reset(),
    close: () => {
      // A delayed answer never fires after the server is closed.
      for (const timer of delays) clearTimeout(timer)
      delays.clear()
      return close()
    },
  }
}

runStandalone(import.meta.url, startFakeNotification, fakeNotificationEnv)
