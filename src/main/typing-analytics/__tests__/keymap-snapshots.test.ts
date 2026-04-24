// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import {
  getKeymapSnapshotForRange,
  listKeymapSnapshotSummaries,
  saveKeymapSnapshotIfChanged,
} from '../keymap-snapshots'

let userData = ''

function makeSnapshot(overrides: Partial<TypingKeymapSnapshot> = {}): TypingKeymapSnapshot {
  return {
    uid: 'kb-1',
    machineHash: 'hash-a',
    productName: 'Tester',
    savedAt: 1_000,
    layers: 4,
    matrix: { rows: 5, cols: 12 },
    keymap: [[['KC_A']]],
    layout: null,
    ...overrides,
  }
}

async function writeSnapshotFile(
  userDataDir: string,
  uid: string,
  hash: string,
  snapshot: TypingKeymapSnapshot,
): Promise<void> {
  const dir = join(userDataDir, 'typing-analytics', 'keymaps', uid, hash)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${snapshot.savedAt}.json`), JSON.stringify(snapshot), 'utf-8')
}

describe('keymap-snapshots', () => {
  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), 'pipette-keymap-snapshots-test-'))
  })

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true })
  })

  describe('listKeymapSnapshotSummaries', () => {
    it('returns empty list when the directory does not exist', async () => {
      const out = await listKeymapSnapshotSummaries(userData, 'kb-1', 'hash-a')
      expect(out).toEqual([])
    })

    it('returns metadata for every snapshot file, sorted ascending by savedAt', async () => {
      await writeSnapshotFile(userData, 'kb-1', 'hash-a', makeSnapshot({ savedAt: 3000 }))
      await writeSnapshotFile(userData, 'kb-1', 'hash-a', makeSnapshot({ savedAt: 1000 }))
      await writeSnapshotFile(userData, 'kb-1', 'hash-a', makeSnapshot({ savedAt: 2000 }))
      const out = await listKeymapSnapshotSummaries(userData, 'kb-1', 'hash-a')
      expect(out.map((s) => s.savedAt)).toEqual([1000, 2000, 3000])
      expect(out[0]).toMatchObject({
        uid: 'kb-1',
        machineHash: 'hash-a',
        productName: 'Tester',
        layers: 4,
        matrix: { rows: 5, cols: 12 },
      })
      // Heavy payload fields must not leak into summaries.
      expect('keymap' in out[0]).toBe(false)
      expect('layout' in out[0]).toBe(false)
    })

    it('skips unreadable files silently', async () => {
      await writeSnapshotFile(userData, 'kb-1', 'hash-a', makeSnapshot({ savedAt: 1000 }))
      const brokenDir = join(userData, 'typing-analytics', 'keymaps', 'kb-1', 'hash-a')
      await writeFile(join(brokenDir, '2000.json'), 'not json', 'utf-8')
      const out = await listKeymapSnapshotSummaries(userData, 'kb-1', 'hash-a')
      expect(out.map((s) => s.savedAt)).toEqual([1000])
    })

    it('is isolated per machineHash', async () => {
      await writeSnapshotFile(userData, 'kb-1', 'hash-a', makeSnapshot({ savedAt: 1000 }))
      await writeSnapshotFile(userData, 'kb-1', 'hash-b', makeSnapshot({ machineHash: 'hash-b', savedAt: 2000 }))
      const a = await listKeymapSnapshotSummaries(userData, 'kb-1', 'hash-a')
      const b = await listKeymapSnapshotSummaries(userData, 'kb-1', 'hash-b')
      expect(a.map((s) => s.savedAt)).toEqual([1000])
      expect(b.map((s) => s.savedAt)).toEqual([2000])
    })

    it('reflects snapshots created through saveKeymapSnapshotIfChanged', async () => {
      const first = makeSnapshot({ savedAt: 1000 })
      const second = makeSnapshot({ savedAt: 2000, keymap: [[['KC_B']]] })
      await saveKeymapSnapshotIfChanged(userData, first)
      await saveKeymapSnapshotIfChanged(userData, second)
      const out = await listKeymapSnapshotSummaries(userData, 'kb-1', 'hash-a')
      expect(out.map((s) => s.savedAt)).toEqual([1000, 2000])
    })

    it('agrees with getKeymapSnapshotForRange about which snapshots exist', async () => {
      await saveKeymapSnapshotIfChanged(userData, makeSnapshot({ savedAt: 1000 }))
      const summaries = await listKeymapSnapshotSummaries(userData, 'kb-1', 'hash-a')
      expect(summaries).toHaveLength(1)
      const hit = await getKeymapSnapshotForRange(userData, 'kb-1', 'hash-a', 500, 1500)
      expect(hit?.savedAt).toBe(1000)
    })
  })
})
