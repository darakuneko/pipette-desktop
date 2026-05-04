// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler for Hub upload operations

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'
import type {
  HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult,
  HubFetchMyPostsResult, HubFetchMyKeyboardPostsResult, HubUserResult, HubFetchMyPostsParams,
  HubUploadFavoritePostParams, HubUpdateFavoritePostParams,
  HubUploadAnalyticsPostParams, HubUpdateAnalyticsPostParams, HubPreviewAnalyticsPostParams,
  HubAnalyticsPreview, HubAnalyticsFilters, HubAnalyticsCategoryId,
} from '../../shared/types/hub'
import { getIdToken } from '../sync/google-auth'
import { Hub401Error, Hub403Error, Hub409Error, Hub429Error, authenticateWithHub, uploadPostToHub, updatePostOnHub, patchPostOnHub, deletePostFromHub, fetchMyPosts, fetchMyPostsByKeyboard, fetchAuthMe, patchAuthMe, getHubOrigin, uploadFeaturePostToHub, updateFeaturePostOnHub, uploadAnalyticsPostToHub, updateAnalyticsPostOnHub } from './hub-client'
import {
  buildAnalyticsExport,
  estimateAnalyticsExportSizeBytes,
  validateAnalyticsExport,
  type BuildAnalyticsExportInput,
  type DeviceScope,
} from './hub-analytics'
import { readAnalyzeFilterEntry, setAnalyzeFilterHubPostId } from '../analyze-filter-store'
import { getKeymapSnapshotForRange } from '../typing-analytics/keymap-snapshots'
import { getMachineHash } from '../typing-analytics/machine-hash'
import type { TypingKeymapSnapshot } from '../../shared/types/typing-analytics'
import type { LayoutComparisonMetric } from '../../shared/types/typing-analytics'
import type { KleKey } from '../../shared/kle/types'
import type { HubAuthResult, HubUploadFiles } from './hub-client'
import { fetchKeyLabelList, fetchKeyLabelDetail, fetchKeyLabelTimestamps, downloadKeyLabel, uploadKeyLabel, updateKeyLabel, deleteKeyLabel } from './hub-key-labels'
import type { HubKeyLabelInput } from './hub-key-labels'
import type { HubKeyLabelItem, HubKeyLabelListResponse, HubKeyLabelListParams, HubKeyLabelTimestamp, HubKeyLabelTimestampsResponse } from '../../shared/types/hub-key-label'
import { HUB_ERROR_KEY_LABEL_DUPLICATE, HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT } from '../../shared/types/hub-key-label'
import { getRecord, saveRecord, setHubPostId } from '../key-label-store'
import type { KeyLabelMeta, KeyLabelStoreResult } from '../../shared/types/key-label-store'
import { isValidFavoriteType, isValidVialProtocol, FAV_TYPE_TO_EXPORT_KEY, serializeFavData, buildFavExportFile } from '../../shared/favorite-data'
import { serialize as serializeKeycode } from '../../shared/keycodes/keycodes'
import type { FavoriteType, FavoriteIndex } from '../../shared/types/favorite-store'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

const AUTH_ERROR = 'Not authenticated with Google. Please sign in again.'
const POST_ID_RE = /^[a-zA-Z0-9_-]+$/
const DISPLAY_NAME_MAX_LENGTH = 50

function validatePostId(postId: string): void {
  if (!postId || !POST_ID_RE.test(postId)) {
    throw new Error('Invalid post ID')
  }
}

function validateDisplayName(displayName: unknown): string {
  if (displayName == null || typeof displayName !== 'string') throw new Error('Display name must not be empty')
  const trimmed = displayName.trim()
  if (trimmed.length === 0) throw new Error('Display name must not be empty')
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) throw new Error('Display name too long')
  return trimmed
}

const KEYBOARD_NAME_MAX_LENGTH = 100

function validateKeyboardName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('Missing keyboard name')
  const trimmed = name.trim()
  if (trimmed.length > KEYBOARD_NAME_MAX_LENGTH) throw new Error('Keyboard name too long')
  return trimmed
}

const TITLE_MAX_LENGTH = 200

function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('Title must not be empty')
  const trimmed = title.trim()
  if (trimmed.length > TITLE_MAX_LENGTH) throw new Error('Title too long')
  return trimmed
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null) return undefined
  const floored = Math.floor(value)
  if (!Number.isFinite(floored)) return undefined
  return Math.max(min, Math.min(max, floored))
}

