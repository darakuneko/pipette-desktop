// SPDX-License-Identifier: GPL-2.0-or-later
// A fake Google Drive v3 and OAuth server for the sync's tests: the part of
// the Drive API the sync uses on appDataFolder (the requests of
// src/main/sync/google-drive.ts), the authorization and token endpoints
// (src/main/sync/google-auth.ts) and control endpoints that inject
// failures, switch the account and show the state. It keeps its state in
// memory and listens on 127.0.0.1 only. The files follow drive-state.ts.
//
// The Tauri build reaches it through the endpoint variables of a
// development build (`fakeDriveEnv`). Run on its own:
//   npx tsx scripts/fake-drive/server.ts [port]
// prints the variables as JSON and serves until it is stopped.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { DriveState, errorBody, isFailure, notFound, type DriveFailure, type DriveOp, type Fault, type StoredFile } from './drive-state'

export interface FakeAccount {
  sub: string
  email: string
}

export interface FakeDrive {
  /** `http://127.0.0.1:<port>` */
  url: string
  state: DriveState
  /** Each request in turn, the control endpoints left out. */
  requests: Array<{ method: string; path: string; query: Record<string, string> }>
  close: () => Promise<void>
}

/** The endpoint variables that point a development build at `url`. */
export function fakeDriveEnv(url: string): Record<string, string> {
  return {
    PIPETTE_GOOGLE_AUTH_URL: `${url}/oauth/auth`,
    PIPETTE_GOOGLE_TOKEN_URL: `${url}/oauth/token`,
    PIPETTE_DRIVE_API_URL: `${url}/drive/v3`,
    PIPETTE_DRIVE_UPLOAD_URL: `${url}/upload/drive/v3`,
  }
}

const DEFAULT_ACCOUNT: FakeAccount = { sub: 'fake-sub-1', email: 'fake-user@example.invalid' }
const MAX_BODY_BYTES = 256 * 1024 * 1024

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url')
}

/** An unsigned id_token: the sync reads only its payload. */
function idToken(account: FakeAccount, clientId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({ iss: 'fake-drive', aud: clientId, sub: account.sub, email: account.email, iat: now, exp: now + 3600 }),
  )
  return `${header}.${payload}.fake`
}

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', ...headers })
  res.end(body)
}

function sendFailure(res: ServerResponse, failure: DriveFailure): void {
  send(res, failure.status, failure.body, failure.retryAfter === null ? {} : { 'Retry-After': failure.retryAfter })
}

function sendJson(res: ServerResponse, value: unknown): void {
  send(res, 200, JSON.stringify(value))
}

/** The fields of a file a response has when the request names none. */
const DEFAULT_FILE_FIELDS = ['kind', 'id', 'name', 'mimeType']

/** `file` limited to `wanted`, every field when null. */
function pickFields(file: StoredFile, wanted: readonly string[] | null): Record<string, string> {
  const all: Record<string, string> = {
    kind: 'drive#file',
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
  }
  if (wanted === null) return all
  return Object.fromEntries(wanted.filter((field) => field in all).map((field) => [field, all[field]]))
}

/** A `fields` parameter split at its top-level commas, each field with the
 *  sub-fields in its parentheses (`nextPageToken, files(id, name)`), null
 *  for none; undefined when it does not parse. */
