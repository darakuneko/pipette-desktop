// SPDX-License-Identifier: GPL-2.0-or-later
//
// IPC handler tests for the Hub Analytics upload / update / preview
// flow. Mirrors hub-ipc-favorite.test.ts so the two pipelines stay
// shaped the same way (validate → withTokenRetry → setHubPostId on
// success, surface validator failures without uploading).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Electron mocks ---------------------------------------------------

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      _handlers: handlers,
    },
    app: { getPath: () => '/tmp/userData' },
  }
})

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

vi.mock('../key-label-store', () => ({
  KEY_LABEL_SYNC_UNIT: 'key-labels',
  getRecord: vi.fn(),
  saveRecord: vi.fn(),
  setHubPostId: vi.fn(),
}))

vi.mock('../sync/google-auth', () => ({
  getIdToken: vi.fn(),
}))

vi.mock('../hub/hub-client', async () => {
  const actual = await vi.importActual<typeof import('../hub/hub-client')>('../hub/hub-client')
  return {
    Hub401Error: actual.Hub401Error,
    Hub403Error: actual.Hub403Error,
    Hub409Error: actual.Hub409Error,
    Hub429Error: actual.Hub429Error,
    authenticateWithHub: vi.fn(),
    uploadPostToHub: vi.fn(),
    updatePostOnHub: vi.fn(),
    patchPostOnHub: vi.fn(),
    deletePostFromHub: vi.fn(),
    fetchMyPosts: vi.fn(),
    fetchMyPostsByKeyboard: vi.fn(),
    fetchAuthMe: vi.fn(),
    patchAuthMe: vi.fn(),
    getHubOrigin: vi.fn(),
    uploadFeaturePostToHub: vi.fn(),
    updateFeaturePostOnHub: vi.fn(),
    uploadAnalyticsPostToHub: vi.fn(async () => ({ id: 'post-1', title: 'My filter' })),
    updateAnalyticsPostOnHub: vi.fn(async () => ({ id: 'post-1', title: 'My filter' })),
  }
})

vi.mock('../hub/hub-analytics', () => ({
  buildAnalyticsExport: vi.fn(),
  validateAnalyticsExport: vi.fn(),
  estimateAnalyticsExportSizeBytes: vi.fn(),
}))

vi.mock('../analyze-filter-store', () => ({
  readAnalyzeFilterEntry: vi.fn(),
  setAnalyzeFilterHubPostId: vi.fn(async () => ({ success: true })),
}))

vi.mock('../typing-analytics/keymap-snapshots', () => ({
  getKeymapSnapshotForRange: vi.fn(),
}))

vi.mock('../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'own-hash'),
}))

// --- Imports after mocks ----------------------------------------------

import { ipcMain } from 'electron'
import { getIdToken } from '../sync/google-auth'
import {
  authenticateWithHub,
  uploadAnalyticsPostToHub,
  updateAnalyticsPostOnHub,
} from '../hub/hub-client'
import {
  buildAnalyticsExport,
  estimateAnalyticsExportSizeBytes,
  validateAnalyticsExport,
} from '../hub/hub-analytics'
import { readAnalyzeFilterEntry, setAnalyzeFilterHubPostId } from '../analyze-filter-store'
import { getKeymapSnapshotForRange } from '../typing-analytics/keymap-snapshots'
import { setupHubIpc, clearHubTokenCache } from '../hub/hub-ipc'
import { IpcChannels } from '../../shared/ipc/channels'
import type { HubAnalyticsExportV1 } from '../../shared/types/hub'
import type { TypingKeymapSnapshot } from '../../shared/types/typing-analytics'

const SNAPSHOT: TypingKeymapSnapshot = {
  uid: 'kb-1',
  machineHash: 'own-hash',
  productName: 'Test Board',
  savedAt: 1_000_000,
  layers: 1,
  matrix: { rows: 1, cols: 1 },
  keymap: [[['KC_A']]],
  layout: {},
}

const SAVED_PAYLOAD = JSON.stringify({
  version: 1,
  analysisTab: 'summary',
  range: { fromMs: 1_700_000_000_000, toMs: 1_700_000_000_000 + 86_400_000 },
  filters: {
    deviceScopes: ['all'],
    appScopes: [],
    bigrams: { topLimit: 99, slowLimit: 99, fingerLimit: 99 }, // overridden to fixed limits
  },
})

