// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The favorite post members (api/hub-favorite.ts) against the scenarios
// recorded from the Electron handlers
// (src-tauri/crates/pipette-hub/tests/fixtures/ts_hub_handlers_favorite.json),
// with the worker's request run in place. Each step must give the recorded
// answer; a check that fails must fail before the entry is read, a read
// that fails before anything is sent, and a post must send the export JSON
// the Electron handler sent, byte for byte. The backend's own read and
// sending of those steps are the Rust test of the same file
// (crates/pipette-hub/tests/ts_hub_handlers_favorite.rs).
//
// Also: the `isValidHubVialProtocol` table of ts_hub_pure.json holds at the
// members.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { transfer } from '../workers/favorite-transfer-client'
import { runFavoriteTransfer, type FavoriteTransferRequest } from '../workers/favorite-transfer-requests'
import { hubFavoriteApi } from '../api/hub-favorite'
import type { HubUploadFavoritePostParams } from '../../shared/types/hub'

vi.mock('../workers/favorite-transfer-client', () => ({ transfer: vi.fn() }))

const FIXTURES = resolve(__dirname, '../../../src-tauri/crates/pipette-hub/tests/fixtures')
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8')) as Record<string, unknown>

interface Part { headers: string; text?: string }
interface Request { body?: { multipart?: { parts: Part[] } } }
interface Step {
  step: { call: string; args: [Record<string, unknown>] }
  answer: { success: boolean; error?: string }
  requests: Request[]
}
interface Scenario { name: string; treeBefore: Record<string, string>; steps: Step[] }

const golden = fixture('ts_hub_handlers_favorite.json') as { nowMs: number; scenarios: Scenario[] }

const MEMBERS: Record<string, { member: keyof typeof hubFavoriteApi; command: string }> = {
  HUB_UPLOAD_FAVORITE_POST: { member: 'hubUploadFavoritePost', command: 'hub_upload_favorite_post' },
  HUB_UPDATE_FAVORITE_POST: { member: 'hubUpdateFavoritePost', command: 'hub_update_favorite_post' },
  HUB_UPLOAD_PRIVATE_FAVORITE_POST: { member: 'hubUploadPrivateFavoritePost', command: 'hub_upload_private_favorite_post' },
}

/** The failures of the backend's read (`read_entry`). */
const READ_ERRORS = new Set(['Entry not found', 'Invalid filename', 'Entry data is empty', 'Entry type mismatch'])

/** What `hub_favorite_entry` answers for a read that succeeds: the index
 *  entry's label and save time and the text of its body. */
function readFromTree(tree: Record<string, string>, type: string, entryId: string): unknown {
  const dir = `sync/favorites/${type}`
  const index = JSON.parse(tree[`${dir}/index.json`]) as { entries: Array<Record<string, unknown>> }
  const entry = index.entries.find((e) => e.id === entryId && !e.deletedAt)
  if (!entry) throw new Error(`no entry ${entryId}`)
  const { label, savedAt } = entry
  return { success: true, entry: { label, savedAt, body: tree[`${dir}/${String(entry.filename)}`] } }
}

/** The JSON file each recorded multipart request of a step carries. */
function sentJson(step: Step): string[] {
  return step.requests.flatMap((request) =>
    (request.body?.multipart?.parts ?? []).filter((part) => part.headers.includes('name="json"')).map((part) => part.text ?? ''),
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(golden.nowMs)
  vi.mocked(transfer).mockImplementation(async (request: FavoriteTransferRequest) => runFavoriteTransfer(request))
})

afterEach(() => {
  vi.useRealTimers()
  clearMocks()
})

