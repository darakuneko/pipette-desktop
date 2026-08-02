// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: shared analytics-export assembly path used by the upload,
// update, preview and private-upload analytics handlers. Split out of
// hub-ipc.ts (Task-split-hub-ipc) — see .claude/rules/file-splitting.md.

import type {
  HubUploadAnalyticsPostParams, HubPreviewAnalyticsPostParams,
  HubAnalyticsFilters, HubAnalyticsCategoryId,
} from '../../shared/types/hub'
import {
  buildAnalyticsExport,
  sanitizeFingerOverrides,
  type BuildAnalyticsExportInput,
  type DeviceScope,
} from './hub-analytics'
import { readAnalyzeFilterEntry } from '../analyze-filter-store'
import { getKeymapSnapshotForRange } from '../typing-analytics/keymap-snapshots'
import { getMachineHash } from '../typing-analytics/machine-hash'
import type { TypingKeymapSnapshot } from '../../shared/types/typing-analytics'
import type { LayoutComparisonMetric } from '../../shared/types/typing-analytics'
import type { KleKey } from '../../shared/kle/types'
import { app } from 'electron'

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
export async function prepareAnalyticsExport(
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
        targets: layoutInputs.targets,
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

  const appDataApps = Array.isArray(params.appDataApps)
    ? params.appDataApps.filter((v): v is string => typeof v === 'string')
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
    fingerOverrides: sanitizeFingerOverrides(params.fingerOverrides),
    categories,
    appDataApps,
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
