// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hub client surface for `/api/theme-packs`. Mirrors hub-i18n.ts but
// without an envelope layer — ThemePackEntryFile is the top-level JSON.

import {
  Hub401Error,
  Hub403Error,
  Hub409Error,
  Hub429Error,
  type HubPostResponse,
} from './hub-client'
import type {
  HubThemePackBody,
  HubThemePackTimestampsResponse,
  HubThemeListParams,
  HubThemeListResponse,
} from '../../shared/types/hub'

const HUB_API_DEFAULT = 'https://pipette-hub-worker.keymaps.workers.dev'
const isDev = !!process.env.ELECTRON_RENDERER_URL
const HUB_API_BASE = (isDev && process.env.PIPETTE_HUB_URL) || HUB_API_DEFAULT
const MAX_RETRY_AFTER_S = 60

const THEME_PACKS_ROUTE = '/api/theme-packs'
const themePackRoute = (postId: string): string =>
  `${THEME_PACKS_ROUTE}/${encodeURIComponent(postId)}`
const themePackDownloadRoute = (postId: string): string => `${themePackRoute(postId)}/download`

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

// --- List / Detail / Download (anonymous) ------------------------------------

interface HubThemePackSummaryRaw {
  id: string
  name: string
  version: string
  uploaded_by?: string | null
  uploader_name?: string | null
  created_at: string
  updated_at?: string
}

interface HubThemePackPaginatedRaw {
  items: HubThemePackSummaryRaw[]
  total: number
  page: number
  per_page: number
}

export async function fetchThemePostList(query: HubThemeListParams): Promise<HubThemeListResponse> {
  const qs = new URLSearchParams()
  if (query.q && query.q.trim()) qs.set('q', query.q.trim())
  if (query.name && query.name.trim()) qs.set('name', query.name.trim())
  if (query.page != null) qs.set('page', String(query.page))
  if (query.perPage != null) qs.set('per_page', String(query.perPage))
  const search = qs.toString()
  const url = `${HUB_API_BASE}${THEME_PACKS_ROUTE}${search ? `?${search}` : ''}`
  const raw = await hubFetchJson<HubThemePackPaginatedRaw>(url, { method: 'GET' }, 'Hub theme list failed')
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

export async function downloadThemePostBody(postId: string): Promise<HubThemePackBody> {
  return hubFetchJson<HubThemePackBody>(
    `${HUB_API_BASE}${themePackDownloadRoute(postId)}`,
    { method: 'GET' },
    'Hub theme download failed',
  )
}

export async function fetchThemePackTimestamps(
  ids: string[],
): Promise<HubThemePackTimestampsResponse> {
  return hubFetchJson<HubThemePackTimestampsResponse>(
    `${HUB_API_BASE}${THEME_PACKS_ROUTE}/timestamps`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    },
    'Hub theme timestamps fetch failed',
  )
}

// --- Upload / Update / Delete (auth required) --------------------------------

export const MAX_HUB_THEME_JSON_BYTES = 64 * 1024

interface HubThemeUploadFile {
  name: string
  data: Buffer
}

function buildThemeJsonFile(pack: HubThemePackBody): HubThemeUploadFile {
  return { name: 'theme-pack.json', data: Buffer.from(JSON.stringify(pack), 'utf-8') }
}

function buildThemeMultipartBody(jsonFile: HubThemeUploadFile): { body: Buffer; boundary: string } {
  const boundary = `----PipetteThemeBoundary${String(Date.now())}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="json"; filename="${jsonFile.name}"\r\nContent-Type: application/json\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, jsonFile.data, tail]), boundary }
}

async function submitThemePack(
  jwt: string,
  method: 'POST' | 'PUT',
  path: string,
  pack: HubThemePackBody,
  label: string,
): Promise<HubPostResponse> {
  const { body, boundary } = buildThemeMultipartBody(buildThemeJsonFile(pack))
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

export function uploadThemePostToHub(jwt: string, pack: HubThemePackBody): Promise<HubPostResponse> {
  return submitThemePack(jwt, 'POST', THEME_PACKS_ROUTE, pack, 'Hub theme upload failed')
}

export function updateThemePostOnHub(
  jwt: string,
  postId: string,
  pack: HubThemePackBody,
): Promise<HubPostResponse> {
  return submitThemePack(jwt, 'PUT', themePackRoute(postId), pack, 'Hub theme update failed')
}

export async function deleteThemePostFromHub(jwt: string, postId: string): Promise<void> {
  await hubFetchJson<unknown>(
    `${HUB_API_BASE}${themePackRoute(postId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    },
    'Hub theme delete failed',
  )
}
