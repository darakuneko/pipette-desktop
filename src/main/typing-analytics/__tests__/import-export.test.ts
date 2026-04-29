// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportFileNameFor,
  exportTypingDataForKeyboard,
  importTypingDataFiles,
  parseExportFileName,
} from '../import-export'
import { deviceDayJsonlPath, deviceDayDir } from '../jsonl/paths'

const UID = '0xAABB'
const HASH = 'hash-self'

function seedDay(userData: string, hash: string, day: string, body: string): void {
  const dir = deviceDayDir(userData, UID, hash)
  mkdirSync(dir, { recursive: true })
  writeFileSync(deviceDayJsonlPath(userData, UID, hash, day), body, 'utf-8')
}

function dayStartMs(day: string): number {
  return Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
    10, 0, 0, 0,
  )
}

function rowLine(day: string, kind: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ id: `${kind}-${day}`, kind, updated_at: dayStartMs(day), payload }) + '\n'
}

function charMinuteRow(day: string): string {
  return rowLine(day, 'char-minute', { scopeId: 's1', minuteTs: dayStartMs(day), char: 'a', count: 3 })
}

function sessionRow(day: string): string {
  const startMs = dayStartMs(day)
  return rowLine(day, 'session', { id: 'sess-1', scopeId: 's1', startMs, endMs: startMs + 1_000 })
}

function minuteStatsRow(day: string): string {
  return rowLine(day, 'minute-stats', {
    scopeId: 's1', minuteTs: dayStartMs(day), keystrokes: 3, activeMs: 1_000,
    intervalAvgMs: null, intervalMinMs: null, intervalP25Ms: null,
    intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null,
  })
}

function scopeRow(day: string): string {
  return rowLine(day, 'scope', {
    id: 's1', machineHash: HASH, osPlatform: 'linux', osRelease: '6.8',
    osArch: 'x64', keyboardUid: UID, keyboardVendorId: 0xAA,
    keyboardProductId: 0xBB, keyboardProductName: 'Test KB',
  })
}

// Fixed clock outside the test days so live-day-locked never trips.
const NOW_MS = Date.UTC(2026, 3, 25, 12, 0, 0, 0)
const FIXED_NOW = (): number => NOW_MS

describe('export filename helpers', () => {
  it('round-trips through exportFileNameFor / parseExportFileName', () => {
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    expect(name).toBe('keyboards_0xAABB_devices_hash-self_days_2026-04-19.jsonl')
    expect(parseExportFileName(name)).toEqual({
      uid: UID,
      machineHash: HASH,
      utcDay: '2026-04-19',
      fileName: name,
    })
  })

  it('rejects unrelated names', () => {
    expect(parseExportFileName('not-a-typing-file.txt')).toBeNull()
    expect(parseExportFileName('keyboards_0xAABB_devices_hash_days_bad-date.jsonl')).toBeNull()
    expect(parseExportFileName('keyboards_0xAABB_devices_hash_days_2026-04-19.enc')).toBeNull()
  })
})

