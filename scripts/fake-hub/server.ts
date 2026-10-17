// SPDX-License-Identifier: GPL-2.0-or-later
// A fake Pipette Hub for the Hub tests: the routes the desktop app calls
// (src/main/hub/*.ts) with the Hub worker's answers (`{ok, data}` and
// `{ok: false, error}`, the same checks and texts, the unwrapped
// downloads), and control endpoints that inject failures, create records
// directly, show the state and the request log. It keeps its state in
// memory (hub-state.ts) and listens on 127.0.0.1 only.
//
// The Hub token endpoint takes the `test:<email>` id_token of the Hub's
// test mode and, unlike the Hub, any JWT whose payload has an email (the
// id_token of the fake Google token endpoint, scripts/fake-drive); the
// signature is not checked. The Hub's limits on token requests, on daily
// uploads and on request rates are not kept: a 429 comes only from a
// fault.
//
// Control endpoints (JSON bodies; every write answers `{}` or the record):
//   POST /__control/reset                       empty state, clock, counters and faults
//   POST /__control/faults       Fault          the next `count` requests (of `only`) get this answer
//   POST /__control/users        {email, displayName: string|null, active?, role?}
//                                               creates the account, or changes the one with that email
//   POST /__control/posts        {owner, title, keyboardName?, postType?, updatedAt?}
//                                               a post as another PC of `owner` uploaded it
//   POST /__control/i18n-packs   {owner, export, updatedAt?}  a language pack (`export` is the
//                                               `{version, kind, exportedAt, pack}` object)
//   POST /__control/theme-packs  {owner, pack, updatedAt?}    a theme pack body
//   POST /__control/key-labels   {owner, name, map, compositeLabels?, keymapApplicable?, updatedAt?}
//                                               `owner` "system" is the Hub's built-in owner
//   POST /__control/touch        {kind: post|privatePost|i18n|theme|keyLabel, id, updatedAt?}
//                                               moves `updated_at` on (to `updatedAt` when given)
//   POST /__control/revoke-tokens               forgets every JWT issued: the next request is 401
//   GET  /__control/state                       every record
//   GET  /__control/requests                    the request log
//   POST /__control/clear-requests              empties the request log
// `owner` is an account's email; a missing one is created with the local
// part as its display name.
//
// The Tauri build reaches it through `PIPETTE_HUB_URL` (`fakeHubEnv`).
// Run on its own:
//   npx tsx scripts/fake-hub/server.ts [port]
// prints the URL and the variables as JSON and serves until it is stopped.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { readForm, type HubAnswer, type HubRequest } from './hub-http'
import { ACCOUNT_AND_POST_ROUTES, type Route } from './hub-routes'
import { PACK_AND_KEY_LABEL_ROUTES } from './hub-routes-packs'
import { HubState, SYSTEM_USER_ID, type Fault, type HubOp, type HubUser, type PackKind } from './hub-state'

const ROUTES: Route[] = [...ACCOUNT_AND_POST_ROUTES, ...PACK_AND_KEY_LABEL_ROUTES]
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** What the log keeps of a request body: JSON as its value, a multipart
 *  form as its parts (text fields with their value, files with their
 *  size), anything else as its size. Tokens are not kept. */
export type LoggedBody =
  | null
  | { json: unknown }
  | { parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; size: number }> }
  | { size: number }

export interface LoggedRequest {
  method: string
  path: string
  query: Record<string, string>
  /** The route; null for a path the Hub does not serve. */
  op: HubOp | null
  /** The account of the bearer JWT; null without one or for an unknown one. */
  account: string | null
  /** The Content-Type without its parameters. */
  contentType: string | null
  body: LoggedBody
}

export interface FakeHub {
  /** `http://127.0.0.1:<port>` */
  url: string
  state: HubState
  requests: LoggedRequest[]
  close: () => Promise<void>
}

/** The variables that point a development build at the fake Hub. */
export function fakeHubEnv(url: string): Record<string, string> {
  return { PIPETTE_HUB_URL: url }
}