function parseFields(fields: string): Map<string, string[] | null> | undefined {
  const parsed = new Map<string, string[] | null>()
  let depth = 0
  let start = 0
  const parts: string[] = []
  for (let i = 0; i < fields.length; i++) {
    if (fields[i] === '(') depth += 1
    else if (fields[i] === ')') depth -= 1
    if (depth < 0 || depth > 1) return undefined
    if (fields[i] === ',' && depth === 0) {
      parts.push(fields.slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0) return undefined
  parts.push(fields.slice(start))
  for (const part of parts) {
    const match = /^\s*(\w+)\s*(?:\(([^()]*)\))?\s*$/.exec(part)
    if (!match) return undefined
    const sub = match[2] === undefined ? null : match[2].split(',').map((field) => field.trim())
    if (sub?.some((field) => !/^\w+$/.test(field))) return undefined
    parsed.set(match[1], sub)
  }
  return parsed
}

/** The fields of a listing: the request's `fields` (null for none), so a
 *  field it leaves out, `nextPageToken` included, is not in the answer. */
function listingFields(fields: string | null): Map<string, string[] | null> | undefined {
  if (fields === null) {
    return new Map<string, string[] | null>([['kind', null], ['incompleteSearch', null], ['nextPageToken', null], ['files', DEFAULT_FILE_FIELDS]])
  }
  const parsed = parseFields(fields)
  const known = ['kind', 'incompleteSearch', 'nextPageToken', 'files']
  return parsed && [...parsed.keys()].every((field) => known.includes(field)) ? parsed : undefined
}

function invalidFields(res: ServerResponse): void {
  send(res, 400, errorBody(400, 'Invalid field selection', 'invalidParameter'))
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

/** The parts of a `multipart/related` body: their headers and content. */
function multipartParts(body: Buffer, contentType: string): Array<{ type: string; content: Buffer }> | null {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]
  if (!boundary) return null
  const text = body.toString('latin1')
  const pieces = text.split(`--${boundary}`)
  // The piece before the first boundary is empty and the one after the
  // closing boundary is `--` with an optional line break.
  if (pieces.length < 3 || pieces[0] !== '' || !pieces[pieces.length - 1].startsWith('--')) return null
  const parts: Array<{ type: string; content: Buffer }> = []
  for (const piece of pieces.slice(1, -1)) {
    const split = piece.indexOf('\r\n\r\n')
    if (!piece.startsWith('\r\n') || split < 0 || !piece.endsWith('\r\n')) return null
    const headers = piece.slice(2, split)
    const type = /^content-type:\s*(.*)$/im.exec(headers)?.[1] ?? ''
    parts.push({ type, content: Buffer.from(piece.slice(split + 4, -2), 'latin1') })
  }
  return parts
}

/** `name contains '…'` with `\'` for a quote; undefined for any other query. */
function nameContains(q: string | null): string | null | undefined {
  if (q === null) return null
  const match = /^name contains '((?:[^'\\]|\\.)*)'$/.exec(q)
  return match ? match[1].replace(/\\(.)/g, '$1') : undefined
}

interface Context {
  state: DriveState
  account: FakeAccount
  codes: Map<string, { challenge: string; clientId: string }>
  /** Each refresh token with the account it was issued for: a refresh
   *  answers that account, as Google does, whatever the account is now. */
  refreshTokens: Map<string, FakeAccount>
}

