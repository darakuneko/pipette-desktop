// SPDX-License-Identifier: GPL-2.0-or-later
// Retry with exponential backoff for Google Drive API requests

import { syncRuntime } from './sync-runtime-state'

const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000
/** Upper bound of the random extra wait added to each backoff step, as in
 *  Google's exponential-backoff guidance (base delay + up to 1s of jitter). */
const JITTER_MS = 1000
// A sync pass holds the sync lock while it waits, so a long server-requested
// pause would block every other sync; the next pass retries anyway.
const MAX_RETRY_AFTER_MS = 30_000

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded'])

const QUIT_CHECK_INTERVAL_MS = 250

/** Waits `ms`, checking in short slices so the wait ends as soon as the app
 *  starts quitting. */
async function sleepUntilQuit(ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!syncRuntime.isQuitting) {
    const remaining = end - Date.now()
    if (remaining <= 0) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, QUIT_CHECK_INTERVAL_MS)))
  }
}

/** Indirection so tests can replace the wait and the jitter source. */
export const retryTiming = {
  sleep: sleepUntilQuit,
  random: (): number => Math.random(),
}

// The before-quit handler holds the app open until pending changes are
// flushed, so no retry starts (and no wait continues) once quitting begins.
// Checked when deciding to retry and again after the wait, since quitting
// can begin while a request or a wait is in progress.
function canRetry(attempt: number): boolean {
  return attempt < MAX_ATTEMPTS && !syncRuntime.isQuitting
}

/** Waits before the next attempt; throws `error` instead if quitting began
 *  during the wait. */
async function waitBeforeRetry(ms: number, error: unknown): Promise<void> {
  await retryTiming.sleep(ms)
  if (syncRuntime.isQuitting) throw error
}

export interface DriveRequestOptions {
  /** Verb used in the thrown message: `Drive <label> failed: <status> <body>`. */
  label: string
  /** Called before every attempt so a refreshed access token is picked up. */
  getHeaders: () => Promise<Record<string, string>>
  send: (headers: Record<string, string>) => Promise<Response>
  /** Whether 5xx responses and network errors are retried. Rate-limit
   *  responses (429, rate-limit 403) are always retried, because Drive
   *  rejects those before doing any work. */
  retryTransient: boolean
  /** Non-ok statuses the caller handles itself (returned, not thrown). */
  acceptStatus?: (status: number) => boolean
}

export interface DriveResponse {
  status: number
  /** Response body, read inside the attempt so a connection dropped while
   *  the body streams is handled like any other network error. */
  text: string
}

/** Drive v3 error body: `{ error: { errors: [{ reason }] } }`. Anything
 *  that does not have that shape is treated as "not a rate limit". */
function isRateLimitBody(body: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const error = (parsed as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return false
  const errors = (error as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return false
  return errors.some((e: unknown) => {
    if (typeof e !== 'object' || e === null) return false
    const reason = (e as { reason?: unknown }).reason
    return typeof reason === 'string' && RATE_LIMIT_REASONS.has(reason)
  })
}

function isRetryableStatus(status: number, body: string, retryTransient: boolean): boolean {
  if (status === 429) return true
  if (status === 403) return isRateLimitBody(body)
  return retryTransient && status >= 500
}

/** `Retry-After` as delay-seconds or an HTTP date; null when absent or
 *  unparseable, so the caller falls back to backoff. */
function retryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const seconds = Number(value)
  let ms: number
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000
  } else {
    const date = Date.parse(value)
    if (Number.isNaN(date)) return null
    ms = date - Date.now()
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS)
}

function backoffMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(retryTiming.random() * JITTER_MS)
}

/** Sends a Drive request, retrying transient failures up to `MAX_ATTEMPTS`
 *  times. Resolves with the status and body when the response is ok or
 *  accepted; otherwise throws `Drive <label> failed: <status> <body>`, or
 *  rethrows the network error, from the last attempt. Errors from
 *  `getHeaders` are not retried. */
export async function driveRequest(options: DriveRequestOptions): Promise<DriveResponse> {
  const { label, getHeaders, send, retryTransient, acceptStatus } = options
  for (let attempt = 1; ; attempt++) {
    const headers = await getHeaders()

    let response: Response
    let text: string
    try {
      response = await send(headers)
      text = await response.text()
    } catch (err) {
      if (!retryTransient || !canRetry(attempt)) throw err
      await waitBeforeRetry(backoffMs(attempt), err)
      continue
    }

    const { status } = response
    if (response.ok || acceptStatus?.(status)) return { status, text }

    const error = new Error(`Drive ${label} failed: ${status} ${text}`)
    if (!canRetry(attempt) || !isRetryableStatus(status, text, retryTransient)) throw error
    await waitBeforeRetry(retryAfterMs(response.headers.get('Retry-After')) ?? backoffMs(attempt), error)
  }
}