function send(res: ServerResponse, answer: HubAnswer): void {
  res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers })
  res.end(answer.body)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function logBody(request: HubRequest): LoggedBody {
  if (request.body.length === 0) return null
  if (request.contentType.startsWith('application/json')) {
    try {
      return { json: JSON.parse(request.body.toString('utf8')) as unknown }
    } catch {
      return { size: request.body.length }
    }
  }
  if (request.contentType.startsWith('multipart/form-data')) {
    const parts = Object.entries(readForm(request)).map(([name, value]) =>
      typeof value === 'string'
        ? { name, value, size: Buffer.byteLength(value) }
        : { name, filename: value.filename, contentType: value.contentType, size: value.bytes.length },
    )
    return { parts }
  }
  return { size: request.body.length }
}

function route(method: string, path: string): { route: Route; params: string[] } | null {
  for (const candidate of ROUTES) {
    if (candidate.method !== method) continue
    const match = candidate.pattern.exec(path)
    if (match) return { route: candidate, params: match.slice(1).map((param) => decodeURIComponent(param)) }
  }
  return null
}

// --- Control -------------------------------------------------------------------

/** The account with `email`, created with its local part as its display
 *  name when missing; "system" is the Hub's built-in owner. */
function ownerOf(state: HubState, email: unknown): HubUser {
  if (email === 'system') return state.userById(SYSTEM_USER_ID) as HubUser
  if (typeof email !== 'string' || email.length === 0) throw new Error('owner must be an email')
  return state.userByEmail(email) ?? state.createUser(email, email.split('@')[0] ?? email)
}

function optionalStamp(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('updatedAt must be a string')
  return value
}

const PACK_CONTROL: Record<string, PackKind> = { '/__control/i18n-packs': 'i18n', '/__control/theme-packs': 'theme' }

function control(state: HubState, requests: LoggedRequest[], method: string, path: string, body: Record<string, unknown>): unknown {
  if (method === 'GET' && path === '/__control/state') {
    return { users: state.users, posts: state.posts, privatePosts: state.privatePosts, packs: state.packs, keyLabels: state.keyLabels }
  }
  if (method === 'GET' && path === '/__control/requests') return requests
  if (method !== 'POST') return undefined
  switch (path) {
    case '/__control/reset':
      state.reset()
      return {}
    case '/__control/clear-requests':
      requests.length = 0
      return {}
    case '/__control/faults':
      state.inject(body as unknown as Fault)
      return {}
    case '/__control/revoke-tokens':
      state.jwts.clear()
      return {}
    case '/__control/users': {
      if (typeof body.email !== 'string' || !('displayName' in body)) throw new Error('email and displayName are required')
      const displayName = body.displayName as string | null
      const user = state.userByEmail(body.email) ?? state.createUser(body.email, displayName)
      user.display_name = displayName
      if (typeof body.active === 'boolean') user.is_active = body.active
      if (body.role === 'user' || body.role === 'moderator' || body.role === 'admin') user.role = body.role
      return { id: user.id }
    }
    case '/__control/posts': {
      const owner = ownerOf(state, body.owner)
      const postType = typeof body.postType === 'string' ? body.postType : 'keyboard'
      const post = state.newPost(
        {
          title: String(body.title ?? ''),
          keyboard_name: typeof body.keyboardName === 'string' ? body.keyboardName : null,
          uploaded_by: owner.id,
          post_type: postType,
          files: [],
          keyboard_uid: null,
          total_keystrokes: null,
          range_from_ms: null,
          range_to_ms: null,
        },
        optionalStamp(body.updatedAt),
      )
      state.posts.push(post)
      return state.publicPost(post)
    }
    case '/__control/i18n-packs':
    case '/__control/theme-packs': {
      const kind = PACK_CONTROL[path]
      const owner = ownerOf(state, body.owner)
      const value = (kind === 'i18n' ? body.export : body.pack) as { name?: unknown; version?: unknown; pack?: { name?: unknown; version?: unknown } }
      const named = kind === 'i18n' ? value.pack : value
      const created = state.stamp()
      const pack = {
        id: state.newId(),
        name: String(named?.name ?? ''),
        version: String(named?.version ?? ''),
        pack_json: JSON.stringify(value),
        uploaded_by: owner.id,
        created_at: created,
        updated_at: optionalStamp(body.updatedAt) ?? created,
      }
      state.packs[kind].push(pack)
      return state.packDetail(kind, pack)
    }
    case '/__control/key-labels': {
      const owner = ownerOf(state, body.owner)
      const created = state.stamp()
      const label = {
        id: state.newId(),
        name: String(body.name ?? ''),
        map: (body.map ?? {}) as Record<string, string>,
        composite_labels: (body.compositeLabels ?? null) as Record<string, string> | null,
        keymap_applicable: body.keymapApplicable === true,
        uploaded_by: owner.id,
        created_at: created,
        updated_at: optionalStamp(body.updatedAt) ?? created,
      }
      state.keyLabels.push(label)
      return state.publicKeyLabel(label)
    }
    case '/__control/touch': {
      const record = state.findRecord(body.kind as Parameters<HubState['findRecord']>[0], String(body.id))
      if (!record) throw new Error(`no ${String(body.kind)} ${String(body.id)}`)
      record.updated_at = state.stamp(optionalStamp(body.updatedAt))
      return { updated_at: record.updated_at }
    }
    default:
      return undefined
  }
}