function sanitizeFilenameBase(productName: string, fallback: string): string {
  const source = (productName || fallback || 'analytics').replace(/[^a-zA-Z0-9_-]/g, '_')
  return source.length > 0 ? source : 'analytics'
}

interface AnalyticsExportPreparation {
  ok: true
  exportData: Awaited<ReturnType<typeof buildAnalyticsExport>>
}
interface AnalyticsExportPreparationFail {
  ok: false
  error: string
  /** When the failure happens before the export can be assembled
   * (e.g. snapshot missing) we still surface the bits the dialog
   * needs to render the validation card. Default 0 / 0 keeps the
   * card showing red without blowing up. */
  totalKeystrokes: number
  rangeMs: number
}

/** Shared assembly path for both upload and preview. Reads the saved
 * filter snapshot, resolves the keymap snapshot main-side (snapshots
 * are local-only), folds the user's filter shape into the Hub's
 * `HubAnalyticsFilters` shape, and runs the builder. */
async function prepareAnalyticsExport(
  params: HubUploadAnalyticsPostParams | (HubPreviewAnalyticsPostParams & { title: string; thumbnailBase64: string }),
): Promise<AnalyticsExportPreparation | AnalyticsExportPreparationFail> {
  if (!params.uid || typeof params.uid !== 'string') {
    return { ok: false, error: 'Invalid uid', totalKeystrokes: 0, rangeMs: 0 }
  }
  if (!params.entryId || typeof params.entryId !== 'string') {
    return { ok: false, error: 'Invalid entryId', totalKeystrokes: 0, rangeMs: 0 }
  }
  const found = await readAnalyzeFilterEntry(params.uid, params.entryId)
  if (!found) {
    return { ok: false, error: 'Saved filter entry not found', totalKeystrokes: 0, rangeMs: 0 }
  }

  let payload: AnalyzeFilterSnapshotPayloadShape
  try {
    payload = JSON.parse(found.data) as AnalyzeFilterSnapshotPayloadShape
  } catch {
    return { ok: false, error: 'Saved filter payload is not valid JSON', totalKeystrokes: 0, rangeMs: 0 }
  }
  if (!payload || typeof payload !== 'object' || payload.version !== 1) {
    return { ok: false, error: 'Unsupported saved filter version', totalKeystrokes: 0, rangeMs: 0 }
  }
  const range = payload.range
  if (!range || typeof range.fromMs !== 'number' || typeof range.toMs !== 'number') {
    return { ok: false, error: 'Saved filter has no range', totalKeystrokes: 0, rangeMs: 0 }
  }
  const rangeMs = Math.max(0, range.toMs - range.fromMs)

  const deviceScope = resolveDeviceScopeFromPayload(payload.filters?.deviceScopes)
  const appScopes = Array.isArray(payload.filters?.appScopes)
    ? payload.filters.appScopes.filter((v): v is string => typeof v === 'string')
    : []

  // Snapshots are own-only — the typing-analytics service writes them
  // against the local machine hash. The Analyze view itself reads the
  // snapshot via `typingAnalyticsGetKeymapSnapshotForRange` which
  // resolves the same hash internally.
  const ownHash = await getMachineHash()
  const snapshot = await getKeymapSnapshotForRange(
    app.getPath('userData'), params.uid, ownHash, range.fromMs, range.toMs,
  )
  if (!snapshot) {
    return { ok: false, error: 'No keymap snapshot recorded for this range', totalKeystrokes: 0, rangeMs }
  }

  const filters = projectFiltersForHub(payload, params.fingerOverrides)

  const layoutInputs = params.layoutComparisonInputs
  const layoutComparisonInputs: BuildAnalyticsExportInput['layoutComparisonInputs'] = layoutInputs
    ? {
        source: layoutInputs.source,
        target: layoutInputs.target,
        metrics: filterValidLayoutMetrics(layoutInputs.metrics),
        kleKeys: layoutInputs.kleKeys as KleKey[],
        layer: layoutInputs.layer,
      }
    : null

  // Renderer-side category picker — only the listed sections get
  // fetched. Unset / empty array ships everything (back-compat with
  // the early build that did not surface the picker).
  const categories = Array.isArray(params.categories) && params.categories.length > 0
    ? new Set(params.categories.filter((c): c is HubAnalyticsCategoryId => typeof c === 'string'))
    : undefined

  const exportData = await buildAnalyticsExport({
    uid: params.uid,
    productName: params.keyboard.productName,
    vendorId: params.keyboard.vendorId,
    productId: params.keyboard.productId,
    snapshot: snapshot as TypingKeymapSnapshot,
    range: { fromMs: range.fromMs, toMs: range.toMs },
    deviceScope,
    appScopes,
    filters,
    layoutComparisonInputs,
    categories,
  })

  return { ok: true, exportData }
}

