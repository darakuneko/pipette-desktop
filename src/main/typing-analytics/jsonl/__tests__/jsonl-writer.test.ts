// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { charMinuteRowId, type JsonlRow } from '../jsonl-row'
import { appendRowsToFile } from '../jsonl-writer'

function sampleRow(char: string, count: number, updatedAt: number): JsonlRow {
  return {
    id: charMinuteRowId('scope-1', 60_000, char),
    kind: 'char-minute',
    updated_at: updatedAt,
    payload: { scopeId: 'scope-1', minuteTs: 60_000, char, count },
  }
}

describe('appendRowsToFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-jsonl-writer-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is a no-op for empty input (no file created)', async () => {
    const path = join(tmpDir, 'nested', 'dir', 'file.jsonl')
    await appendRowsToFile(path, [])
    expect(existsSync(path)).toBe(false)
  })

  it('creates parent directories lazily on first non-empty append', async () => {
    const path = join(tmpDir, 'nested', 'dir', 'device.jsonl')
    await appendRowsToFile(path, [sampleRow('a', 1, 1_000)])
    expect(existsSync(path)).toBe(true)
  })

  it('preserves order and newline termination across appends', async () => {
    const path = join(tmpDir, 'device.jsonl')
    await appendRowsToFile(path, [sampleRow('a', 1, 1_000), sampleRow('b', 2, 2_000)])
    await appendRowsToFile(path, [sampleRow('c', 3, 3_000)])
    const content = readFileSync(path, 'utf8')
    expect(content.endsWith('\n')).toBe(true)
    const lines = content.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]).payload.char).toBe('a')
    expect(JSON.parse(lines[1]).payload.char).toBe('b')
    expect(JSON.parse(lines[2]).payload.char).toBe('c')
  })
})
