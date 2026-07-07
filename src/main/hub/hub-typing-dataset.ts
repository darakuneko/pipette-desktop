// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hub client for `/api/typing-test/datasets` — the version-distribution
// API for typing-test word datasets. Lets the desktop follow upstream
// (monkeytype etc.) word-list updates without an app re-release: compare
// the locally pinned version against the Hub's and, on a mismatch, pull
// the fresh manifest + download URL base.
//
// All endpoints are anonymous, read-only and server-cached. Both fetchers
// resolve to `null` on any network / shape error so callers can silently
// fall back to the bundled defaults.

import { net } from 'electron'
import type { LanguageManifestEntry, TypingTestDataset } from '../../shared/types/language-store'
import { getHubApiBase } from './hub-base'

interface HubApiResponse<T> {
  ok: boolean
  data: T
  error?: string
}

function datasetRoute(provider: string): string {
  return `${getHubApiBase()}/api/typing-test/datasets/${encodeURIComponent(provider)}`
}

export function isManifestEntry(v: unknown): v is LanguageManifestEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.name === 'string' &&
    typeof e.wordCount === 'number' &&
    typeof e.rightToLeft === 'boolean' &&
    typeof e.fileSize === 'number' &&
    // Catalog providers (aozora) carry title/author/authorKana; pack
    // providers omit them. All three are optional, but when present must
    // be strings.
    (e.title === undefined || typeof e.title === 'string') &&
    (e.author === undefined || typeof e.author === 'string') &&
    (e.authorKana === undefined || typeof e.authorKana === 'string')
  )
}

export function isValidModel(v: unknown): v is 'pack' | 'catalog' | undefined {
  return v === undefined || v === 'pack' || v === 'catalog'
}

/** Lightweight version probe. Returns the Hub's current `version` for the
 *  provider, or `null` if unreachable / unknown provider / bad shape. */
export async function fetchTypingDatasetVersion(provider: string): Promise<string | null> {
  try {
    const res = await net.fetch(`${datasetRoute(provider)}/version`)
    if (!res.ok) return null
    const body = (await res.json()) as HubApiResponse<{ provider: string; version: string }>
    if (!body.ok || typeof body.data?.version !== 'string') return null
    return body.data.version
  } catch {
    return null
  }
}

/** Full dataset (version + downloadUrlBase + language manifest). Returns
 *  `null` on any error or if the payload fails validation. */
export async function fetchTypingDataset(provider: string): Promise<TypingTestDataset | null> {
  try {
    const res = await net.fetch(datasetRoute(provider))
    if (!res.ok) return null
    const body = (await res.json()) as HubApiResponse<TypingTestDataset>
    const d = body.data
    if (
      !body.ok ||
      !d ||
      typeof d.provider !== 'string' ||
      d.provider !== provider ||
      typeof d.version !== 'string' ||
      typeof d.downloadUrlBase !== 'string' ||
      // The base URL is fetched from the main process, so reject anything
      // that isn't plain HTTPS to avoid an SSRF vector via a bad Hub payload.
      !/^https:\/\//.test(d.downloadUrlBase) ||
      !isValidModel(d.model) ||
      !Array.isArray(d.languages) ||
      !d.languages.every(isManifestEntry)
    ) {
      return null
    }
    return {
      provider: d.provider,
      version: d.version,
      downloadUrlBase: d.downloadUrlBase,
      model: d.model,
      languages: d.languages,
    }
  } catch {
    return null
  }
}