describe('favorite post members', () => {
  const steps = golden.scenarios.flatMap((scenario) =>
    scenario.steps.map((step, index) => [`${scenario.name} #${index}`, scenario, step] as const),
  )

  it('replay every recorded step', () => {
    expect(steps.length).toBe(26)
  })

  it.each(steps)('%s', async (_name, scenario, step) => {
    const { member, command } = MEMBERS[step.step.call]
    const params = step.step.args[0]
    const recordedError = step.answer.success ? undefined : step.answer.error
    const calls: Array<[string, Record<string, unknown>]> = []
    mockIPC((cmd, payload) => {
      const args = payload as Record<string, unknown>
      calls.push([cmd, args])
      if (cmd === 'hub_favorite_entry') {
        if (recordedError !== undefined && READ_ERRORS.has(recordedError)) return { success: false, error: recordedError }
        return readFromTree(scenario.treeBefore, String(args.favoriteType), String(args.entryId))
      }
      if (cmd === command) return step.answer
      throw new Error(`unexpected command ${cmd}`)
    })

    const answer = await (hubFavoriteApi[member] as (p: unknown) => Promise<unknown>)(params)
    expect(answer).toEqual(step.answer)

    const json = sentJson(step)
    if (json.length > 0) {
      expect(new Set(json).size).toBe(1)
      expect(calls).toEqual([
        ['hub_favorite_entry', { favoriteType: params.type, entryId: params.entryId }],
        [command, { params, json: json[0] }],
      ])
    } else if (recordedError !== undefined && READ_ERRORS.has(recordedError)) {
      expect(calls.map(([cmd]) => cmd)).toEqual(['hub_favorite_entry'])
    } else {
      expect(calls).toEqual([])
    }
  })
})

describe('favorite post members on their own', () => {
  const params: HubUploadFavoritePostParams = { type: 'tapDance', entryId: 'e', title: 'T', vialProtocol: 6 }
  const entry = { success: true, entry: { label: 'L', savedAt: 'S', body: '{"type":"tapDance","data":{"onTap":4}}' } }

  it('answers a command that fails with its message', async () => {
    mockIPC((cmd) => {
      if (cmd === 'hub_favorite_entry') return entry
      throw new Error('backend down')
    })
    expect(await hubFavoriteApi.hubUploadFavoritePost(params)).toEqual({ success: false, error: 'backend down' })
    expect(await hubFavoriteApi.hubUpdateFavoritePost({ ...params, postId: 'p' })).toEqual({
      success: false,
      error: 'backend down',
    })
  })

  it('answers the error of the worker', async () => {
    vi.mocked(transfer).mockResolvedValueOnce({ error: 'Entry data is empty' })
    mockIPC((cmd) => (cmd === 'hub_favorite_entry' ? entry : null))
    expect(await hubFavoriteApi.hubUploadPrivateFavoritePost({ ...params, expiresInDays: 7 })).toEqual({
      success: false,
      error: 'Entry data is empty',
    })
  })

  it('answers an exception of the worker as extractError does', async () => {
    mockIPC((cmd) => (cmd === 'hub_favorite_entry' ? entry : null))
    vi.mocked(transfer).mockImplementationOnce(async (request: FavoriteTransferRequest) =>
      runFavoriteTransfer({ ...request, entry: { ...entry.entry, body: 'not json' } } as FavoriteTransferRequest),
    )
    const answer = await hubFavoriteApi.hubUploadFavoritePost(params)
    expect(answer.success).toBe(false)
    expect(answer.error).not.toMatch(/^SyntaxError/)
    expect(answer.error).toBe((() => {
      try { JSON.parse('not json') } catch (err) { return (err as Error).message }
    })())
    vi.mocked(transfer).mockResolvedValueOnce({ thrown: null })
    expect(await hubFavoriteApi.hubUpdateFavoritePost({ ...params, postId: 'p' })).toEqual({
      success: false,
      error: 'Update failed',
    })
  })

  it('checks the Vial protocol as isValidHubVialProtocol does (ts_hub_pure.json)', async () => {
    const cases = fixture('ts_hub_pure.json').isValidHubVialProtocol as Array<{ input: unknown; ok: boolean }>
    expect(cases.length).toBeGreaterThanOrEqual(13)
    const untag = (value: unknown): unknown => {
      if (value !== null && typeof value === 'object') {
        if ('$u' in value) return undefined
        if ('$n' in value) return { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 }[(value as { $n: string }).$n]
      }
      return value
    }
    mockIPC((cmd) => (cmd === 'hub_favorite_entry' ? { success: false, error: 'read' } : null))
    for (const { input, ok } of cases) {
      const answer = await hubFavoriteApi.hubUploadFavoritePost({ ...params, vialProtocol: untag(input) as number })
      expect(answer, JSON.stringify(input)).toEqual({ success: false, error: ok ? 'read' : 'Invalid vialProtocol' })
    }
  })
})