const VALID_EXPORT: HubAnalyticsExportV1 = {
  version: 1,
  kind: 'analytics',
  exportedAt: '2026-05-03T00:00:00.000Z',
  snapshot: {
    keyboard: { uid: 'kb-1', productName: 'Test Board', vendorId: 1, productId: 2 },
    deviceScope: 'all',
    keymapSnapshot: SNAPSHOT,
    range: { fromMs: 1_700_000_000_000, toMs: 1_700_000_000_000 + 86_400_000 },
    totalKeystrokes: 500,
    appScopes: [],
  },
  filters: { analysisTab: 'summary', bigrams: { topLimit: 10, slowLimit: 10, fingerLimit: 20 } },
  data: {
    minuteStats: [],
    matrixCells: [],
    matrixCellsByDay: [],
    layerUsage: [],
    sessions: [],
    bksMinute: [],
    bigramTop: [],
    bigramSlow: [],
    appUsage: [],
    wpmByApp: [],
    peakRecords: {
      peakWpm: null, lowestWpm: null,
      peakKeystrokesPerMin: null, peakKeystrokesPerDay: null, longestSession: null,
    },
    layoutComparison: null,
  },
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (ipcMain as any)._handlers.get(channel)
  expect(handler).toBeDefined()
  return handler
}

function uploadParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    uid: 'kb-1',
    entryId: 'entry-1',
    title: 'My filter',
    thumbnailBase64: Buffer.from('thumb').toString('base64'),
    keyboard: { productName: 'Test Board', vendorId: 1, productId: 2 },
    fingerOverrides: {},
    layoutComparisonInputs: null,
    ...overrides,
  }
}

function previewParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    uid: 'kb-1',
    entryId: 'entry-1',
    keyboard: { productName: 'Test Board', vendorId: 1, productId: 2 },
    fingerOverrides: {},
    layoutComparisonInputs: null,
    ...overrides,
  }
}

function mockHubAuth(): void {
  vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
  vi.mocked(authenticateWithHub).mockResolvedValueOnce({
    token: 'hub-jwt',
    user: { id: 'u1', email: 't@example.com', display_name: null, role: 'user' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearHubTokenCache()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ipcMain as any)._handlers.clear()
  setupHubIpc()
  vi.mocked(readAnalyzeFilterEntry).mockResolvedValue({
    entry: {
      id: 'entry-1',
      label: 'My filter',
      filename: 'entry-1.json',
      savedAt: '2026-05-03T00:00:00.000Z',
    },
    data: SAVED_PAYLOAD,
  })
  vi.mocked(getKeymapSnapshotForRange).mockResolvedValue(SNAPSHOT)
  vi.mocked(buildAnalyticsExport).mockResolvedValue(VALID_EXPORT)
  vi.mocked(validateAnalyticsExport).mockReturnValue({ ok: true })
  vi.mocked(estimateAnalyticsExportSizeBytes).mockReturnValue(1234)
})

describe('HUB_UPLOAD_ANALYTICS_POST', () => {
  it('uploads, stamps the postId on the saved entry, and returns the new id', async () => {
    mockHubAuth()
    const handler = getHandler(IpcChannels.HUB_UPLOAD_ANALYTICS_POST)
    const result = await handler({}, uploadParams()) as { success: boolean; postId?: string }
    expect(result.success).toBe(true)
    expect(result.postId).toBe('post-1')
    expect(uploadAnalyticsPostToHub).toHaveBeenCalledTimes(1)
    expect(setAnalyzeFilterHubPostId).toHaveBeenCalledWith('kb-1', 'entry-1', 'post-1')
  })

  it('forces the bigram limits to 10/10/20 regardless of the saved filter values', async () => {
    mockHubAuth()
    const handler = getHandler(IpcChannels.HUB_UPLOAD_ANALYTICS_POST)
    await handler({}, uploadParams())
    const call = vi.mocked(buildAnalyticsExport).mock.calls[0][0]
    expect(call.filters.bigrams).toEqual({
      topLimit: 10, slowLimit: 10, fingerLimit: 20, pairIntervalThresholdMs: undefined,
    })
  })

  it('pins the Hub initial-tab hint to summary even when the saved payload had a different tab', async () => {
    // Saved condition was authored on the bigrams tab; the Hub hint
    // should still come back as 'summary' so the post detail page
    // lands on the at-a-glance Summary view (mirrors the local Load
    // behaviour).
    vi.mocked(readAnalyzeFilterEntry).mockResolvedValueOnce({
      entry: {
        id: 'entry-1',
        label: 'My filter',
        filename: 'entry-1.json',
        savedAt: '2026-05-04T00:00:00.000Z',
      },
      data: JSON.stringify({
        version: 1,
        analysisTab: 'bigrams',
        range: { fromMs: 1_700_000_000_000, toMs: 1_700_000_000_000 + 86_400_000 },
        filters: { deviceScopes: ['all'], appScopes: [] },
      }),
    })
    mockHubAuth()
    const handler = getHandler(IpcChannels.HUB_UPLOAD_ANALYTICS_POST)
    await handler({}, uploadParams())
    const call = vi.mocked(buildAnalyticsExport).mock.calls[0][0]
    expect(call.filters.analysisTab).toBe('summary')
  })

  it('refuses to upload when the saved entry is missing', async () => {
    vi.mocked(readAnalyzeFilterEntry).mockResolvedValueOnce(null)
    const handler = getHandler(IpcChannels.HUB_UPLOAD_ANALYTICS_POST)
    const result = await handler({}, uploadParams()) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Saved filter entry not found/)
    expect(uploadAnalyticsPostToHub).not.toHaveBeenCalled()
    expect(setAnalyzeFilterHubPostId).not.toHaveBeenCalled()
  })

  it('refuses to upload when the snapshot is missing for the range', async () => {
    vi.mocked(getKeymapSnapshotForRange).mockResolvedValueOnce(null)
    const handler = getHandler(IpcChannels.HUB_UPLOAD_ANALYTICS_POST)
    const result = await handler({}, uploadParams()) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No keymap snapshot/)
    expect(uploadAnalyticsPostToHub).not.toHaveBeenCalled()
  })
})

