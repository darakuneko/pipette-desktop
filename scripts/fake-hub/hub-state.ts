// SPDX-License-Identifier: GPL-2.0-or-later
// The records of the fake Hub (server.ts) and the failures injected into
// its answers. It is deterministic, so a recorded request log or a
// response compares across runs:
//   - every id (accounts, posts, packs, key labels) is UUID-shaped from one
//     counter: 00000000-0000-4000-8000-000000000001, …002, …;
//   - every write moves the clock one second on from
//     2026-01-01T00:00:00.000Z. The stamps have the Hub's SQLite formats:
//     `2026-01-01 00:00:01.000Z` for `updated_at` (and `created_at` of
//     packs and key labels), `2026-01-01 00:00:01` for a post's
//     `created_at`;
//   - a Hub JWT is `<header>.<payload>.<signature>` with the payload of the
//     Hub's (`sub`, `email`, `role`, `exp`, `iat`; `iat` is the clock) and a
//     counter as its signature. The fake knows every JWT it issued: an
//     unknown one is 401, as a bad signature or an expired token is;
//   - a private share token is `pt_v1_` and 43 characters from a counter;
//   - the Hub's built-in account (the owner of its built-in key labels) is
//     there from the start, as the Hub's migrations create it.
// The answers' fields are in the order of the Hub's (its SQL columns and
// response builders).

import { THEME_PREVIEW_KEYS, asciiLower } from './hub-validate'

/** 2026-01-01T00:00:00.000Z. */
const CLOCK_START_MS = 1_767_225_600_000
const CLOCK_STEP_MS = 1000
const JWT_MAX_AGE_S = 7 * 24 * 60 * 60
const DAY_MS = 24 * 60 * 60 * 1000

/** The owner of the Hub's built-in key labels. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'

export interface HubUser {
  id: string
  email: string
  display_name: string | null
  role: 'user' | 'moderator' | 'admin'
  is_active: boolean
}

export interface PostFile {
  file_type: string
  original_filename: string
  file_size: number
}

export interface HubPost {
  id: string
  title: string
  keyboard_name: string | null
  uploaded_by: string
  download_count: number
  created_at: string
  updated_at: string
  post_type: string
  keyboard_uid: string | null
  total_keystrokes: number | null
  range_from_ms: number | null
  range_to_ms: number | null
  files: PostFile[]
}

export interface PrivatePost extends HubPost {
  token: string
  expires_at: string
}

export type PackKind = 'i18n' | 'theme'

export interface HubPack {
  id: string
  name: string
  version: string
  /** The uploaded JSON text, as the Hub keeps it. */
  pack_json: string
  uploaded_by: string | null
  created_at: string
  updated_at: string
}

export interface HubKeyLabel {
  id: string
  name: string
  map: Record<string, string>
  composite_labels: Record<string, string> | null
  keymap_applicable: boolean
  uploaded_by: string | null
  created_at: string
  updated_at: string
}

/** The name of each route, for the request log and for a fault to target. */
export type HubOp =
  | 'auth.token' | 'auth.me' | 'auth.patchMe'
  | 'files.me' | 'files.meKeyboard' | 'files.get' | 'files.create' | 'files.update' | 'files.patch' | 'files.delete'
  | 'private.create' | 'private.delete'
  | `${'i18n' | 'theme'}.${'list' | 'get' | 'download' | 'timestamps' | 'create' | 'update' | 'delete'}`
  | `keyLabels.${'list' | 'get' | 'download' | 'timestamps' | 'create' | 'update' | 'delete'}`

/** An answer the next requests get instead of theirs. */
export interface Fault {
  status: number
  /** The `Retry-After` header; none when absent or null. */
  retryAfter?: string | null
  /** The body; `{"ok":false,"error":…}` with the Hub's text for the status
   *  when absent. A 200 with `{"ok":false,…}` or an unwrapped body tests
   *  the clients' reading of the envelope. */
  body?: string
  count: number
  /** Only requests of this route fail; any API route when absent. */
  only?: HubOp
}

const FAULT_ERRORS: Record<number, string> = {
  400: 'Bad request',
  401: 'Invalid or expired token',
  403: 'Account is deactivated',
  404: 'Not found',
  409: 'Conflict',
  413: 'Request body too large',
  429: 'Too many requests',
  500: 'Internal server error',
}

