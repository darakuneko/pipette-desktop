// SPDX-License-Identifier: GPL-2.0-or-later
// The request and answer of a fake Hub route (hub-routes.ts,
// hub-routes-packs.ts) and what they share: the `{ok, data}` and
// `{ok: false, error}` envelopes, the JSON and multipart/form-data bodies
// read as the Hub's framework reads them, the Hub's bearer check and its
// page parameters.

import type { HubState, HubUser } from './hub-state'
import { decodeUtf8 } from './hub-validate'

export interface HubRequest {
  method: string
  path: string
  query: URLSearchParams
  authorization: string | undefined
  contentType: string
  body: Buffer
}

export interface HubAnswer {
  status: number
  body: string
  headers?: Record<string, string>
}

export function answerJson(status: number, value: unknown): HubAnswer {
  return { status, body: JSON.stringify(value) }
}

export function ok(data: unknown, status = 200): HubAnswer {
  return answerJson(status, { ok: true, data })
}

export function fail(status: number, error: string): HubAnswer {
  return answerJson(status, { ok: false, error })
}

export function isAnswer(value: unknown): value is HubAnswer {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value
}

/** The body as JSON; undefined when it does not parse. */
export function readJson(req: HubRequest): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(decodeUtf8(req.body)) as unknown }
  } catch {
    return undefined
  }
}

/** The body of a route that takes a JSON object, or the Hub's refusal. */
export function readJsonObject(req: HubRequest): Record<string, unknown> | HubAnswer {
  const parsed = readJson(req)
  if (!parsed) return fail(400, 'Invalid JSON')
  const value = parsed.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(400, 'Request body must be a JSON object')
  return value as Record<string, unknown>
}

/** The Hub's `parseJsonBody`: an object with an `error` field reads as
 *  the parse failure it stands for, as on the Hub. */
export function readJsonBody(req: HubRequest): unknown {
  const parsed = readJson(req)
  if (!parsed) return fail(400, 'Invalid JSON')
  const value = parsed.value
  if (value !== null && typeof value === 'object' && 'error' in value) return fail(400, String((value as { error: unknown }).error))
  return value
}

export interface FormFile {
  filename: string
  contentType: string
  bytes: Buffer
}

export type FormValue = string | FormFile

export function isFile(value: FormValue | undefined): value is FormFile {
  return typeof value === 'object'
}

/** The parts of a multipart/form-data body by name (the last one of a
 *  name wins): a part with a filename is a file, any other a text field.
 *  Any other body has no fields. */
export function readForm(req: HubRequest): Record<string, FormValue> {
  const boundary = /^multipart\/form-data;.*\bboundary=("?)([^";]+)\1/i.exec(req.contentType)?.[2]
  if (!boundary) return {}
  const text = req.body.toString('latin1')
  const form: Record<string, FormValue> = {}
  for (const piece of text.split(`--${boundary}`).slice(1)) {
    if (piece.startsWith('--')) break
    const split = piece.indexOf('\r\n\r\n')
    if (!piece.startsWith('\r\n') || split < 0) continue
    const headers = piece.slice(2, split)
    const end = piece.endsWith('\r\n') ? piece.length - 2 : piece.length
    const content = Buffer.from(piece.slice(split + 4, end), 'latin1')
    const disposition = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? ''
    const name = /\bname="([^"]*)"/.exec(disposition)?.[1]
    if (name === undefined) continue
    const filename = /\bfilename="([^"]*)"/.exec(disposition)?.[1]
    const contentType = /^content-type:\s*(.*)$/im.exec(headers)?.[1]?.trim() ?? 'application/octet-stream'
    form[name] = filename === undefined ? content.toString('utf8') : { filename: Buffer.from(filename, 'latin1').toString('utf8'), contentType, bytes: content }
  }
  return form
}

/** The account of the request's bearer JWT, or the Hub's refusal. */
export function authenticate(state: HubState, req: HubRequest): HubUser | HubAnswer {
  const header = req.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token) return fail(401, 'Authentication required')
  const userId = state.jwts.get(token)
  if (userId === undefined) return fail(401, 'Invalid or expired token')
  const user = state.userById(userId)
  if (!user || !user.is_active) return fail(403, 'Account is deactivated')
  return user
}

/** `page` (1 and up) and `per_page` (1 to 100, 20 when absent). */
export function pagination(req: HubRequest): { page: number; perPage: number } {
  const page = Math.max(1, Number(req.query.get('page')) || 1)
  const perPage = Math.min(100, Math.max(1, Number(req.query.get('per_page')) || 20))
  return { page, perPage }
}

export function pageOf<T>(records: T[], page: number, perPage: number): T[] {
  const offset = (page - 1) * perPage
  return records.slice(offset, offset + perPage)
}

export function stringOrNull(value: FormValue | unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}
