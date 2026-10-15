// SPDX-License-Identifier: GPL-2.0-or-later
// The favorite transfer worker against the Electron main process: the
// scenarios recorded from the main process handlers
// (scripts/keyboard-store-fixtures/record-favorite-store-fixtures.test.ts)
// replayed through the worker's requests, on a copy of the keycode modules
// of its own, while this module's copy (the renderer's) holds the tables of
// a connected keyboard with custom keycodes. The worker must answer what
// the main process built, read or answered at each step, and the
// renderer's copy must not: converting there would follow the keyboard.
//
// Also the client (favorite-transfer-client.ts), over a fake Worker.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getProtocol, recreateKeyboardKeycodes } from '../../shared/keycodes/keycodes'
import { runFavoriteTransfer as runInRenderer, type FavoriteTransferRequest } from '../workers/favorite-transfer-requests'

type Tree = Record<string, string | { hex: string } | null>

interface Scenario {
  name: string
  time: string
  tree: Tree
  steps: Record<string, unknown>[]
  outcomes: (string | null)[]
  transfers: (Record<string, unknown> | null)[]
}

const FIXTURE = resolve(__dirname, '../../../src-tauri/crates/pipette-keyboard-stores/tests/fixtures/ts_favorite_store_scenarios.json')
const scenarios = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Scenario[]

const FAVORITE_TYPES = ['tapDance', 'macro', 'combo', 'keyOverride', 'altRepeatKey']

/** A worker request of a recorded step, and what the worker must answer. */
interface Check {
  label: string
  time: string
  request: FavoriteTransferRequest
  want: unknown
}

/** The error or the field the main process answered. */
function answered(outcome: string | null): { error?: string; data?: unknown; success: boolean } {
  return JSON.parse(outcome ?? 'null') as { error?: string; data?: unknown; success: boolean }
}

/** A request built from recorded values, which the worker reads as they are. */
const asRequest = (fields: Record<string, unknown>): FavoriteTransferRequest => fields as unknown as FavoriteTransferRequest

/** The worker requests of every step the worker takes part in. */
function checks(): Check[] {
  const found: Check[] = []
  for (const scenario of scenarios) {
    let time = scenario.time
    scenario.steps.forEach((step, at) => {
      const label = `${scenario.name}: step ${at}`
      const transfer = scenario.transfers[at]
      const outcome = answered(scenario.outcomes[at])
      const file = typeof step.dialog === 'string' ? scenario.tree[step.dialog] : undefined
      const scope = step.type
      switch (step.op) {
        case 'at':
          time = step.time as string
          break
        case 'export':
          if (transfer) {
            const request = { op: 'export', scope, vialProtocol: step.vialProtocol, bodies: transfer.bodies, single: 'entryId' in step }
            found.push({ label, time, request: asRequest(request), want: transfer.built })
          }
          break
        case 'exportCurrent': {
          // A dataJson that is not JSON throws before the file is built.
          const want = transfer ? transfer.built : outcome.error?.startsWith('SyntaxError') ? { error: outcome.error } : undefined
          if (want) {
            const request = { op: 'exportCurrent', scope, vialProtocol: step.vialProtocol, dataJson: step.dataJson }
            found.push({ label, time, request: asRequest(request), want })
          }
          break
        }
        case 'importToCurrent':
          if (typeof file === 'string' && FAVORITE_TYPES.includes(step.type as string)) {
            const want = outcome.success ? { data: outcome.data } : { error: outcome.error }
            found.push({ label, time, request: asRequest({ op: 'importToCurrent', scope, raw: file }), want })
          }
          break
        case 'import':
          if (typeof file === 'string') {
            const want = transfer ? { plan: transfer.plan } : { error: outcome.error }
            found.push({ label, time, request: { op: 'import', raw: file }, want })
          }
          break
      }
    })
  }
  return found
}

const CHECKS = checks()

/** The worker's copy of the modules: loaded after the renderer's copy took
 *  a keyboard's tables, and sharing nothing with it. */