/** Subset of the renderer-side AnalyzeFilterSnapshotPayload that the
 * main-side preparer needs to read. Re-stating the shape here keeps
 * the main module independent of the renderer-only hook file. */
interface AnalyzeFilterSnapshotPayloadShape {
  version: number
  analysisTab?: string
  range?: { fromMs?: number; toMs?: number }
  filters?: {
    deviceScopes?: unknown[]
    appScopes?: unknown[]
    heatmap?: Record<string, unknown>
    wpm?: Record<string, unknown>
    interval?: Record<string, unknown>
    activity?: Record<string, unknown>
    layer?: Record<string, unknown>
    ergonomics?: Record<string, unknown>
    bigrams?: Record<string, unknown>
    layoutComparison?: Record<string, unknown>
  }
}

function resolveDeviceScopeFromPayload(scopes: unknown): DeviceScope {
  if (!Array.isArray(scopes) || scopes.length === 0) return 'own'
  const first = scopes[0]
  if (first === 'all' || first === 'own') return first
  if (typeof first === 'object' && first !== null) {
    const o = first as Record<string, unknown>
    if (o.kind === 'hash' && typeof o.machineHash === 'string' && o.machineHash.length > 0) {
      return { kind: 'hash', machineHash: o.machineHash }
    }
  }
  return 'own'
}

const VALID_LAYOUT_METRICS: ReadonlySet<LayoutComparisonMetric> = new Set([
  'fingerLoad', 'handBalance', 'rowDist', 'homeRow',
])

function filterValidLayoutMetrics(metrics: readonly string[] | undefined): LayoutComparisonMetric[] {
  if (!Array.isArray(metrics)) return []
  return metrics.filter((m): m is LayoutComparisonMetric => VALID_LAYOUT_METRICS.has(m as LayoutComparisonMetric))
}

function projectFiltersForHub(
  payload: AnalyzeFilterSnapshotPayloadShape,
  fingerOverrides: Record<string, string> | undefined,
): HubAnalyticsFilters {
  const f = payload.filters ?? {}
  // Bigrams limits are fixed (10/10/20) per HUB-ANALYTICS-API.md §4.3
  // — the desktop never sends user-tweaked counts so the Hub size /
  // privacy surface stays predictable.
  const pairThreshold = typeof f.bigrams?.pairIntervalThresholdMs === 'number'
    ? f.bigrams.pairIntervalThresholdMs
    : undefined
  return {
    // Always pin the Hub initial-tab hint to Summary so the post
    // detail page lands on the at-a-glance view regardless of which
    // tab was open when the saved condition was uploaded. Mirrors the
    // local Load behaviour (handleLoadFilterSnapshot) which also
    // forces Summary.
    analysisTab: 'summary',
    heatmap: f.heatmap,
    wpm: f.wpm,
    interval: f.interval,
    activity: f.activity,
    layer: f.layer,
    ergonomics: f.ergonomics,
    bigrams: { topLimit: 10, slowLimit: 10, fingerLimit: 20, pairIntervalThresholdMs: pairThreshold },
    layoutComparison: f.layoutComparison,
    fingerOverrides: fingerOverrides && Object.keys(fingerOverrides).length > 0 ? fingerOverrides : undefined,
  }
}

function computeTotalPages(total: number, perPage: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0
  const safePerPage = Number.isFinite(perPage) && perPage > 0 ? perPage : 1
  return Math.max(1, Math.ceil(safeTotal / safePerPage))
}

// Cache Hub JWT to avoid redundant /api/auth/token round-trips.
// Hub JWT is valid for 7 days; we cache for 24 hours.
// withTokenRetry() handles mid-cache expiry via automatic 401 retry.
// The /api/auth/token endpoint has a 10 req/min rate limit.
const HUB_JWT_TTL_MS = 24 * 60 * 60 * 1000
let cachedHubJwt: { token: string; expiresAt: number } | null = null
let inflightHubAuth: Promise<string> | null = null
let cacheGeneration = 0
let pendingAuthDisplayName: string | null = null