async function handleDrive(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET'
  const path = url.pathname
  const params = url.searchParams
  const fileId = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(path)?.[1]
  const upload = path.startsWith('/upload/')
  const op: DriveOp | null =
    method === 'GET' && path === '/drive/v3/files' ? 'list'
    : method === 'GET' && fileId && !upload ? 'download'
    : method === 'POST' && path === '/upload/drive/v3/files' ? 'create'
    : method === 'PATCH' && fileId && upload ? 'update'
    : method === 'PATCH' && fileId && !upload ? 'rename'
    : method === 'DELETE' && fileId && !upload ? 'delete'
    : null
  if (op === null) return send(res, 404, errorBody(404, 'Not Found', 'notFound'))
  if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) {
    return send(res, 401, errorBody(401, 'Invalid Credentials', 'authError'))
  }
  const body = await readBody(req)
  const fault = ctx.state.takeFault(op)
  if (fault) return sendFailure(res, fault)
  const fields = params.get('fields')
  const reply = (result: StoredFile | DriveFailure): void => {
    if (isFailure(result)) return sendFailure(res, result)
    const parsed = fields === null ? null : parseFields(fields)
    if (parsed === undefined || [...(parsed?.values() ?? [])].some((sub) => sub !== null)) return invalidFields(res)
    sendJson(res, pickFields(result, parsed === null ? DEFAULT_FILE_FIELDS : [...parsed.keys()]))
  }

  switch (op) {
    case 'list': {
      const filter = nameContains(params.get('q'))
      if (params.get('spaces') !== 'appDataFolder' || filter === undefined) {
        return send(res, 400, errorBody(400, 'Invalid Value', 'invalid'))
      }
      const wanted = listingFields(fields)
      if (wanted === undefined) return invalidFields(res)
      const size = params.get('pageSize')
      const page = ctx.state.list({ nameContains: filter, pageToken: params.get('pageToken'), pageSize: size === null ? null : Number(size) })
      if (isFailure(page)) return sendFailure(res, page)
      const answer: Record<string, unknown> = {}
      if (wanted.has('kind')) answer.kind = 'drive#fileList'
      if (wanted.has('incompleteSearch')) answer.incompleteSearch = false
      if (wanted.has('nextPageToken') && page.nextPageToken !== null) answer.nextPageToken = page.nextPageToken
      if (wanted.has('files')) answer.files = page.files.map((file) => pickFields(file, wanted.get('files') ?? null))
      return sendJson(res, answer)
    }
    case 'download': {
      const file = ctx.state.find(fileId ?? '')
      if (params.get('alt') !== 'media') return send(res, 400, errorBody(400, 'Only alt=media is served', 'invalid'))
      if (!file) return sendFailure(res, notFound(fileId ?? ''))
      return send(res, 200, file.content, { 'Content-Type': file.mimeType })
    }
    case 'create': {
      const parts = params.get('uploadType') === 'multipart' ? multipartParts(body, req.headers['content-type'] ?? '') : null
      if (!parts || parts.length !== 2) return send(res, 400, errorBody(400, 'Bad multipart body', 'badContent'))
      let metadata: { name?: unknown; parents?: unknown }
      try {
        metadata = JSON.parse(parts[0].content.toString('utf8')) as { name?: unknown; parents?: unknown }
      } catch {
        return send(res, 400, errorBody(400, 'Bad metadata', 'parseError'))
      }
      const inAppData = Array.isArray(metadata.parents) && metadata.parents.includes('appDataFolder')
      if (typeof metadata.name !== 'string' || !inAppData) return send(res, 400, errorBody(400, 'Bad metadata', 'invalid'))
      return reply(ctx.state.create(metadata.name, parts[1].content, parts[1].type || 'application/octet-stream'))
    }
    case 'update':
      if (params.get('uploadType') !== 'media') return send(res, 400, errorBody(400, 'Only uploadType=media is served', 'invalid'))
      return reply(ctx.state.update(fileId ?? '', body))
    case 'rename': {
      let name: unknown
      try {
        name = (JSON.parse(body.toString('utf8')) as { name?: unknown }).name
      } catch {
        name = undefined
      }
      if (typeof name !== 'string') return send(res, 400, errorBody(400, 'Bad metadata', 'invalid'))
      return reply(ctx.state.rename(fileId ?? '', name))
    }
    case 'delete': {
      const failure = ctx.state.delete(fileId ?? '')
      if (failure) return sendFailure(res, failure)
      res.writeHead(204)
      return void res.end()
    }
    default:
      return send(res, 404, errorBody(404, 'Not Found', 'notFound'))
  }
}

/** The authorization endpoint: sends the browser straight back to the
 *  loopback redirect with a code, as a consent screen would. */
function handleAuth(ctx: Context, res: ServerResponse, params: URLSearchParams): void {
  const redirect = params.get('redirect_uri')
  const challenge = params.get('code_challenge')
  if (!redirect || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(redirect) || !challenge || params.get('code_challenge_method') !== 'S256') {
    return send(res, 400, JSON.stringify({ error: 'invalid_request' }))
  }
  const code = `fake-code-${randomBytes(8).toString('hex')}`
  ctx.codes.set(code, { challenge, clientId: params.get('client_id') ?? '' })
  const target = new URL(redirect)
  target.searchParams.set('code', code)
  target.searchParams.set('state', params.get('state') ?? '')
  res.writeHead(302, { Location: target.toString() })
  res.end()
}

