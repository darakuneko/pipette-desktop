// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import {
  buildCurrentFavoriteExport,
  buildFavoriteExport,
  favoriteDataForCurrent,
  planFavoriteImport,
  readFavoriteExportFile,
} from '../favorite-transfer'
import type { FavoriteExportFile } from '../types/favorite-store'

const NOW = new Date('2026-10-16T12:34:56.789Z')
const td = { onTap: 'KC_A', onHold: 'KC_NO', onDoubleTap: 'KC_NO', onTapHold: 'KC_NO', tappingTerm: 200 }

function file(categories: Record<string, unknown[]>, vialProtocol?: number): FavoriteExportFile {
  return {
    app: 'pipette', version: 3, scope: 'fav', exportedAt: NOW.toISOString(), vial_protocol: vialProtocol,
    categories: categories as FavoriteExportFile['categories'],
  }
}

describe('buildFavoriteExport', () => {
  it('names the file after the category and the time and serializes the keycodes', () => {
    const body = JSON.stringify({ type: 'tapDance', data: { ...td, onTap: 4 } })
    const built = buildFavoriteExport('tapDance', 6, [{ label: 'A', savedAt: 's', body }], false, NOW)
    expect(built).toEqual({
      defaultFilename: 'pipette-fav-td-2026-10-16-123456.json',
      content: expect.any(String),
    })
    const parsed = JSON.parse((built as { content: string }).content)
    expect(parsed.categories.td).toEqual([{ label: 'A', savedAt: 's', data: { ...td, onTap: 'KC_A' } }])
    expect(parsed.exportedAt).toBe(NOW.toISOString())
  })

  it('leaves out bodies that are not JSON or have no data, and fails a single export left empty', () => {
    const bodies = [{ label: 'x', savedAt: 's', body: 'not json' }, { label: 'y', savedAt: 's', body: '{"type":"macro"}' }]
    expect(buildFavoriteExport('macro', 6, bodies, true, NOW)).toEqual({ error: 'Entry unreadable' })
    const all = buildFavoriteExport('macro', 6, bodies, false, NOW) as { content: string }
    expect(JSON.parse(all.content).categories).toEqual({})
  })

  it('exports the current value as one entry named Current', () => {
    const built = buildCurrentFavoriteExport('tapDance', 6, JSON.stringify({ type: 'tapDance', data: td }), NOW)
    expect((built as { defaultFilename: string }).defaultFilename).toBe('pipette-fav-td-current-2026-10-16-123456.json')
    expect(buildCurrentFavoriteExport('tapDance', 6, '{"type":"tapDance"}', NOW)).toEqual({ error: 'Missing data field' })
    expect(() => buildCurrentFavoriteExport('tapDance', 6, 'nope', NOW)).toThrow(SyntaxError)
  })
})

describe('reading an export file', () => {
  it('accepts only export files and throws for text that is not JSON', () => {
    expect(readFavoriteExportFile(JSON.stringify(file({ td: [] })))).not.toBeNull()
    expect(readFavoriteExportFile('{"app":"other"}')).toBeNull()
    expect(() => readFavoriteExportFile('{')).toThrow(SyntaxError)
  })

  it('gives the first entry of the category to the editor', () => {
    expect(favoriteDataForCurrent('tapDance', file({ td: [{ label: 'a', savedAt: 's', data: td }] })))
      .toEqual({ data: { ...td, onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0 } })
    expect(favoriteDataForCurrent('combo', file({ td: [] }))).toEqual({ error: 'No matching data found for this type' })
  })
})

describe('planFavoriteImport', () => {
  it('keeps the category order, skips invalid data, and keeps a batch with no valid entry', () => {
    const plan = planFavoriteImport(file({
      combo: [{ label: 'bad', savedAt: 's', data: { key1: 'KC_A' } }],
      td: [{ label: 'a', savedAt: 's1', data: td }, { label: 'b', savedAt: 's2', data: 'nope' }],
    }))
    expect(plan.skipped).toBe(2)
    expect(plan.failure).toBeUndefined()
    expect(plan.batches.map((b) => [b.type, b.entries.length])).toEqual([['combo', 0], ['tapDance', 1]])
    expect(JSON.parse(plan.batches[1].entries[0].body)).toEqual({
      type: 'tapDance', data: { ...td, onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0 },
    })
    expect(plan.batches[1].entries[0]).toMatchObject({ label: 'a', savedAt: 's1' })
  })

  it('stops at a category naming an inherited property of the key map', () => {
    const parsed = JSON.parse('{"td":[],"constructor":[],"macro":[]}') as Record<string, unknown[]>
    const plan = planFavoriteImport(file(parsed))
    expect(plan).toEqual({ batches: [{ type: 'tapDance', entries: [] }], skipped: 0, failure: 'Invalid favorite type' })
  })
})
