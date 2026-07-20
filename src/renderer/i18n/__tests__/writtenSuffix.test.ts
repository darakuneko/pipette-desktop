// SPDX-License-Identifier: GPL-2.0-or-later
//
// Plan-qwerty-select-no-rewrite Phase K: the "{{name}} - Written" select
// suffix is a new i18n key that must exist in the built-in English locale
// AND every sample-packs/i18n persona pack (coding-ui.md's "add to every
// pack, not just the standard one" rule) — a pack missing the key falls
// back to English via i18next, which is a silent inconsistency this test
// guards against. Also guards the "bump every file's version together"
// rule (coding-ui.md) for this feature's key addition.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGLISH_PATH = join(HERE, '../locales/english.json')
const SAMPLE_PACKS_DIR = join(HERE, '../../../../sample-packs/i18n')

interface I18nFile {
  version: string
  keyLabels?: {
    select?: {
      writtenSuffix?: string
    }
  }
}

function loadJson(path: string): I18nFile {
  return JSON.parse(readFileSync(path, 'utf-8')) as I18nFile
}

describe('keyLabels.select.writtenSuffix (Plan-qwerty-select-no-rewrite Phase K)', () => {
  const english = loadJson(ENGLISH_PATH)
  const packFiles = readdirSync(SAMPLE_PACKS_DIR).filter((f) => f.endsWith('.json'))

  it('sample-packs/i18n has at least the 4 known persona packs', () => {
    expect(packFiles.length).toBeGreaterThanOrEqual(4)
  })

  it('english.json has a non-empty writtenSuffix with a {{name}} placeholder', () => {
    const suffix = english.keyLabels?.select?.writtenSuffix
    expect(typeof suffix).toBe('string')
    expect(suffix).toContain('{{name}}')
    expect(suffix).toContain('Written')
  })

  it.each(readdirSync(SAMPLE_PACKS_DIR).filter((f) => f.endsWith('.json')))(
    '%s has a non-empty writtenSuffix with a {{name}} placeholder',
    (filename) => {
      const pack = loadJson(join(SAMPLE_PACKS_DIR, filename))
      const suffix = pack.keyLabels?.select?.writtenSuffix
      expect(typeof suffix).toBe('string')
      expect(suffix).toContain('{{name}}')
    },
  )

  it.each(packFiles)('%s top-level version matches english.json (bumped together)', (filename) => {
    const pack = loadJson(join(SAMPLE_PACKS_DIR, filename))
    expect(pack.version).toBe(english.version)
  })
})
