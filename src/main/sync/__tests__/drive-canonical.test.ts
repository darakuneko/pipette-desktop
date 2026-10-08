// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { canonicalFiles, filesNamed, pickCanonicalFile } from '../drive-canonical'
import type { DriveFile } from '../google-drive'

const file = (id: string, modifiedTime: string, name = 'a.enc'): DriveFile => ({ id, name, modifiedTime })

describe('drive-canonical', () => {
  describe('pickCanonicalFile', () => {
    it('picks the newest modifiedTime in any listing order', () => {
      const older = file('a', '2026-01-01T00:00:00.000Z')
      const newer = file('b', '2026-01-02T00:00:00.000Z')
      expect(pickCanonicalFile([older, newer], 'a.enc')).toBe(newer)
      expect(pickCanonicalFile([newer, older], 'a.enc')).toBe(newer)
    })

    it('breaks a modifiedTime tie with the smallest id', () => {
      const time = '2026-01-01T00:00:00.000Z'
      expect(pickCanonicalFile([file('z', time), file('m', time)], 'a.enc')?.id).toBe('m')
      expect(pickCanonicalFile([file('m', time), file('z', time)], 'a.enc')?.id).toBe('m')
    })

    it('ranks an unparseable modifiedTime below every valid one', () => {
      const broken = file('a', 'not-a-time')
      const valid = file('b', '2020-01-01T00:00:00.000Z')
      expect(pickCanonicalFile([broken, valid], 'a.enc')).toBe(valid)
      expect(pickCanonicalFile([valid, broken], 'a.enc')).toBe(valid)
    })

    it('only considers files with the given name', () => {
      const other = file('x', '2030-01-01T00:00:00.000Z', 'b.enc')
      const match = file('y', '2020-01-01T00:00:00.000Z')
      expect(pickCanonicalFile([other, match], 'a.enc')).toBe(match)
      expect(pickCanonicalFile([other], 'a.enc')).toBeUndefined()
    })
  })

  describe('canonicalFiles / filesNamed', () => {
    it('keeps one copy per name, chosen like pickCanonicalFile, in first-listed order', () => {
      const listing = [
        file('b-old', '2026-01-01T00:00:00.000Z', 'b.enc'),
        file('a-1', '2026-01-01T00:00:00.000Z'),
        file('b-new', '2026-01-03T00:00:00.000Z', 'b.enc'),
      ]

      expect(canonicalFiles(listing).map((f) => f.id)).toEqual(['b-new', 'a-1'])
      expect(canonicalFiles([])).toEqual([])
    })

    it('lists every copy of a name and nothing for an unlisted name', () => {
      const listing = [
        file('b-old', '2026-01-01T00:00:00.000Z', 'b.enc'),
        file('a-1', '2026-01-01T00:00:00.000Z'),
        file('b-new', '2026-01-03T00:00:00.000Z', 'b.enc'),
      ]

      expect(filesNamed(listing, 'b.enc').map((f) => f.id)).toEqual(['b-old', 'b-new'])
      expect(filesNamed(listing, 'c.enc')).toEqual([])
    })

    it('answers each listing from its own contents', () => {
      const first = [file('x', '2026-01-01T00:00:00.000Z')]
      const second = [file('y', '2026-01-02T00:00:00.000Z')]

      expect(pickCanonicalFile(first, 'a.enc')?.id).toBe('x')
      expect(pickCanonicalFile(second, 'a.enc')?.id).toBe('y')
      expect(pickCanonicalFile(first, 'a.enc')?.id).toBe('x')
    })
  })
})
