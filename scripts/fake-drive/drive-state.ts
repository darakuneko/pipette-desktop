// SPDX-License-Identifier: GPL-2.0-or-later
// The files of the Node fake Drive (server.ts) and the failures injected
// into its answers. It behaves as the in-memory Drive of
// src-tauri/crates/pipette-drive (src/fake.rs) does; both pass the cases of
// conformance-cases.json:
//   - files are listed in the order they were created; `name contains` is
//     a substring match; a page holds up to `pageSize` files (1 to 1000,
//     100 when the request has none);
//   - ids are `fake-1`, `fake-2`, …;
//   - every write (create, update, rename) moves the clock one second on
//     from 2026-01-01T00:00:00.000Z and stamps the file with it. A rename
//     counts as a write: real Drive may or may not move `modifiedTime` on
//     a rename, and the sync must work either way;
//   - an unknown id is 404.

/** 2026-01-01T00:00:00.000Z. */
const CLOCK_START_MS = 1_767_225_600_000
const CLOCK_STEP_MS = 1000
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 1000

export type DriveOp = 'list' | 'download' | 'create' | 'update' | 'rename' | 'delete' | 'token'

export interface StoredFile {
  id: string
  name: string
  modifiedTime: string
  createdTime: string
  content: Buffer
  mimeType: string
}

/** A failure the next requests get instead of their answer. */
export interface Fault {
  status: number
  /** The `Retry-After` header; none when absent or null. */
  retryAfter?: string | null
  /** The body; a Drive error body for the status when absent. */
  body?: string
  /** How many requests fail. */
  count: number
  /** Only requests of this operation fail; any when absent. */
  only?: DriveOp
}

/** An answer that is not a success. */
export interface DriveFailure {
  status: number
  body: string
  retryAfter: string | null
}

/** A Drive v3 error body, the same text the in-memory Drive writes. */
export function errorBody(code: number, message: string, reason: string): string {
  return `{"error":{"code":${code},"message":"${message}","errors":[{"reason":"${reason}","message":"${message}"}]}}`
}

export function notFound(id: string): DriveFailure {
  return { status: 404, body: errorBody(404, `File not found: ${id}.`, 'notFound'), retryAfter: null }
}

function faultBody(status: number): string {
  return status === 429
    ? errorBody(429, 'Rate Limit Exceeded', 'rateLimitExceeded')
    : errorBody(status, 'Injected failure', 'backendError')
}

export interface ListQuery {
  nameContains: string | null
  pageToken: string | null
  pageSize: number | null
}

export class DriveState {
  /** In the order they were created. */
  files: StoredFile[] = []
  private nextId = 0
  private clockMs = 0
  private faults: Fault[] = []

  reset(): void {
    this.files = []
    this.nextId = 0
    this.clockMs = 0
    this.faults = []
  }

  inject(fault: Fault): void {
    if (fault.count > 0) this.faults.push({ ...fault })
  }

  /** The injected failure for a request of `op`, if one is due. */
  takeFault(op: DriveOp): DriveFailure | null {
    const index = this.faults.findIndex((fault) => fault.only === undefined || fault.only === op)
    if (index < 0) return null
    const fault = this.faults[index]
    fault.count -= 1
    if (fault.count <= 0) this.faults.splice(index, 1)
    return { status: fault.status, body: fault.body ?? faultBody(fault.status), retryAfter: fault.retryAfter ?? null }
  }

  private tick(): string {
    this.clockMs = this.clockMs === 0 ? CLOCK_START_MS : this.clockMs + CLOCK_STEP_MS
    return new Date(this.clockMs).toISOString()
  }

  find(id: string): StoredFile | undefined {
    return this.files.find((file) => file.id === id)
  }

  create(name: string, content: Buffer, mimeType: string): StoredFile {
    this.nextId += 1
    const now = this.tick()
    const file: StoredFile = { id: `fake-${this.nextId}`, name, modifiedTime: now, createdTime: now, content, mimeType }
    this.files.push(file)
    return file
  }

  update(id: string, content: Buffer): StoredFile | DriveFailure {
    const file = this.find(id)
    if (!file) return notFound(id)
    file.content = content
    file.modifiedTime = this.tick()
    return file
  }

  rename(id: string, name: string): StoredFile | DriveFailure {
    const file = this.find(id)
    if (!file) return notFound(id)
    file.name = name
    file.modifiedTime = this.tick()
    return file
  }

  delete(id: string): DriveFailure | null {
    const index = this.files.findIndex((file) => file.id === id)
    if (index < 0) return notFound(id)
    this.files.splice(index, 1)
    return null
  }

  list(query: ListQuery): { files: StoredFile[]; nextPageToken: string | null } | DriveFailure {
    const size = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
    let start = 0
    if (query.pageToken !== null) {
      const match = /^page-(\d+)$/.exec(query.pageToken)
      if (!match) return { status: 400, body: errorBody(400, 'Invalid Value', 'invalid'), retryAfter: null }
      start = Number(match[1])
    }
    const filter = query.nameContains
    const matching = this.files.filter((file) => filter === null || file.name.includes(filter))
    const next = start + size
    return { files: matching.slice(start, next), nextPageToken: next < matching.length ? `page-${next}` : null }
  }
}

export function isFailure(value: object): value is DriveFailure {
  return 'status' in value && 'body' in value && 'retryAfter' in value
}