describe('exportTypingDataForKeyboard', () => {
  let userData: string
  let outDir: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'pipette-export-userdata-'))
    outDir = mkdtempSync(join(tmpdir(), 'pipette-export-out-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  })

  it('writes one file per day with the canonical name', async () => {
    seedDay(userData, HASH, '2026-04-18', charMinuteRow('2026-04-18'))
    seedDay(userData, HASH, '2026-04-19', sessionRow('2026-04-19'))

    const result = await exportTypingDataForKeyboard(userData, UID, HASH, outDir)
    expect(result.written).toBe(2)
    const files = readdirSync(outDir).sort()
    expect(files).toEqual([
      exportFileNameFor(UID, HASH, '2026-04-18'),
      exportFileNameFor(UID, HASH, '2026-04-19'),
    ])
  })

  it('returns zero when the device has no recorded days', async () => {
    const result = await exportTypingDataForKeyboard(userData, UID, HASH, outDir)
    expect(result.written).toBe(0)
    expect(readdirSync(outDir)).toEqual([])
  })

  it('writes only the days listed in daysFilter when provided', async () => {
    seedDay(userData, HASH, '2026-04-17', charMinuteRow('2026-04-17'))
    seedDay(userData, HASH, '2026-04-18', charMinuteRow('2026-04-18'))
    seedDay(userData, HASH, '2026-04-19', sessionRow('2026-04-19'))

    const result = await exportTypingDataForKeyboard(
      userData, UID, HASH, outDir, new Set(['2026-04-18', '2026-04-19']),
    )
    expect(result.written).toBe(2)
    expect(readdirSync(outDir).sort()).toEqual([
      exportFileNameFor(UID, HASH, '2026-04-18'),
      exportFileNameFor(UID, HASH, '2026-04-19'),
    ])
  })

  it('returns zero when daysFilter is empty', async () => {
    seedDay(userData, HASH, '2026-04-18', charMinuteRow('2026-04-18'))
    const result = await exportTypingDataForKeyboard(userData, UID, HASH, outDir, new Set<string>())
    expect(result.written).toBe(0)
    expect(readdirSync(outDir)).toEqual([])
  })
})

