// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''
let consentAccepted = true

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
}))

vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

vi.mock('../app-config', () => ({
  getAppConfigStore: () => ({
    get: (key: string) => (key === 'typingRecordingConsentAccepted' ? consentAccepted : undefined),
  }),
}))

import { notifyChange } from '../sync/sync-service'
import {
  saveRunLog,
  listRunLogs,
  getRunLog,
} from '../typing-run-log-store'
import type { RunKeystrokeLog, RunLogMeta } from '../../shared/types/typing-run-log'
import { MAX_RUN_LOG_EVENTS, MAX_RUN_LOGS_PER_KEYBOARD } from '../../shared/types/typing-run-log'

function makeLog(overrides?: Partial<RunKeystrokeLog>): RunKeystrokeLog {
  return {
    runId: 'run-1',
    uid: 'kb-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 5000,
    mode: 'words',
    language: 'english',
    words: [
      {
        index: 0,
        display: 'hello',
        typed: 'hello',
        correct: true,
        keystrokes: [
          { pressMs: 0, releaseMs: 80, keycode: 1, row: 0, col: 0, expectedChar: 'h', correct: true },
          { pressMs: 100, releaseMs: 180, keycode: 2, row: 0, col: 1, expectedChar: 'e', correct: true },
        ],
      },
    ],
    ...overrides,
  }
}

