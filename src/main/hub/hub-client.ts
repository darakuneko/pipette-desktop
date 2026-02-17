// SPDX-License-Identifier: GPL-2.0-or-later
// Hub API client — auth token exchange + multipart post upload

import type { HubMyPost, HubUser, HubFetchMyPostsParams } from '../../shared/types/hub'

const HUB_API_DEFAULT = 'https://pipette-hub-worker.keymaps.workers.dev'
const isDev = !!process.env.ELECTRON_RENDERER_URL
const HUB_API_BASE = (isDev && process.env.PIPETTE_HUB_URL) || HUB_API_DEFAULT

interface HubAuthResult {
  token: string
  user: HubUser
}

export interface HubPostResponse {
  id: string
  title: string
}

export interface HubUploadFiles {
  vil: { name: string; data: Buffer }
  pippette: { name: string; data: Buffer }
  c: { name: string; data: Buffer }
  pdf: { name: string; data: Buffer }
  thumbnail: { name: string; data: Buffer }
}

export class Hub401Error extends Error {
  constructor(label: string, body: string) {
    super(`${label}: 401 ${body}`)
    this.name = 'Hub401Error'
  }
}

interface HubApiResponse<T> {
  ok: boolean
  data: T
  error?: string
}

async function hubFetch<T>(url: string, init: RequestInit, label: string): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text()
    if (response.status === 401) throw new Hub401Error(label, text)
    throw new Error(`${label}: ${response.status} ${text}`)
  }
  const json = (await response.json()) as HubApiResponse<T>
  if (!json.ok) {
    throw new Error(`${label}: ${json.error ?? 'unknown error'}`)
  }
  return json.data
}

export async function authenticateWithHub(idToken: string): Promise<HubAuthResult> {
  return hubFetch<HubAuthResult>(`${HUB_API_BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_token: idToken }),
  }, 'Hub auth failed')
}

function sanitizeFieldValue(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ')
}

function buildMultipartBody(
  title: string,
  keyboardName: string,
  files: HubUploadFiles,
): { body: Buffer; boundary: string } {
  const boundary = `----PipetteBoundary${Date.now()}`
  const parts: Buffer[] = []

  function appendField(name: string, value: string): void {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${sanitizeFieldValue(value)}\r\n`,
    ))
  }

  function appendFile(fieldName: string, filename: string, data: Buffer, contentType: string): void {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ))
    parts.push(data)
    parts.push(Buffer.from('\r\n'))
  }

  appendField('title', title)
  appendField('keyboard_name', keyboardName)
  appendFile('vil', files.vil.name, files.vil.data, 'application/json')
  appendFile('pippette', files.pippette.name, files.pippette.data, 'application/json')
  appendFile('c', files.c.name, files.c.data, 'text/plain')
  appendFile('pdf', files.pdf.name, files.pdf.data, 'application/pdf')
  appendFile('thumbnail', files.thumbnail.name, files.thumbnail.data, 'image/jpeg')

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  return { body: Buffer.concat(parts), boundary }
}

export async function fetchAuthMe(jwt: string): Promise<HubUser> {
  return hubFetch<HubUser>(`${HUB_API_BASE}/api/auth/me`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  }, 'Hub fetch auth me failed')
}

export async function patchAuthMe(jwt: string, displayName: string): Promise<HubUser> {
  return hubFetch<HubUser>(`${HUB_API_BASE}/api/auth/me`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ display_name: displayName }),
  }, 'Hub patch auth me failed')
}

export interface HubMyPostsPage {
  items: HubMyPost[]
  total: number
  page: number
  per_page: number
}

export async function fetchMyPosts(
  jwt: string,
  params?: HubFetchMyPostsParams,
): Promise<HubMyPostsPage> {
  const qs = new URLSearchParams()
  if (params?.page != null) qs.set('page', String(params.page))
  if (params?.per_page != null) qs.set('per_page', String(params.per_page))
  const query = qs.toString()
  const url = `${HUB_API_BASE}/api/files/me${query ? `?${query}` : ''}`
  return hubFetch<HubMyPostsPage>(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  }, 'Hub fetch my posts failed')
}

export async function fetchMyPostsByKeyboard(jwt: string, keyboardName: string): Promise<HubMyPost[]> {
  return hubFetch<HubMyPost[]>(
    `${HUB_API_BASE}/api/files/me/keyboard?name=${encodeURIComponent(keyboardName)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${jwt}` },
    },
    'Hub fetch keyboard posts failed',
  )
}

export async function patchPostOnHub(jwt: string, postId: string, fields: { title?: string }): Promise<void> {
  await hubFetch<unknown>(`${HUB_API_BASE}/api/files/${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields),
  }, 'Hub patch failed')
}

export async function deletePostFromHub(jwt: string, postId: string): Promise<void> {
  await hubFetch<unknown>(`${HUB_API_BASE}/api/files/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  }, 'Hub delete failed')
}

async function submitPost(
  jwt: string,
  method: 'POST' | 'PUT',
  path: string,
  title: string,
  keyboardName: string,
  files: HubUploadFiles,
  label: string,
): Promise<HubPostResponse> {
  const { body, boundary } = buildMultipartBody(title, keyboardName, files)
  return hubFetch<HubPostResponse>(`${HUB_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  }, label)
}

export function uploadPostToHub(
  jwt: string,
  title: string,
  keyboardName: string,
  files: HubUploadFiles,
): Promise<HubPostResponse> {
  return submitPost(jwt, 'POST', '/api/files', title, keyboardName, files, 'Hub upload failed')
}

export function updatePostOnHub(
  jwt: string,
  postId: string,
  title: string,
  keyboardName: string,
  files: HubUploadFiles,
): Promise<HubPostResponse> {
  return submitPost(jwt, 'PUT', `/api/files/${encodeURIComponent(postId)}`, title, keyboardName, files, 'Hub update failed')
}

export function getHubOrigin(): string {
  return HUB_API_BASE
}