async function getHubToken(): Promise<string> {
  if (cachedHubJwt && Date.now() < cachedHubJwt.expiresAt) {
    return cachedHubJwt.token
  }
  // Deduplicate concurrent requests
  if (inflightHubAuth) return inflightHubAuth
  const gen = cacheGeneration
  inflightHubAuth = (async () => {
    try {
      const idToken = await getIdToken()
      if (!idToken) throw new Error(AUTH_ERROR)
      let auth: HubAuthResult
      try {
        auth = await authenticateWithHub(idToken, pendingAuthDisplayName ?? undefined)
      } catch (err) {
        if (err instanceof Hub409Error) throw new Error(HUB_ERROR_DISPLAY_NAME_CONFLICT)
        rethrowAsHubSentinel(err)
        throw err
      }
      // Only cache if not invalidated (e.g. by sign-out) during the request
      if (gen === cacheGeneration) {
        cachedHubJwt = { token: auth.token, expiresAt: Date.now() + HUB_JWT_TTL_MS }
      }
      return auth.token
    } finally {
      inflightHubAuth = null
    }
  })()
  return inflightHubAuth
}

export function clearHubTokenCache(): void {
  cachedHubJwt = null
  inflightHubAuth = null
  cacheGeneration++
  pendingAuthDisplayName = null
}

function invalidateCachedHubJwt(): void {
  cachedHubJwt = null
}

function extractError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function rethrowAsHubSentinel(err: unknown): void {
  if (err instanceof Hub403Error) throw new Error(HUB_ERROR_ACCOUNT_DEACTIVATED)
  if (err instanceof Hub429Error) throw new Error(HUB_ERROR_RATE_LIMITED)
}

async function withTokenRetry<T>(operation: (jwt: string) => Promise<T>): Promise<T> {
  const jwt = await getHubToken()
  try {
    return await operation(jwt)
  } catch (err) {
    if (err instanceof Hub401Error) {
      invalidateCachedHubJwt()
      const freshJwt = await getHubToken()
      try {
        return await operation(freshJwt)
      } catch (retryErr) {
        rethrowAsHubSentinel(retryErr)
        throw retryErr
      }
    }
    rethrowAsHubSentinel(err)
    throw err
  }
}

const MB = 1024 * 1024
const FILE_SIZE_LIMITS: Record<string, { max: number; label: string }> = {
  thumbnail: { max: 2 * MB, label: 'thumbnail' },
  vil: { max: 10 * MB, label: 'vil' },
  pipette: { max: 10 * MB, label: 'pipette' },
  c: { max: 10 * MB, label: 'keymap C' },
  pdf: { max: 10 * MB, label: 'PDF' },
}

function validateFileSize(files: HubUploadFiles): void {
  for (const [key, limit] of Object.entries(FILE_SIZE_LIMITS)) {
    const file = files[key as keyof HubUploadFiles]
    if (file.data.byteLength > limit.max) {
      throw new Error(`File too large: ${limit.label} exceeds ${limit.max / MB} MB limit`)
    }
  }
}

function buildFiles(params: HubUploadPostParams): HubUploadFiles {
  const baseName = params.keyboardName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const files: HubUploadFiles = {
    vil: { name: `${baseName}.vil`, data: Buffer.from(params.vilJson, 'utf-8') },
    pipette: { name: `${baseName}.pipette`, data: Buffer.from(params.pipetteJson, 'utf-8') },
    c: { name: `${baseName}.c`, data: Buffer.from(params.keymapC, 'utf-8') },
    pdf: { name: `${baseName}.pdf`, data: Buffer.from(params.pdfBase64, 'base64') },
    thumbnail: { name: `${baseName}.jpg`, data: Buffer.from(params.thumbnailBase64, 'base64') },
  }
  validateFileSize(files)
  return files
}

function isSafePathSegment(segment: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..'
}

async function buildFavoriteExportJson(
  type: FavoriteType,
  entryId: string,
  vialProtocol: number,
): Promise<string> {
  const favDir = join(app.getPath('userData'), 'sync', 'favorites', type)
  const indexPath = join(favDir, 'index.json')
  const indexRaw = await readFile(indexPath, 'utf-8')
  const index = JSON.parse(indexRaw) as FavoriteIndex
  const entry = index.entries.find((e) => e.id === entryId && !e.deletedAt)
  if (!entry) throw new Error('Entry not found')

  if (!isSafePathSegment(entry.filename)) throw new Error('Invalid filename')
  const filePath = join(favDir, entry.filename)
  const fileRaw = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(fileRaw) as { type: string; data: unknown }
  if (parsed.data == null) throw new Error('Entry data is empty')
  if (parsed.type !== type) throw new Error('Entry type mismatch')

  const exportKey = FAV_TYPE_TO_EXPORT_KEY[type]
  const serializedData = serializeFavData(type, parsed.data, serializeKeycode)

  const exportFile = buildFavExportFile(vialProtocol, {
    [exportKey]: [{
      label: entry.label,
      savedAt: entry.savedAt,
      data: serializedData,
    }],
  })

  return JSON.stringify(exportFile)
}

