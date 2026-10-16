// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// The run log members over the mocked Tauri IPC: a save crosses as the
// JSON text of the log at the call, queued under the keyboard's uid behind
// the keyboard's other store writes and the app config sets made before it,
// and the list and the get read without waiting.

import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import { runLogsApi } from '../api/run-logs'
import { appConfigApi } from '../api/app-config'
import { snapshotsApi } from '../api/snapshots'

afterEach(() => {
  clearMocks()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function runLog(): RunKeystrokeLog {
  return {
    runId: 'run-1',
    uid: '0xA',
    startedAt: '2026-10-16T12:00:00.000Z',
    durationMs: Number.NaN,
    mode: 'words',
    language: 'english',
    romajiInput: undefined,
    words: [{ index: 0, display: 'a', typed: 'a', correct: true, keystrokes: [{ pressMs: 0, keycode: 4, row: 0, col: 0 }] }],
  }
}

describe('runLogsApi', () => {
  it('sends the log as its JSON text at the call', async () => {
    const sent: unknown[] = []
    mockIPC((_cmd, payload) => {
      sent.push(payload)
      return { success: true }
    })
    const log = runLog()
    const saved = runLogsApi.typingRunLogSave('0xA', log)
    log.mode = 'changed'
    await saved
    expect(sent).toEqual([
      {
        uid: '0xA',
        log: '{"runId":"run-1","uid":"0xA","startedAt":"2026-10-16T12:00:00.000Z","durationMs":null,"mode":"words","language":"english","words":[{"index":0,"display":"a","typed":"a","correct":true,"keystrokes":[{"pressMs":0,"keycode":4,"row":0,"col":0}]}]}',
      },
    ])
  })

  it('queues a save behind the keyboard’s other writes and reads without waiting', async () => {
    const log: string[] = []
    const releases: (() => void)[] = []
    mockIPC((cmd) => {
      log.push(`start ${cmd}`)
      return new Promise((resolve) => {
        releases.push(() => {
          log.push(`end ${cmd}`)
          resolve({ success: true })
        })
      })
    })
    const rename = snapshotsApi.snapshotStoreRename('0xA', 'id', 'x')
    const save = runLogsApi.typingRunLogSave('0xA', runLog())
    const reads = [runLogsApi.typingRunLogList('0xA'), runLogsApi.typingRunLogGet('0xA', 'run-1')]
    await settle()
    expect([...log].sort()).toEqual(['start snapshot_store_rename', 'start typing_run_log_get', 'start typing_run_log_list'])
    releases.splice(0).forEach((release) => release())
    await Promise.all([rename, ...reads])
    await settle()
    expect(log).toContain('start typing_run_log_save')
    releases.splice(0).forEach((release) => release())
    await save
  })

  it('saves only after the app config sets made before it have finished', async () => {
    let consent = true
    const releases: (() => void)[] = []
    const sent: string[] = []
    mockIPC((cmd, payload) => {
      sent.push(cmd)
      if (cmd === 'app_config_set') {
        return new Promise<void>((resolve) => {
          releases.push(() => {
            consent = JSON.parse((payload as { value: string }).value) as boolean
            resolve()
          })
        })
      }
      return consent ? { success: true, entry: {} } : { success: false, error: 'consent' }
    })
    const set = appConfigApi.appConfigSet('typingRecordingConsentAccepted', false)
    const save = runLogsApi.typingRunLogSave('0xA', runLog())
    await settle()
    expect(sent).toEqual(['app_config_set'])
    releases.splice(0).forEach((release) => release())
    await set
    expect(await save).toEqual({ success: false, error: 'consent' })
    expect(sent).toEqual(['app_config_set', 'typing_run_log_save'])
  })
})
