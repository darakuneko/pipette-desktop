// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hub client surface for `/api/i18n-packs`. Pipette Hub split language
// packs out of `/api/files` into a dedicated `i18n_packs` table because
// they are dictionary-style shared resources (one .json per record, no
// thumbnail, name+version identity) — the same shape as `key_labels`.
// This file owns the multipart upload, list/detail/download fetchers,
// and the export envelope validator that mirrors the desktop-side
// pack validator in `src/shared/i18n/validate.ts`.

import {
  Hub401Error,
  Hub403Error,
  Hub409Error,
  Hub429Error,
  type HubPostResponse,
} from './hub-client'
import { validatePack } from '../../shared/i18n/validate'
import type {
  HubI18nExportV1,
  HubI18nPackBody,
  HubI18nPackTimestampsResponse,
  HubI18nPostListItem,
} from '../../shared/types/hub'

const HUB_API_DEFAULT = 'https://pipette-hub-worker.keymaps.workers.dev'
const isDev = !!process.env.ELECTRON_RENDERER_URL
const HUB_API_BASE = (isDev && process.env.PIPETTE_HUB_URL) || HUB_API_DEFAULT
const MAX_RETRY_AFTER_S = 60

const I18N_PACKS_ROUTE = '/api/i18n-packs'
const i18nPackRoute = (postId: string): string =>
  `${I18N_PACKS_ROUTE}/${encodeURIComponent(postId)}`
const i18nPackDownloadRoute = (postId: string): string => `${i18nPackRoute(postId)}/download`

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

async function hubFetchJson<T>(url: string, init: RequestInit, label: string): Promise<T> {
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
    const json = (await response.json()) as HubApiResponse<T> | T
    if (json && typeof json === 'object' && 'ok' in json) {
      const wrapped = json as HubApiResponse<T>
      if (!wrapped.ok) throw new Error(`${label}: ${wrapped.error ?? 'unknown error'}`)
      return wrapped.data
    }
    return json as T
  }
  /* istanbul ignore next */
  throw new Error(`${label}: unexpected retry exhaustion`)
}

// --- Export builder + validator ---------------------------------------------

export function buildI18nExport(pack: HubI18nPackBody): HubI18nExportV1 {
  return {
    version: 1,
    kind: 'i18n',
    exportedAt: new Date().toISOString(),
    pack,
  }
}

export interface I18nExportValidation {
  ok: boolean
  reason?: string
  warnings: string[]
}

export function validateI18nExport(exp: unknown): I18nExportValidation {
  if (!exp || typeof exp !== 'object') {
    return { ok: false, reason: 'export must be an object', warnings: [] }
  }
  const obj = exp as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, reason: `unsupported version: ${String(obj.version)}`, warnings: [] }
  }
  if (obj.kind !== 'i18n') {
    return { ok: false, reason: `unexpected kind: ${String(obj.kind)}`, warnings: [] }
  }
  if (typeof obj.exportedAt !== 'string') {
    return { ok: false, reason: 'exportedAt must be an ISO 8601 string', warnings: [] }
  }
  const validation = validatePack(obj.pack)
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.errors[0] ?? 'invalid pack body',
      warnings: validation.warnings,
    }
  }
  return { ok: true, warnings: validation.warnings }
}

// --- Hub list / detail / download (read-only, anonymous) --------------------

export interface HubI18nListParams {
  q?: string
  page?: number
  perPage?: number
  /** Optional exact-name match; used to fetch every version of a single pack. */
  name?: string
}

export interface HubI18nListResponse {
  items: HubI18nPostListItem[]
  total: number
  page: number
  perPage: number
}

interface HubI18nPackSummaryRaw {
  id: string
  name: string
  version: string
  uploaded_by?: string | null
  uploader_name?: string | null
  created_at: string
  updated_at?: string
}

interface HubI18nPackPaginatedRaw {
  items: HubI18nPackSummaryRaw[]
  total: number
  page: number
  per_page: number
}