describe('typing-run-log-store', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    consentAccepted = true
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'typing-run-log-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('saveRunLog', () => {
    it('persists index + payload and notifies sync', async () => {
      const result = await saveRunLog('kb-1', makeLog())
      expect(result.success).toBe(true)
      expect(result.entry?.id).toBe('run-1')
      expect(notifyChange).toHaveBeenCalledWith('keyboards/kb-1/runs')

      const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8')) as { uid: string; entries: RunLogMeta[] }
      expect(index.uid).toBe('kb-1')
      expect(index.entries).toHaveLength(1)

      const dataPath = join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', index.entries[0].filename)
      const saved = JSON.parse(await readFile(dataPath, 'utf-8')) as RunKeystrokeLog
      expect(saved.runId).toBe('run-1')
      expect(saved.words[0].keystrokes).toHaveLength(2)
    })

    it('rejects when recording consent has not been accepted', async () => {
      consentAccepted = false
      const result = await saveRunLog('kb-1', makeLog())
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/consent/i)
    })

    it('rejects an unsafe uid', async () => {
      const result = await saveRunLog('../evil', makeLog({ uid: '../evil' }))
      expect(result.success).toBe(false)
    })

    it('rejects an unsafe runId (path traversal)', async () => {
      const result = await saveRunLog('kb-1', makeLog({ runId: '../../evil' }))
      expect(result.success).toBe(false)
    })

    it('rejects a uid mismatch between the IPC arg and the payload', async () => {
      const result = await saveRunLog('kb-1', makeLog({ uid: 'kb-2' }))
      expect(result.success).toBe(false)
    })

    it('rejects malformed payloads (missing required fields)', async () => {
      const result = await saveRunLog('kb-1', { runId: 'run-1' })
      expect(result.success).toBe(false)
    })

    it('rejects a payload with more keystrokes than MAX_RUN_LOG_EVENTS', async () => {
      const keystrokes = Array.from({ length: MAX_RUN_LOG_EVENTS + 1 }, (_, i) => ({
        pressMs: i, keycode: 1, row: 0, col: 0,
      }))
      const result = await saveRunLog('kb-1', makeLog({
        words: [{ index: 0, display: 'x', typed: 'x', correct: true, keystrokes }],
      }))
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/many keystrokes/i)
    })

    it('rejects an absolute-looking (out-of-bounds) keystroke timestamp', async () => {
      const result = await saveRunLog('kb-1', makeLog({
        durationMs: 1000,
        words: [{
          index: 0, display: 'x', typed: 'x', correct: true,
          keystrokes: [{ pressMs: Date.now(), keycode: 1, row: 0, col: 0 }],
        }],
      }))
      expect(result.success).toBe(false)
    })

    it('rejects a releaseMs earlier than its own pressMs', async () => {
      const result = await saveRunLog('kb-1', makeLog({
        words: [{
          index: 0, display: 'x', typed: 'x', correct: true,
          keystrokes: [{ pressMs: 500, releaseMs: 100, keycode: 1, row: 0, col: 0 }],
        }],
      }))
      expect(result.success).toBe(false)
    })

    it('rejects a NaN durationMs', async () => {
      const result = await saveRunLog('kb-1', makeLog({ durationMs: Number.NaN }))
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/durationMs/i)
    })

    it('rejects an Infinity durationMs', async () => {
      const result = await saveRunLog('kb-1', makeLog({ durationMs: Number.POSITIVE_INFINITY }))
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/durationMs/i)
    })

    it('rejects a NaN word index', async () => {
      const result = await saveRunLog('kb-1', makeLog({
        words: [{ index: Number.NaN, display: 'x', typed: 'x', correct: true, keystrokes: [] }],
      }))
      expect(result.success).toBe(false)
    })

    it('rejects a non-integer word index', async () => {
      const result = await saveRunLog('kb-1', makeLog({
        words: [{ index: 1.5, display: 'x', typed: 'x', correct: true, keystrokes: [] }],
      }))
      expect(result.success).toBe(false)
    })

    it('accepts a trailing partial word (P5) and persists its partial flag', async () => {
      const result = await saveRunLog('kb-1', makeLog({
        words: [
          { index: 0, display: 'hello', typed: 'hello', correct: true, keystrokes: [] },
          {
            index: 1, display: 'world', typed: 'wo', correct: false, partial: true,
            keystrokes: [{ pressMs: 0, keycode: 1, row: 0, col: 0 }],
          },
        ],
      }))
      expect(result.success).toBe(true)

      const dataPath = join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', result.entry!.filename)
      const saved = JSON.parse(await readFile(dataPath, 'utf-8')) as RunKeystrokeLog
      expect(saved.words[1].partial).toBe(true)
    })

    it('rejects a non-boolean partial flag', async () => {
      const log = makeLog()
      const malformed = {
        ...log,
        words: [{ index: 0, display: 'x', typed: 'x', correct: true, partial: 'yes', keystrokes: [] }],
      }
      const result = await saveRunLog('kb-1', malformed)
      expect(result.success).toBe(false)
    })

    it('accepts and persists an explicit romajiInput flag', async () => {
      const result = await saveRunLog('kb-1', makeLog({ romajiInput: true }))
      expect(result.success).toBe(true)

      const dataPath = join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', result.entry!.filename)
      const saved = JSON.parse(await readFile(dataPath, 'utf-8')) as RunKeystrokeLog
      expect(saved.romajiInput).toBe(true)
    })

    it('accepts an omitted romajiInput flag (backward-compatible, pre-flag logs)', async () => {
      const result = await saveRunLog('kb-1', makeLog())
      expect(result.success).toBe(true)
    })

    it('rejects a non-boolean romajiInput flag', async () => {
      const log = makeLog()
      const malformed = { ...log, romajiInput: 'yes' }
      const result = await saveRunLog('kb-1', malformed)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/romajiInput/i)
    })

    it('saving the same runId twice leaves exactly one payload file on disk (P7)', async () => {
      // Fake timers guarantee the two saves land at different millisecond
      // timestamps — the filename prefix — so the second save's filename
      // genuinely differs from the first's (the scenario the leak needs).
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        const first = await saveRunLog('kb-1', makeLog({ runId: 'run-dup' }))
        expect(first.success).toBe(true)
        const firstFilename = first.entry!.filename

        vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
        const second = await saveRunLog('kb-1', makeLog({ runId: 'run-dup', durationMs: 6000 }))
        expect(second.success).toBe(true)
        const secondFilename = second.entry!.filename
        expect(secondFilename).not.toBe(firstFilename)

        const listed = await listRunLogs('kb-1')
        expect(listed.entries).toHaveLength(1)
        expect(listed.entries?.[0].filename).toBe(secondFilename)

        // The FIRST save's payload file must have been unlinked, not leaked.
        await expect(access(join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', firstFilename)))
          .rejects.toThrow()
        // The second (current) payload file must still be present.
        await expect(access(join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', secondFilename)))
          .resolves.toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('removes an orphan payload file the index has no memory of (D3)', async () => {
      const runsDir = join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs')
      await mkdir(runsDir, { recursive: true })
      // Simulate a previous save whose index write failed/was corrupted
      // after its payload was already written — nothing in index.json
      // references this file.
      await writeFile(join(runsDir, '2020-01-01T00-00-00.000Z_orphan-run.json'), '{"runId":"orphan-run"}', 'utf-8')

      const result = await saveRunLog('kb-1', makeLog({ runId: 'run-1' }))
      expect(result.success).toBe(true)

      await expect(access(join(runsDir, '2020-01-01T00-00-00.000Z_orphan-run.json'))).rejects.toThrow()
      // The current save's own payload must be untouched.
      await expect(access(join(runsDir, result.entry!.filename))).resolves.toBeUndefined()
    })
  })

  describe('lineBreaks (line timeline PR1)', () => {
    // 4 words (indices 0-3) so the terminal boundary (words.length - 1 = 3)
    // and the entry just before it (words.length - 2 = 2) are both
    // meaningful against `words.length`.
    function fourWordLog(overrides?: Partial<RunKeystrokeLog>): RunKeystrokeLog {
      return makeLog({
        words: [0, 1, 2, 3].map((i) => ({
          index: i, display: `w${i}`, typed: `w${i}`, correct: true, keystrokes: [],
        })),
        ...overrides,
      })
    }

    it('roundtrips a non-empty lineBreaks array', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [1, 2] }))
      expect(result.success).toBe(true)
      const fetched = await getRunLog('kb-1', 'run-1')
      expect(fetched.data?.lineBreaks).toEqual([1, 2])
    })

    it('roundtrips an explicit empty lineBreaks array ("one line", not omitted)', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [] }))
      expect(result.success).toBe(true)
      const fetched = await getRunLog('kb-1', 'run-1')
      expect(fetched.data?.lineBreaks).toEqual([])
    })

    it('accepts an absent lineBreaks (legacy log, falls back to per-word rendering)', async () => {
      const result = await saveRunLog('kb-1', makeLog())
      expect(result.success).toBe(true)
      const fetched = await getRunLog('kb-1', 'run-1')
      expect(fetched.data?.lineBreaks).toBeUndefined()
    })

    it('rejects a non-array lineBreaks', async () => {
      const malformed = { ...fourWordLog(), lineBreaks: 'nope' }
      const result = await saveRunLog('kb-1', malformed)
      expect(result.success).toBe(false)
    })

    it('rejects a non-integer entry', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [1.5] }))
      expect(result.success).toBe(false)
    })

    it('rejects an unsorted lineBreaks array', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [2, 1] }))
      expect(result.success).toBe(false)
    })

    it('rejects duplicate entries (not strictly ascending)', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [1, 1] }))
      expect(result.success).toBe(false)
    })

    it('rejects an out-of-range entry (>= words.length)', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [4] }))
      expect(result.success).toBe(false)
    })

    it('rejects a negative entry', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [-1] }))
      expect(result.success).toBe(false)
    })

    // P2-2 (codex review): a line break must have at least one word after
    // it — the log's own last word (words.length - 1) can never be one.
    it('rejects a terminal entry (index === words.length - 1, no word follows it)', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [3] }))
      expect(result.success).toBe(false)
    })

    it('accepts an entry one before the terminal (index === words.length - 2)', async () => {
      const result = await saveRunLog('kb-1', fourWordLog({ lineBreaks: [2] }))
      expect(result.success).toBe(true)
      const fetched = await getRunLog('kb-1', 'run-1')
      expect(fetched.data?.lineBreaks).toEqual([2])
    })
  })

  describe('list / get roundtrip', () => {
    it('lists newest-first and gets the full payload', async () => {
      await saveRunLog('kb-1', makeLog({ runId: 'run-1', startedAt: '2026-01-01T00:00:00.000Z' }))
      await saveRunLog('kb-1', makeLog({ runId: 'run-2', startedAt: '2026-01-02T00:00:00.000Z' }))

      const listed = await listRunLogs('kb-1')
      expect(listed.success).toBe(true)
      expect(listed.entries?.map((e) => e.id)).toEqual(['run-2', 'run-1'])

      const fetched = await getRunLog('kb-1', 'run-1')
      expect(fetched.success).toBe(true)
      expect(fetched.data?.runId).toBe('run-1')

      const missing = await getRunLog('kb-1', 'no-such-run')
      expect(missing.success).toBe(false)
    })
  })

  describe('retention (51st run evicts the oldest)', () => {
    it('keeps only MAX_RUN_LOGS_PER_KEYBOARD runs, tombstoning + unlinking the oldest', async () => {
      for (let i = 0; i < MAX_RUN_LOGS_PER_KEYBOARD + 1; i++) {
        const startedAt = new Date(2026, 0, 1, 0, 0, i).toISOString()
        await saveRunLog('kb-1', makeLog({ runId: `run-${i}`, startedAt }))
      }

      const listed = await listRunLogs('kb-1')
      expect(listed.entries).toHaveLength(MAX_RUN_LOGS_PER_KEYBOARD)
      // The very first (oldest startedAt) run must be gone.
      expect(listed.entries?.some((e) => e.id === 'run-0')).toBe(false)
      expect(listed.entries?.some((e) => e.id === `run-${MAX_RUN_LOGS_PER_KEYBOARD}`)).toBe(true)

      const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8')) as { entries: RunLogMeta[] }
      const evictedMeta = index.entries.find((e) => e.id === 'run-0')
      expect(evictedMeta?.deletedAt).toBeDefined()

      // The evicted entry's file must have been unlinked from disk.
      await expect(access(join(mockUserDataPath, 'sync', 'keyboards', 'kb-1', 'runs', evictedMeta!.filename)))
        .rejects.toThrow()
    })
  })
})