describe('importTypingDataFiles', () => {
  let userData: string
  let importDir: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'pipette-import-userdata-'))
    importDir = mkdtempSync(join(tmpdir(), 'pipette-import-src-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(importDir, { recursive: true, force: true })
  })

  function writeImport(name: string, body: string): string {
    const path = join(importDir, name)
    writeFileSync(path, body, 'utf-8')
    return path
  }

  it('rejects files with names that do not match the export pattern', async () => {
    const path = writeImport('typed-on-friday.jsonl', charMinuteRow('2026-04-19'))
    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(0)
    expect(out.rejections).toEqual([{ fileName: 'typed-on-friday.jsonl', reason: 'invalid-filename' }])
  })

  it('rejects files when neither local nor cloud already has the target day', async () => {
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    const path = writeImport(name, charMinuteRow('2026-04-19'))
    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: async () => false, now: FIXED_NOW })
    expect(out.imported).toBe(0)
    expect(out.rejections[0]).toMatchObject({ fileName: name, reason: 'no-matching-target' })
  })

  it('overwrites the existing local file when the timestamps fall inside the day window', async () => {
    seedDay(userData, HASH, '2026-04-19', '{"id":"old"}\n')
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    const newBody = charMinuteRow('2026-04-19')
    const path = writeImport(name, newBody)

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(1)
    expect(out.rejections).toEqual([])
    const written = readFileSync(deviceDayJsonlPath(userData, UID, HASH, '2026-04-19'), 'utf-8')
    expect(written).toBe(newBody)
  })

  it('accepts a session whose endMs spills into the next UTC day', async () => {
    seedDay(userData, HASH, '2026-04-19', '{"id":"old"}\n')
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    const startMs = Date.UTC(2026, 3, 19, 23, 30, 0, 0) // 23:30 UTC, inside the day
    const body = rowLine('2026-04-19', 'session', {
      id: 'sess-cross', scopeId: 's1', startMs,
      endMs: startMs + 90 * 60_000, // crosses into 2026-04-20 01:00 — allowed
    })
    const path = writeImport(name, body)

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(1)
    expect(out.rejections).toEqual([])
  })

  it('rejects files whose row timestamps fall outside the day window', async () => {
    seedDay(userData, HASH, '2026-04-19', '{"id":"existing"}\n')
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    // Row's minuteTs is for 2026-04-21 — well outside the day window.
    const wrongDayBody = minuteStatsRow('2026-04-21')
    const path = writeImport(name, wrongDayBody)

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(0)
    expect(out.rejections[0]).toMatchObject({ fileName: name, reason: 'rows-outside-day-window' })
    // Original local file is untouched.
    expect(readFileSync(deviceDayJsonlPath(userData, UID, HASH, '2026-04-19'), 'utf-8')).toBe('{"id":"existing"}\n')
  })

  it('accepts a cloud-only target match when local does not have the file', async () => {
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    const body = charMinuteRow('2026-04-19')
    const path = writeImport(name, body)
    // Cloud says yes for this one filename.
    const cloudHasFile = vi.fn(async (n: string) => n === name)

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile, now: FIXED_NOW })
    expect(out.imported).toBe(1)
    expect(cloudHasFile).toHaveBeenCalledWith(name)
    expect(readFileSync(deviceDayJsonlPath(userData, UID, HASH, '2026-04-19'), 'utf-8')).toBe(body)
  })

  it('rejects an import targeting today (UTC) regardless of local existence', async () => {
    // Recorder owns the live day file — refuse to overwrite it.
    const liveDay = '2026-04-25' // matches NOW_MS
    seedDay(userData, HASH, liveDay, '{"id":"existing"}\n')
    const name = exportFileNameFor(UID, HASH, liveDay)
    const path = writeImport(name, charMinuteRow(liveDay))

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(0)
    expect(out.rejections[0]).toMatchObject({ fileName: name, reason: 'live-day-locked' })
    // Live file is untouched.
    expect(readFileSync(deviceDayJsonlPath(userData, UID, HASH, liveDay), 'utf-8')).toBe('{"id":"existing"}\n')
  })

  it('rejects empty files as empty-or-invalid-content', async () => {
    seedDay(userData, HASH, '2026-04-19', '{"id":"existing"}\n')
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    const path = writeImport(name, '')

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(0)
    expect(out.rejections[0]).toMatchObject({ fileName: name, reason: 'empty-or-invalid-content' })
    expect(readFileSync(deviceDayJsonlPath(userData, UID, HASH, '2026-04-19'), 'utf-8')).toBe('{"id":"existing"}\n')
  })

  it('rejects files where any line fails to parse (no silent partial overwrite)', async () => {
    seedDay(userData, HASH, '2026-04-19', '{"id":"existing"}\n')
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    // First line is valid, second is broken JSON — must reject the whole file.
    const path = writeImport(name, charMinuteRow('2026-04-19') + '{ not json }\n')

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(0)
    expect(out.rejections[0]).toMatchObject({ fileName: name, reason: 'empty-or-invalid-content' })
    expect(readFileSync(deviceDayJsonlPath(userData, UID, HASH, '2026-04-19'), 'utf-8')).toBe('{"id":"existing"}\n')
  })

  it('rejects the second file in a batch when both target the same day', async () => {
    seedDay(userData, HASH, '2026-04-19', '{"id":"existing"}\n')
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    const firstBody = charMinuteRow('2026-04-19')
    // Two distinct source paths but both decode to the same target day —
    // accepting both would make the final file contents depend on
    // file-list order. Only the first is allowed in.
    const firstPath = join(importDir, 'first', name)
    mkdirSync(join(importDir, 'first'), { recursive: true })
    writeFileSync(firstPath, firstBody, 'utf-8')
    const secondPath = join(importDir, 'second', name)
    mkdirSync(join(importDir, 'second'), { recursive: true })
    writeFileSync(secondPath, charMinuteRow('2026-04-19'), 'utf-8')

    const out = await importTypingDataFiles(userData, [firstPath, secondPath], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(1)
    expect(out.rejections).toEqual([{ fileName: name, reason: 'duplicate-in-batch' }])
    expect(readFileSync(deviceDayJsonlPath(userData, UID, HASH, '2026-04-19'), 'utf-8')).toBe(firstBody)
  })

  it('rejects files containing only scope rows (no timestamped content)', async () => {
    seedDay(userData, HASH, '2026-04-19', '{"id":"existing"}\n')
    const name = exportFileNameFor(UID, HASH, '2026-04-19')
    const path = writeImport(name, scopeRow('2026-04-19'))

    const out = await importTypingDataFiles(userData, [path], { cloudHasFile: null, now: FIXED_NOW })
    expect(out.imported).toBe(0)
    expect(out.rejections[0]).toMatchObject({ fileName: name, reason: 'empty-or-invalid-content' })
    expect(readFileSync(deviceDayJsonlPath(userData, UID, HASH, '2026-04-19'), 'utf-8')).toBe('{"id":"existing"}\n')
  })
})