/**
 * Fetch a key-label download body together with the uploader name and
 * Hub-side `updated_at` from the detail endpoint. The detail call is
 * best-effort: if it fails (network blip, 404 on a deleted post, etc.)
 * we keep the caller-supplied uploader fallback so the Author column
 * does not lose its cached value, and `hubUpdatedAt` simply stays
 * undefined for that round.
 */
async function fetchHubKeyLabelPayload(
  hubPostId: string,
  fallbackUploader?: string,
  fallbackHubUpdatedAt?: string,
): Promise<{
  body: { name: string; map: Record<string, string>; composite_labels: Record<string, string> | null }
  uploaderName: string | undefined
  hubUpdatedAt: string | undefined
}> {
  const body = await downloadKeyLabel(hubPostId)
  let uploaderName: string | undefined = fallbackUploader
  let hubUpdatedAt: string | undefined = fallbackHubUpdatedAt
  try {
    const detail = await fetchKeyLabelDetail(hubPostId)
    uploaderName = detail.uploader_name ?? fallbackUploader
    hubUpdatedAt = detail.updated_at ?? fallbackHubUpdatedAt
  } catch {
    // best-effort; keep the fallback values
  }
  return { body, uploaderName, hubUpdatedAt }
}

export function setupHubIpc(): void {
  secureHandle(
    IpcChannels.HUB_UPLOAD_POST,
    async (_event, params: HubUploadPostParams): Promise<HubUploadResult> => {
      try {
        const title = validateTitle(params.title)
        const files = buildFiles(params)
        const result = await withTokenRetry((jwt) =>
          uploadPostToHub(jwt, title, params.keyboardName, files),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_POST,
    async (_event, params: HubUpdatePostParams): Promise<HubUploadResult> => {
      try {
        validatePostId(params.postId)
        const title = validateTitle(params.title)
        const files = buildFiles(params)
        const result = await withTokenRetry((jwt) =>
          updatePostOnHub(jwt, params.postId, title, params.keyboardName, files),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Update failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_PATCH_POST,
    async (_event, params: HubPatchPostParams): Promise<HubDeleteResult> => {
      try {
        validatePostId(params.postId)
        const title = validateTitle(params.title)
        await withTokenRetry((jwt) =>
          patchPostOnHub(jwt, params.postId, { title }),
        )
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'Patch failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_DELETE_POST,
    async (_event, postId: string): Promise<HubDeleteResult> => {
      try {
        validatePostId(postId)
        await withTokenRetry((jwt) => deletePostFromHub(jwt, postId))
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'Delete failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_FETCH_MY_POSTS,
    async (_event, params?: HubFetchMyPostsParams): Promise<HubFetchMyPostsResult> => {
      try {
        const page = clampInt(params?.page, 1, Number.MAX_SAFE_INTEGER)
        const perPage = clampInt(params?.per_page, 1, 100)
        const result = await withTokenRetry((jwt) =>
          fetchMyPosts(jwt, { page, per_page: perPage }),
        )
        const totalPages = computeTotalPages(result.total, result.per_page)
        return {
          success: true,
          posts: result.items,
          pagination: {
            total: result.total,
            page: result.page,
            per_page: result.per_page,
            total_pages: totalPages,
          },
        }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch my posts failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_FETCH_AUTH_ME,
    async (): Promise<HubUserResult> => {
      try {
        const user = await withTokenRetry((jwt) => fetchAuthMe(jwt))
        return { success: true, user }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch auth failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_PATCH_AUTH_ME,
    async (_event, displayName: unknown): Promise<HubUserResult> => {
      try {
        const validated = validateDisplayName(displayName)
        const user = await withTokenRetry((jwt) => patchAuthMe(jwt, validated))
        return { success: true, user }
      } catch (err) {
        if (err instanceof Hub409Error) {
          return { success: false, error: HUB_ERROR_DISPLAY_NAME_CONFLICT }
        }
        return { success: false, error: extractError(err, 'Patch auth failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_FETCH_MY_KEYBOARD_POSTS,
    async (_event, keyboardName: unknown): Promise<HubFetchMyKeyboardPostsResult> => {
      try {
        const validated = validateKeyboardName(keyboardName)
        const posts = await withTokenRetry((jwt) =>
          fetchMyPostsByKeyboard(jwt, validated),
        )
        return { success: true, posts }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch keyboard posts failed') }
      }
    },
  )

  secureHandle(IpcChannels.HUB_GET_ORIGIN, (): string => getHubOrigin())

  secureHandle(
    IpcChannels.HUB_SET_AUTH_DISPLAY_NAME,
    (_event, displayName: string | null): void => {
      pendingAuthDisplayName = typeof displayName === 'string' ? displayName : null
      // Invalidate cached JWT so the next getHubToken() re-authenticates
      // with the new display name instead of returning a stale cached/inflight result.
      cachedHubJwt = null
      inflightHubAuth = null
    },
  )

  // --- Favorite (feature) post handlers ---

  async function prepareFavoritePost(
    params: HubUploadFavoritePostParams,
  ): Promise<{ title: string; postType: string; jsonFile: { name: string; data: Buffer } }> {
    if (!isValidFavoriteType(params.type)) throw new Error('Invalid favorite type')
    if (!isValidVialProtocol(params.vialProtocol)) throw new Error('Invalid vialProtocol')
    const title = validateTitle(params.title)
    const postType = FAV_TYPE_TO_EXPORT_KEY[params.type]
    const jsonStr = await buildFavoriteExportJson(params.type, params.entryId, params.vialProtocol)
    return { title, postType, jsonFile: { name: `${postType}.json`, data: Buffer.from(jsonStr, 'utf-8') } }
  }

  secureHandle(
    IpcChannels.HUB_UPLOAD_FAVORITE_POST,
    async (_event, params: HubUploadFavoritePostParams): Promise<HubUploadResult> => {
      try {
        const { title, postType, jsonFile } = await prepareFavoritePost(params)
        const result = await withTokenRetry((jwt) =>
          uploadFeaturePostToHub(jwt, title, postType, jsonFile),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_FAVORITE_POST,
    async (_event, params: HubUpdateFavoritePostParams): Promise<HubUploadResult> => {
      try {
        validatePostId(params.postId)
        const { title, postType, jsonFile } = await prepareFavoritePost(params)
        const result = await withTokenRetry((jwt) =>
          updateFeaturePostOnHub(jwt, params.postId, title, postType, jsonFile),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Update failed') }
      }
    },
  )

  // --- Analytics post handlers ---
  //
  // Pattern mirrors the favorite-post upload: validate inputs → assemble
  // payload → withTokenRetry → save the postId on success. Distinct
  // because the analytics build step is heavier (fetches across the
  // typing-analytics DB) and ships a thumbnail alongside the JSON.

  secureHandle(
    IpcChannels.HUB_UPLOAD_ANALYTICS_POST,
    async (_event, params: HubUploadAnalyticsPostParams): Promise<HubUploadResult> => {
      try {
        const built = await prepareAnalyticsExport(params)
        if (!built.ok) return { success: false, error: built.error }
        const title = validateTitle(params.title)
        const baseName = sanitizeFilenameBase(params.keyboard.productName, params.uid)
        const jsonBuffer = Buffer.from(JSON.stringify(built.exportData), 'utf-8')
        const thumbnailBuffer = Buffer.from(params.thumbnailBase64, 'base64')
        const result = await withTokenRetry((jwt) =>
          uploadAnalyticsPostToHub(
            jwt,
            title,
            { name: `${baseName}.json`, data: jsonBuffer },
            { name: `${baseName}.jpg`, data: thumbnailBuffer },
          ),
        )
        // Save the postId synchronously after upload so the panel can
        // immediately show the "↻ Hub" / 🔗 affordances without a
        // round-trip; failures here don't undo the upload (the entry
        // would just appear unsynced and the next click would attempt
        // a fresh upload).
        await setAnalyzeFilterHubPostId(params.uid, params.entryId, result.id)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Analytics upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_ANALYTICS_POST,
    async (_event, params: HubUpdateAnalyticsPostParams): Promise<HubUploadResult> => {
      try {
        validatePostId(params.postId)
        const built = await prepareAnalyticsExport(params)
        if (!built.ok) return { success: false, error: built.error }
        const title = validateTitle(params.title)
        const baseName = sanitizeFilenameBase(params.keyboard.productName, params.uid)
        const jsonBuffer = Buffer.from(JSON.stringify(built.exportData), 'utf-8')
        const thumbnailBuffer = Buffer.from(params.thumbnailBase64, 'base64')
        const result = await withTokenRetry((jwt) =>
          updateAnalyticsPostOnHub(
            jwt,
            params.postId,
            title,
            { name: `${baseName}.json`, data: jsonBuffer },
            { name: `${baseName}.jpg`, data: thumbnailBuffer },
          ),
        )
        // Re-stamp the postId in case the user manipulated the saved
        // entry's metadata in another window between preview and
        // upload — keeps the local index in sync with the Hub canon.
        await setAnalyzeFilterHubPostId(params.uid, params.entryId, result.id)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Analytics update failed') }
      }
    },
  )

  // Preview path used by the upload dialog. Builds the payload with
  // the same builder the upload uses but reports size + validation
  // without crossing the network. The thumbnail is captured later
  // (only when the user confirms), so it's intentionally absent from
  // the preview params.
  secureHandle(
    IpcChannels.HUB_PREVIEW_ANALYTICS_POST,
    async (_event, params: HubPreviewAnalyticsPostParams): Promise<{ success: boolean; preview?: HubAnalyticsPreview; error?: string }> => {
      try {
        const built = await prepareAnalyticsExport({
          ...params,
          // The preview path doesn't ship a thumbnail — pass empty
          // strings to satisfy the shared param shape without
          // triggering the buffer encode for nothing.
          title: 'preview',
          thumbnailBase64: '',
        })
        if (!built.ok) {
          return {
            success: true,
            preview: {
              totalKeystrokes: built.totalKeystrokes,
              rangeMs: built.rangeMs,
              estimatedBytes: 0,
              validation: { ok: false, reason: built.error },
            },
          }
        }
        const validation = validateAnalyticsExport(built.exportData)
        const estimatedBytes = estimateAnalyticsExportSizeBytes(built.exportData)
        return {
          success: true,
          preview: {
            totalKeystrokes: built.exportData.snapshot.totalKeystrokes,
            rangeMs: built.exportData.snapshot.range.toMs - built.exportData.snapshot.range.fromMs,
            estimatedBytes,
            validation,
          },
        }
      } catch (err) {
        return { success: false, error: extractError(err, 'Analytics preview failed') }
      }
    },
  )

  // --- Key Label Hub handlers ---

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_LIST,
    async (
      _event,
      params: HubKeyLabelListParams | undefined,
    ): Promise<KeyLabelStoreResult<HubKeyLabelListResponse>> => {
      try {
        const page = clampInt(params?.page, 1, Number.MAX_SAFE_INTEGER) ?? 1
        const perPage = clampInt(params?.perPage, 1, 100) ?? 20
        const data = await fetchKeyLabelList({ q: params?.q, page, perPage })
        return { success: true, data }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub list failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_DETAIL,
    async (_event, hubPostId: unknown): Promise<KeyLabelStoreResult<HubKeyLabelItem>> => {
      try {
        if (typeof hubPostId !== 'string' || !POST_ID_RE.test(hubPostId)) {
          return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid hub post id' }
        }
        const detail = await fetchKeyLabelDetail(hubPostId)
        return { success: true, data: detail }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub detail failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_TIMESTAMPS,
    async (_event, ids: unknown): Promise<KeyLabelStoreResult<HubKeyLabelTimestampsResponse>> => {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && POST_ID_RE.test(id))) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'ids must be an array of valid hub post ids' }
      }
      const unique = Array.from(new Set(ids as string[]))
      if (unique.length === 0) return { success: true, data: { items: [] } }
      try {
        // Server caps each request at 100 ids; split larger inputs and
        // run the chunks in parallel. Order is rebuilt from the input
        // array so callers see input-order semantics regardless of
        // chunking.
        const chunks: string[][] = []
        for (let i = 0; i < unique.length; i += HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT) {
          chunks.push(unique.slice(i, i + HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT))
        }
        const responses = await Promise.all(chunks.map((chunk) => fetchKeyLabelTimestamps(chunk)))
        const byId = new Map<string, HubKeyLabelTimestamp>()
        for (const r of responses) {
          for (const item of r.items) byId.set(item.id, item)
        }
        const items: HubKeyLabelTimestamp[] = []
        for (const id of unique) {
          const found = byId.get(id)
          if (found) items.push(found)
        }
        return { success: true, data: { items } }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub timestamps failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_DOWNLOAD,
    async (_event, hubPostId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      try {
        if (typeof hubPostId !== 'string' || !POST_ID_RE.test(hubPostId)) {
          return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid hub post id' }
        }
        const { body, uploaderName, hubUpdatedAt } = await fetchHubKeyLabelPayload(hubPostId)
        const composite = body.composite_labels ?? undefined
        // Use the Hub post id as the local id so the saved
        // `keyboardLayout` can be matched against Hub later (e.g. the
        // Missing Key Label dialog needs to look up the human name
        // after the entry has been removed locally).
        return await saveRecord({
          id: hubPostId,
          name: body.name,
          ...(uploaderName ? { uploaderName } : {}),
          map: body.map,
          ...(composite ? { compositeLabels: composite } : {}),
          hubPostId,
          ...(hubUpdatedAt ? { hubUpdatedAt } : {}),
        })
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub download failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_UPLOAD,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<KeyLabelMeta>
      const input: HubKeyLabelInput = {
        name: record.data.meta.name,
        map: record.data.data.map,
        ...(record.data.data.compositeLabels ? { compositeLabels: record.data.data.compositeLabels } : {}),
      }
      try {
        const result = await withTokenRetry((jwt) => uploadKeyLabel(jwt, input))
        // Carry the response's uploader_name and updated_at into the
        // local meta so the modal immediately shows the Author and
        // Updated columns and the Update / Remove buttons (gated by
        // isMine = author === currentDisplayName) appear without
        // waiting for a sync.
        return setHubPostId(localId, result.id, result.uploader_name, result.updated_at)
      } catch (err) {
        if (err instanceof Hub409Error) {
          return { success: false, errorCode: 'DUPLICATE_NAME', error: HUB_ERROR_KEY_LABEL_DUPLICATE }
        }
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_UPDATE,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<KeyLabelMeta>
      const hubPostId = record.data.meta.hubPostId
      if (!hubPostId) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Entry has no hub post' }
      }
      const input: HubKeyLabelInput = {
        name: record.data.meta.name,
        map: record.data.data.map,
        ...(record.data.data.compositeLabels ? { compositeLabels: record.data.data.compositeLabels } : {}),
      }
      try {
        const result = await withTokenRetry((jwt) => updateKeyLabel(jwt, hubPostId, input))
        // Persist the new Hub-side updated_at so the Updated column
        // matches Hub's own display. Pass undefined uploaderName so
        // setHubPostId leaves the existing value alone.
        return setHubPostId(localId, hubPostId, undefined, result.updated_at)
      } catch (err) {
        if (err instanceof Hub409Error) {
          return { success: false, errorCode: 'DUPLICATE_NAME', error: HUB_ERROR_KEY_LABEL_DUPLICATE }
        }
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub update failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_SYNC,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<KeyLabelMeta>
      const hubPostId = record.data.meta.hubPostId
      if (!hubPostId) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Entry has no hub post' }
      }
      try {
        const { body, uploaderName, hubUpdatedAt } = await fetchHubKeyLabelPayload(
          hubPostId,
          record.data.meta.uploaderName,
          record.data.meta.hubUpdatedAt,
        )
        const composite = body.composite_labels ?? undefined
        // Preserve the local id, name (drag/rename), and hubPostId; only
        // refresh the payload (map / compositeLabels), uploaderName,
        // and hubUpdatedAt.
        return await saveRecord({
          id: localId,
          name: record.data.meta.name,
          ...(uploaderName ? { uploaderName } : {}),
          map: body.map,
          ...(composite ? { compositeLabels: composite } : {}),
          hubPostId,
          ...(hubUpdatedAt ? { hubUpdatedAt } : {}),
        })
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub sync failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_DELETE,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<void>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<void>
      const hubPostId = record.data.meta.hubPostId
      if (!hubPostId) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Entry has no hub post' }
      }
      try {
        await withTokenRetry((jwt) => deleteKeyLabel(jwt, hubPostId))
        const cleared = await setHubPostId(localId, null)
        if (!cleared.success) return cleared as KeyLabelStoreResult<void>
        return { success: true }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub delete failed') }
      }
    },
  )
}