describe('HUB_UPDATE_ANALYTICS_POST', () => {
  it('rejects an invalid postId before authenticating', async () => {
    const handler = getHandler(IpcChannels.HUB_UPDATE_ANALYTICS_POST)
    const result = await handler({}, { ...uploadParams(), postId: 'bad id with space' }) as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid post ID/)
    expect(updateAnalyticsPostOnHub).not.toHaveBeenCalled()
  })

  it('updates and re-stamps the postId on success', async () => {
    mockHubAuth()
    const handler = getHandler(IpcChannels.HUB_UPDATE_ANALYTICS_POST)
    const result = await handler({}, { ...uploadParams(), postId: 'post-1' }) as { success: boolean; postId?: string }
    expect(result.success).toBe(true)
    expect(updateAnalyticsPostOnHub).toHaveBeenCalledTimes(1)
    expect(setAnalyzeFilterHubPostId).toHaveBeenCalledWith('kb-1', 'entry-1', 'post-1')
  })
})

describe('HUB_PREVIEW_ANALYTICS_POST', () => {
  it('returns size + validation without crossing the network', async () => {
    const handler = getHandler(IpcChannels.HUB_PREVIEW_ANALYTICS_POST)
    const result = await handler({}, previewParams()) as {
      success: boolean
      preview?: { totalKeystrokes: number; estimatedBytes: number; validation: { ok: boolean } }
    }
    expect(result.success).toBe(true)
    expect(result.preview?.totalKeystrokes).toBe(500)
    expect(result.preview?.estimatedBytes).toBe(1234)
    expect(result.preview?.validation.ok).toBe(true)
    expect(uploadAnalyticsPostToHub).not.toHaveBeenCalled()
  })

  it('reports a validation failure without uploading', async () => {
    vi.mocked(validateAnalyticsExport).mockReturnValueOnce({ ok: false, reason: 'keystrokes below threshold' })
    const handler = getHandler(IpcChannels.HUB_PREVIEW_ANALYTICS_POST)
    const result = await handler({}, previewParams()) as {
      preview?: { validation: { ok: boolean; reason?: string } }
    }
    expect(result.preview?.validation).toEqual({ ok: false, reason: 'keystrokes below threshold' })
  })

  it('falls back to a 0-byte preview when the snapshot is missing for the range', async () => {
    vi.mocked(getKeymapSnapshotForRange).mockResolvedValueOnce(null)
    const handler = getHandler(IpcChannels.HUB_PREVIEW_ANALYTICS_POST)
    const result = await handler({}, previewParams()) as {
      preview?: { estimatedBytes: number; validation: { ok: boolean; reason?: string } }
    }
    expect(result.preview?.estimatedBytes).toBe(0)
    expect(result.preview?.validation.ok).toBe(false)
    expect(result.preview?.validation.reason).toMatch(/No keymap snapshot/)
  })
})