export async function fetchI18nPostList(query: HubI18nListParams): Promise<HubI18nListResponse> {
  const qs = new URLSearchParams()
  if (query.q && query.q.trim()) qs.set('q', query.q.trim())
  if (query.name && query.name.trim()) qs.set('name', query.name.trim())
  if (query.page != null) qs.set('page', String(query.page))
  if (query.perPage != null) qs.set('per_page', String(query.perPage))
  const search = qs.toString()
  const url = `${HUB_API_BASE}${I18N_PACKS_ROUTE}${search ? `?${search}` : ''}`
  const raw = await hubFetchJson<HubI18nPackPaginatedRaw>(url, { method: 'GET' }, 'Hub i18n list failed')
  return {
    items: raw.items.map((item) => ({
      id: item.id,
      name: item.name,
      version: item.version,
      uploadedBy: item.uploaded_by ?? null,
      uploaderName: item.uploader_name ?? null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
    total: raw.total,
    page: raw.page,
    perPage: raw.per_page,
  }
}

export async function downloadI18nPostBody(postId: string): Promise<HubI18nExportV1> {
  const url = `${HUB_API_BASE}${i18nPackDownloadRoute(postId)}`
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const text = await response.text()
    if (response.status === 401) throw new Hub401Error('Hub i18n download failed', text)
    if (response.status === 403) throw new Hub403Error('Hub i18n download failed', text)
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
      throw new Hub429Error('Hub i18n download failed', text, retryAfter)
    }
    throw new Error(`Hub i18n download failed: ${String(response.status)} ${text}`)
  }
  return (await response.json()) as HubI18nExportV1
}

/**
 * Bulk freshness check: send up to 100 ids, get back `{ id, updated_at }`
 * pairs in input order with deleted/missing ids dropped. Anonymous
 * endpoint, no JWT. Mirrors `fetchKeyLabelTimestamps` in `hub-key-labels.ts`.
 * Caller is responsible for splitting larger arrays (the server enforces
 * the 100 cap with a 400).
 */
export async function fetchI18nPackTimestamps(
  ids: string[],
): Promise<HubI18nPackTimestampsResponse> {
  return hubFetchJson<HubI18nPackTimestampsResponse>(
    `${HUB_API_BASE}${I18N_PACKS_ROUTE}/timestamps`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    },
    'Hub i18n timestamps fetch failed',
  )
}

// --- Upload / Update / Delete (auth required) -------------------------------

/** Bytes that the Hub-side multipart accepts for the `json` part.
 * Mirrors `I18N_MAX_BYTES` in pipette-hub. The Desktop validator catches
 * over-budget packs early so we don't burn an HTTP round trip just to
 * learn the size cap. */
export const MAX_HUB_I18N_JSON_BYTES = 256 * 1024

interface HubI18nUploadFile {
  name: string
  data: Buffer
}

function buildI18nJsonFile(pack: HubI18nPackBody): HubI18nUploadFile {
  const exportPayload = buildI18nExport(pack)
  return { name: 'i18n-export-v1.json', data: Buffer.from(JSON.stringify(exportPayload), 'utf-8') }
}

// Single-file multipart with only a `json` part. Inlined rather than reusing
// hub-client's MultipartBuilder so this module stays self-contained — the
// Hub-side endpoint (`/api/i18n-packs`) accepts no other fields, so there is
// nothing to share with the post upload paths.
function buildI18nMultipartBody(jsonFile: HubI18nUploadFile): { body: Buffer; boundary: string } {
  const boundary = `----PipetteI18nBoundary${String(Date.now())}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="json"; filename="${jsonFile.name}"\r\nContent-Type: application/json\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, jsonFile.data, tail]), boundary }
}

async function submitI18nPack(
  jwt: string,
  method: 'POST' | 'PUT',
  path: string,
  pack: HubI18nPackBody,
  label: string,
): Promise<HubPostResponse> {
  const { body, boundary } = buildI18nMultipartBody(buildI18nJsonFile(pack))
  return hubFetchJson<HubPostResponse>(
    `${HUB_API_BASE}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    },
    label,
  )
}

export function uploadI18nPostToHub(jwt: string, pack: HubI18nPackBody): Promise<HubPostResponse> {
  return submitI18nPack(jwt, 'POST', I18N_PACKS_ROUTE, pack, 'Hub i18n upload failed')
}

export function updateI18nPostOnHub(
  jwt: string,
  postId: string,
  pack: HubI18nPackBody,
): Promise<HubPostResponse> {
  return submitI18nPack(jwt, 'PUT', i18nPackRoute(postId), pack, 'Hub i18n update failed')
}

export async function deleteI18nPostFromHub(jwt: string, postId: string): Promise<void> {
  await hubFetchJson<unknown>(
    `${HUB_API_BASE}${i18nPackRoute(postId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    },
    'Hub i18n delete failed',
  )
}
