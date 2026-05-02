// SPDX-License-Identifier: GPL-2.0-or-later
// Hub API client for /api/key-labels — list/download (public),
// upload/update/delete (auth required). Mirrors the patterns in hub-client.ts:
// the same HubHttpError taxonomy is reused via re-exports there, and bodies
// are JSON (no multipart needed).

import { Hub401Error, Hub403Error, Hub409Error, Hub429Error } from './hub-client'
import type {
  HubKeyLabelItem,
  HubKeyLabelListResponse,
  HubKeyLabelListParams,
} from '../../shared/types/hub-key-label'

const HUB_API_DEFAULT = 'https://pipette-hub-worker.keymaps.workers.dev'
const isDev = !!process.env.ELECTRON_RENDERER_URL
const HUB_API_BASE = (isDev && process.env.PIPETTE_HUB_URL) || HUB_API_DEFAULT
const MAX_RETRY_AFTER_S = 60

/** Body of `GET /api/key-labels/:id/download`. */
export interface HubKeyLabelDownload {
  name: string
  map: Record<string, string>
  composite_labels: Record<string, string> | null
}

/** Request body for `POST /api/key-labels` and `PUT /api/key-labels/:id`. */
export interface HubKeyLabelInput {
  name: string
  map: Record<string, string>
  compositeLabels?: Record<string, string> | null
}

interface HubApiResponse<T> {
  ok: boolean
  data: T
  error?: string
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function hubFetch<T>(url: string, init: RequestInit, label: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, init)

    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
      if (attempt === 0 && retryAfter != null && retryAfter <= MAX_RETRY_AFTER_S) {
        await sleep(retryAfter * 1000)
        continue
      }
      const text = await response.text()
      throw new Hub429Error(label, text, retryAfter)
    }

    if (!response.ok) {
      const text = await response.text()
      if (response.status === 401) throw new Hub401Error(label, text)
      if (response.status === 403) throw new Hub403Error(label, text)
      if (response.status === 409) throw new Hub409Error(label, text)
      throw new Error(`${label}: ${String(response.status)} ${text}`)
    }

    const json = (await response.json()) as HubApiResponse<T>
    if (!json.ok) {
      throw new Error(`${label}: ${json.error ?? 'unknown error'}`)
    }
    return json.data
  }
  /* istanbul ignore next */
  throw new Error(`${label}: unexpected retry exhaustion`)
}

export async function fetchKeyLabelList(query: HubKeyLabelListParams): Promise<HubKeyLabelListResponse> {
  const qs = new URLSearchParams()
  if (query.q && query.q.trim()) qs.set('q', query.q.trim())
  if (query.page != null) qs.set('page', String(query.page))
  if (query.perPage != null) qs.set('per_page', String(query.perPage))
  const tail = qs.toString()
  const url = `${HUB_API_BASE}/api/key-labels${tail ? `?${tail}` : ''}`
  return hubFetch<HubKeyLabelListResponse>(url, { method: 'GET' }, 'Hub key-label list failed')
}

export async function fetchKeyLabelDetail(hubPostId: string): Promise<HubKeyLabelItem> {
  return hubFetch<HubKeyLabelItem>(
    `${HUB_API_BASE}/api/key-labels/${encodeURIComponent(hubPostId)}`,
    { method: 'GET' },
    'Hub key-label fetch failed',
  )
}

export async function downloadKeyLabel(hubPostId: string): Promise<HubKeyLabelDownload> {
  const url = `${HUB_API_BASE}/api/key-labels/${encodeURIComponent(hubPostId)}/download`
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const text = await response.text()
    if (response.status === 401) throw new Hub401Error('Hub key-label download failed', text)
    if (response.status === 403) throw new Hub403Error('Hub key-label download failed', text)
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
      throw new Hub429Error('Hub key-label download failed', text, retryAfter)
    }
    throw new Error(`Hub key-label download failed: ${String(response.status)} ${text}`)
  }
  return (await response.json()) as HubKeyLabelDownload
}

function buildBody(input: HubKeyLabelInput): string {
  const body: Record<string, unknown> = { name: input.name, map: input.map }
  if (input.compositeLabels !== undefined) {
    body.composite_labels = input.compositeLabels ?? null
  }
  return JSON.stringify(body)
}

export async function uploadKeyLabel(jwt: string, input: HubKeyLabelInput): Promise<HubKeyLabelItem> {
  return hubFetch<HubKeyLabelItem>(`${HUB_API_BASE}/api/key-labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: buildBody(input),
  }, 'Hub key-label upload failed')
}

export async function updateKeyLabel(
  jwt: string,
  hubPostId: string,
  input: HubKeyLabelInput,
): Promise<HubKeyLabelItem> {
  return hubFetch<HubKeyLabelItem>(
    `${HUB_API_BASE}/api/key-labels/${encodeURIComponent(hubPostId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: buildBody(input),
    },
    'Hub key-label update failed',
  )
}

export async function deleteKeyLabel(jwt: string, hubPostId: string): Promise<void> {
  await hubFetch<unknown>(
    `${HUB_API_BASE}/api/key-labels/${encodeURIComponent(hubPostId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    },
    'Hub key-label delete failed',
  )
}