async function handleToken(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = new URLSearchParams((await readBody(req)).toString('utf8'))
  const fault = ctx.state.takeFault('token')
  if (fault) return sendFailure(res, fault)
  const accessToken = `fake-access-${randomBytes(8).toString('hex')}`
  const clientId = form.get('client_id') ?? ''
  if (form.get('grant_type') === 'authorization_code') {
    const issued = ctx.codes.get(form.get('code') ?? '')
    const verifier = form.get('code_verifier') ?? ''
    if (!issued || base64url(createHash('sha256').update(verifier).digest()) !== issued.challenge) {
      return send(res, 400, JSON.stringify({ error: 'invalid_grant' }))
    }
    ctx.codes.delete(form.get('code') ?? '')
    const refreshToken = `fake-refresh-${randomBytes(8).toString('hex')}`
    ctx.refreshTokens.set(refreshToken, { ...ctx.account })
    return sendJson(res, {
      access_token: accessToken,
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: 'https://www.googleapis.com/auth/drive.appdata openid email profile',
      token_type: 'Bearer',
      id_token: idToken(ctx.account, clientId),
    })
  }
  const refreshed = form.get('grant_type') === 'refresh_token' ? ctx.refreshTokens.get(form.get('refresh_token') ?? '') : undefined
  if (refreshed) {
    return sendJson(res, { access_token: accessToken, expires_in: 3600, token_type: 'Bearer', id_token: idToken(refreshed, clientId) })
  }
  return send(res, 400, JSON.stringify({ error: 'invalid_grant' }))
}

async function handleControl(ctx: Context, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (req.method === 'GET' && path === '/__control/files') {
    return sendJson(res, ctx.state.files.map((file) => ({ ...file, content: file.content.toString('base64') })))
  }
  if (req.method !== 'POST') return send(res, 404, '{}')
  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as unknown
  switch (path) {
    case '/__control/faults':
      ctx.state.inject(body as Fault)
      return sendJson(res, {})
    case '/__control/reset':
      ctx.state.reset()
      return sendJson(res, {})
    // The account the next sign-in gets; refresh tokens keep theirs.
    case '/__control/account':
      Object.assign(ctx.account, body as FakeAccount)
      return sendJson(res, {})
    default:
      return send(res, 404, '{}')
  }
}

/** Starts a fake Drive on 127.0.0.1 (on `port`, or a free one). */
export async function startFakeDrive(options: { port?: number; account?: FakeAccount } = {}): Promise<FakeDrive> {
  const ctx: Context = {
    state: new DriveState(),
    account: { ...(options.account ?? DEFAULT_ACCOUNT) },
    codes: new Map(),
    refreshTokens: new Map(),
  }
  const requests: FakeDrive['requests'] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const route = async (): Promise<void> => {
      if (path.startsWith('/__control/')) return handleControl(ctx, req, res, path)
      requests.push({ method: req.method ?? 'GET', path, query: Object.fromEntries(url.searchParams) })
      if (req.method === 'GET' && path === '/oauth/auth') return handleAuth(ctx, res, url.searchParams)
      if (req.method === 'POST' && path === '/oauth/token') return handleToken(ctx, req, res)
      return handleDrive(ctx, req, res, url)
    }
    route().catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, errorBody(500, String(err).replace(/"/g, "'"), 'backendError'))
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const { address, port } = server.address() as AddressInfo
  if (address !== '127.0.0.1') throw new Error(`the fake Drive listens on ${address}`)
  return {
    url: `http://127.0.0.1:${port}`,
    state: ctx.state,
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
  startFakeDrive({ port }).then((drive) => {
    console.log(JSON.stringify({ url: drive.url, env: fakeDriveEnv(drive.url) }))
    const stop = (): void => void drive.close().then(() => process.exit(0))
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  }, (err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