export function faultBody(status: number): string {
  return JSON.stringify({ ok: false, error: FAULT_ERRORS[status] ?? 'Injected failure' })
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url')
}

/** `2026-01-01 00:00:01.000Z` */
export function sqlIsoStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ')
}

/** `2026-01-01 00:00:01` */
function sqlDatetimeStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

export class HubState {
  users: HubUser[] = []
  posts: HubPost[] = []
  privatePosts: PrivatePost[] = []
  packs: Record<PackKind, HubPack[]> = { i18n: [], theme: [] }
  keyLabels: HubKeyLabel[] = []
  /** Each JWT the fake issued and the account it is for. */
  jwts = new Map<string, string>()
  private nextId = 0
  private nextToken = 0
  private clockMs = CLOCK_START_MS
  private faults: Fault[] = []

  constructor() {
    this.reset()
  }

  reset(): void {
    this.users = [{ id: SYSTEM_USER_ID, email: 'pipette@pipette-hub.system', display_name: 'pipette', role: 'user', is_active: true }]
    this.posts = []
    this.privatePosts = []
    this.packs = { i18n: [], theme: [] }
    this.keyLabels = []
    this.jwts = new Map()
    this.nextId = 0
    this.nextToken = 0
    this.clockMs = CLOCK_START_MS
    this.faults = []
  }

  inject(fault: Fault): void {
    if (fault.count > 0) this.faults.push({ ...fault })
  }

  /** The injected answer for a request of `op`, if one is due. */
  takeFault(op: HubOp): { status: number; body: string; retryAfter: string | null } | null {
    const index = this.faults.findIndex((fault) => fault.only === undefined || fault.only === op)
    if (index < 0) return null
    const fault = this.faults[index]
    fault.count -= 1
    if (fault.count <= 0) this.faults.splice(index, 1)
    return { status: fault.status, body: fault.body ?? faultBody(fault.status), retryAfter: fault.retryAfter ?? null }
  }

  newId(): string {
    this.nextId += 1
    return `00000000-0000-4000-8000-${String(this.nextId).padStart(12, '0')}`
  }

  /** Moves the clock on for a write; its time in milliseconds. */
  tick(): number {
    this.clockMs += CLOCK_STEP_MS
    return this.clockMs
  }

  /** `updatedAt` when given, else the next tick, in the Hub's format. */
  stamp(updatedAt?: string): string {
    return updatedAt ?? sqlIsoStamp(this.tick())
  }

  // --- Accounts ----------------------------------------------------------------

  userById(id: string): HubUser | undefined {
    return this.users.find((user) => user.id === id)
  }

  userByEmail(email: string): HubUser | undefined {
    return this.users.find((user) => user.email === email)
  }

  /** Another account with this display name, ASCII case ignored. */
  displayNameTaken(name: string, exceptId?: string): boolean {
    const lower = asciiLower(name)
    return this.users.some((user) => user.id !== exceptId && user.display_name != null && asciiLower(user.display_name) === lower)
  }

  createUser(email: string, displayName: string | null): HubUser {
    const user: HubUser = { id: this.newId(), email, display_name: displayName, role: 'user', is_active: true }
    this.users.push(user)
    return user
  }