let runInWorker: typeof runInRenderer

beforeAll(async () => {
  recreateKeyboardKeycodes({
    vialProtocol: 5,
    layers: 16,
    macroCount: 4,
    tapDanceCount: 2,
    customKeycodes: [{ name: 'MY_KEY', title: 'My key', shortName: 'MK' }],
    midi: 'basic',
    supportedFeatures: new Set(),
  })
  vi.resetModules()
  ;({ runFavoriteTransfer: runInWorker } = await import('../workers/favorite-transfer-requests'))
})

afterEach(() => {
  vi.useRealTimers()
})

function at<T>(time: string, run: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(time))
  try {
    return run()
  } finally {
    vi.useRealTimers()
  }
}

describe('the favorite transfer worker', () => {
  it('has recorded steps of every kind to answer', () => {
    const ops = new Set(CHECKS.map((check) => check.request.op))
    expect([...ops].sort()).toEqual(['export', 'exportCurrent', 'import', 'importToCurrent'])
  })

  it.each(CHECKS.map((check) => [check.label, check] as const))('answers as the main process: %s', (_label, check) => {
    expect(at(check.time, () => runInWorker(check.request))).toEqual(check.want)
  })

  it('leaves the renderer’s tables as they are', () => {
    for (const check of CHECKS) at(check.time, () => runInWorker(check.request))
    expect(getProtocol()).toBe(5)
  })

  it('answers what the renderer’s tables would not', () => {
    const differ = CHECKS.filter((check) => {
      const inRenderer = at(check.time, () => runInRenderer(check.request))
      return JSON.stringify(inRenderer) !== JSON.stringify(check.want)
    })
    expect(differ.map((check) => check.label)).toContain('imports into the current value: step 0')
  })
})

describe('the favorite transfer client', () => {
  /** A Worker that answers in this module, after a task. */
  class FakeWorker extends EventTarget {
    static started: { url: string; options: WorkerOptions | undefined }[] = []
    static failNext = false
    terminated = false

    constructor(url: URL, options?: WorkerOptions) {
      super()
      FakeWorker.started.push({ url: url.href, options })
    }

    postMessage({ id, request }: { id: number; request: FavoriteTransferRequest }): void {
      setTimeout(() => {
        if (FakeWorker.failNext) {
          FakeWorker.failNext = false
          const error = new Event('error') as Event & { message: string }
          error.message = 'boom'
          this.dispatchEvent(error)
          return
        }
        this.dispatchEvent(new MessageEvent('message', { data: { id, result: runInRenderer(request) } }))
      })
    }

    terminate(): void {
      this.terminated = true
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts the module worker once, matches answers to requests and starts again after a failure', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.resetModules()
    const { transfer } = await import('../workers/favorite-transfer-client')

    const raw = (n: number): string => JSON.stringify({ app: 'pipette', version: 2, scope: 'fav', exportedAt: 'x', categories: { td: Array(n).fill({ label: 'l', savedAt: 's', data: {} }) } })
    const [one, two] = await Promise.all([transfer({ op: 'import', raw: raw(1) }), transfer({ op: 'import', raw: raw(2) })])
    expect(one).toEqual({ plan: { batches: [{ type: 'tapDance', entries: [] }], skipped: 1 } })
    expect(two).toEqual({ plan: { batches: [{ type: 'tapDance', entries: [] }], skipped: 2 } })
    expect(FakeWorker.started).toHaveLength(1)
    expect(FakeWorker.started[0].url).toMatch(/\/favorite-transfer\.worker\.ts$/)
    expect(FakeWorker.started[0].options).toEqual({ type: 'module' })

    FakeWorker.failNext = true
    await expect(transfer({ op: 'import', raw: raw(1) })).rejects.toThrow('favorite transfer worker failed: boom')
    await expect(transfer({ op: 'import', raw: raw(3) })).resolves.toMatchObject({ plan: { skipped: 3 } })
    expect(FakeWorker.started).toHaveLength(2)
  })
})