async function handle(state: HubState, requests: LoggedRequest[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  const body = await readBody(req)
  if (url.pathname.startsWith('/__control/')) {
    let result: unknown
    try {
      result = control(state, requests, method, url.pathname, body.length === 0 ? {} : (JSON.parse(body.toString('utf8')) as Record<string, unknown>))
    } catch (err) {
      return send(res, { status: 400, body: JSON.stringify({ error: String(err) }) })
    }
    return send(res, result === undefined ? { status: 404, body: '{}' } : { status: 200, body: JSON.stringify(result) })
  }
  const request: HubRequest = {
    method,
    path: url.pathname,
    query: url.searchParams,
    authorization: req.headers.authorization,
    contentType: req.headers['content-type'] ?? '',
    body,
  }
  const matched = route(method, url.pathname)
  const bearer = request.authorization?.startsWith('Bearer ') ? request.authorization.slice(7) : undefined
  const accountId = bearer === undefined ? undefined : state.jwts.get(bearer)
  requests.push({
    method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    op: matched?.route.op ?? null,
    account: accountId === undefined ? null : (state.userById(accountId)?.email ?? null),
    contentType: request.contentType ? request.contentType.split(';')[0].trim() : null,
    body: logBody(request),
  })
  if (!matched) return send(res, { status: 404, body: JSON.stringify({ ok: false, error: 'Not found' }) })
  const fault = state.takeFault(matched.route.op)
  if (fault) return send(res, { status: fault.status, body: fault.body, headers: fault.retryAfter === null ? {} : { 'Retry-After': fault.retryAfter } })
  send(res, matched.route.handler(state, request, matched.params))
}

/** Starts a fake Hub on 127.0.0.1 (on `port`, or a free one). */
export async function startFakeHub(options: { port?: number } = {}): Promise<FakeHub> {
  const state = new HubState()
  const requests: LoggedRequest[] = []
  const server: Server = createServer((req, res) => {
    handle(state, requests, req, res).catch(() => {
      if (!res.headersSent) send(res, { status: 500, body: JSON.stringify({ ok: false, error: 'Internal server error' }) })
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { address, port } = server.address() as AddressInfo
  if (address !== '127.0.0.1') throw new Error(`the fake Hub listens on ${address}`)
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.argv[2] === undefined ? 0 : Number(process.argv[2])
  startFakeHub({ port }).then((hub) => {
    console.log(JSON.stringify({ url: hub.url, env: fakeHubEnv(hub.url) }))
    const stop = (): void => void hub.close().then(() => process.exit(0))
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  }, (err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