  issueJwt(user: HubUser): string {
    this.nextToken += 1
    const iat = Math.floor(this.clockMs / 1000)
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ sub: user.id, email: user.email, role: user.role, exp: iat + JWT_MAX_AGE_S, iat }))
    const jwt = `${header}.${payload}.${base64url(`fake-hub-jwt-${this.nextToken}`)}`
    this.jwts.set(jwt, user.id)
    return jwt
  }

  privateToken(): { token: string; expiresAt: (days: number) => string } {
    this.nextToken += 1
    const token = `pt_v1_fakeprivatetoken${String(this.nextToken).padStart(27, '0')}`
    return { token, expiresAt: (days) => new Date(this.clockMs + days * DAY_MS).toISOString() }
  }

  // --- Posts -------------------------------------------------------------------

  newPost(fields: Omit<HubPost, 'id' | 'download_count' | 'created_at' | 'updated_at'>, updatedAt?: string): HubPost {
    const ms = this.tick()
    return {
      id: this.newId(),
      ...fields,
      download_count: 0,
      created_at: sqlDatetimeStamp(ms),
      updated_at: updatedAt ?? sqlIsoStamp(ms),
    }
  }

  /** A post in the shape of the Hub's answers. Private posts have no other
   *  fields here: the Hub's private upload answers with the share link. */
  publicPost(post: HubPost): Record<string, unknown> {
    return {
      id: post.id,
      title: post.title,
      keyboard_name: post.keyboard_name,
      uploaded_by: post.uploaded_by,
      download_count: post.download_count,
      created_at: post.created_at,
      updated_at: post.updated_at,
      post_type: post.post_type,
      keyboard_uid: post.keyboard_uid,
      total_keystrokes: post.total_keystrokes,
      range_from_ms: post.range_from_ms,
      range_to_ms: post.range_to_ms,
      uploader_name: this.userById(post.uploaded_by)?.display_name ?? null,
      // The Hub reads a post's files through the (post, file type) key, so
      // they come in file type order.
      files: [...post.files].sort((a, b) => (a.file_type < b.file_type ? -1 : a.file_type > b.file_type ? 1 : 0)).map((file) => ({ ...file })),
    }
  }

  /** The posts of `userId`, the most recently updated first. */
  postsOf(userId: string): HubPost[] {
    return byUpdatedDesc(this.posts.filter((post) => post.uploaded_by === userId))
  }

  // --- Packs and key labels ----------------------------------------------------

  packSummary(kind: PackKind, pack: HubPack): Record<string, unknown> {
    const owner = pack.uploaded_by === null ? undefined : this.userById(pack.uploaded_by)
    const common = { uploaded_by: pack.uploaded_by, uploader_name: owner?.display_name ?? null, created_at: pack.created_at, updated_at: pack.updated_at }
    if (kind === 'i18n') return { id: pack.id, name: pack.name, version: pack.version, ...common }
    const body = themeBody(pack.pack_json)
    return {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      colorScheme: body.colorScheme,
      preview_colors: THEME_PREVIEW_KEYS.map((key) => body.colors?.[key] || '#cccccc'),
      ...common,
    }
  }

  packDetail(kind: PackKind, pack: HubPack): Record<string, unknown> {
    return { ...this.packSummary(kind, pack), pack: kind === 'i18n' ? i18nBody(pack.pack_json) : themeBody(pack.pack_json) }
  }

  publicKeyLabel(label: HubKeyLabel): Record<string, unknown> {
    const owner = label.uploaded_by === null ? undefined : this.userById(label.uploaded_by)
    return {
      id: label.id,
      name: label.name,
      map: { ...label.map },
      composite_labels: label.composite_labels === null ? null : { ...label.composite_labels },
      keymap_applicable: label.keymap_applicable,
      uploaded_by: label.uploaded_by,
      uploader_name: owner?.display_name ?? null,
      created_at: label.created_at,
      updated_at: label.updated_at,
    }
  }

  /** The record of `kind` with this id, for the control endpoints. */
  findRecord(kind: 'post' | 'privatePost' | PackKind | 'keyLabel', id: string): { updated_at: string } | undefined {
    switch (kind) {
      case 'post':
        return this.posts.find((post) => post.id === id)
      case 'privatePost':
        return this.privatePosts.find((post) => post.id === id)
      case 'keyLabel':
        return this.keyLabels.find((label) => label.id === id)
      default:
        return this.packs[kind].find((pack) => pack.id === id)
    }
  }
}

/** Newest `updated_at` first; among equal stamps the later record first. */
export function byUpdatedDesc<T extends { updated_at: string }>(records: T[]): T[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => (a.record.updated_at === b.record.updated_at ? b.index - a.index : a.record.updated_at < b.record.updated_at ? 1 : -1))
    .map(({ record }) => record)
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The `pack` of a stored language pack export. */
function i18nBody(raw: string): Record<string, unknown> {
  const pack = parseObject(raw)?.pack
  return pack !== null && typeof pack === 'object' && !Array.isArray(pack) ? (pack as Record<string, unknown>) : { name: '', version: '' }
}

/** A stored theme pack body; the Hub's stand-in when it does not parse. */
function themeBody(raw: string): Record<string, unknown> & { colors?: Record<string, string> } {
  return parseObject(raw) ?? { name: '', version: '', colorScheme: 'light', colors: {} }
}
