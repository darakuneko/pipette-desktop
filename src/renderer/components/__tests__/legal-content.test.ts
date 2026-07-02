// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { LEGAL_SECTIONS } from '../legal-content'

describe('LEGAL_SECTIONS', () => {
  it('discloses the Tatoeba typing-test text source, its licenses, and the CC0 exceptions', () => {
    const section = LEGAL_SECTIONS.find((s) => s.title === 'Typing Test Text Sources')
    expect(section).toBeDefined()

    const text = section!.paragraphs.join(' ')
    expect(text).toContain('Tatoeba')
    // CC BY 2.0 FR is the default license (attribution required) for most packs.
    expect(text).toContain('CC BY 2.0 FR')
    // CC0 1.0 covers the exception packs, which must be named explicitly so the
    // disclosure stays accurate if the CC0 language set ever grows.
    expect(text).toContain('CC0 1.0')
    for (const lang of ['English', 'Bangla', 'Kabyle', 'Russian']) {
      expect(text).toContain(lang)
    }
    // Curation/modification notice, required by CC BY's "indicate changes" term.
    expect(text).toMatch(/curated|modified/i)
  })

  it('discloses the Aozora Bunko catalog source and its public-domain status', () => {
    const section = LEGAL_SECTIONS.find((s) => s.title === 'Typing Test Text Sources')
    expect(section).toBeDefined()

    const text = section!.paragraphs.join(' ')
    expect(text).toContain('Aozora Bunko')
    expect(text).toContain('aozora.gr.jp')
    expect(text).toContain('github.com/aozorabunko/aozorabunko')
    expect(text).toMatch(/public domain/i)
  })

  it('keeps the section ordered before Disclaimer (last section stays a catch-all)', () => {
    const titles = LEGAL_SECTIONS.map((s) => s.title)
    expect(titles[titles.length - 1]).toBe('Disclaimer')
    expect(titles).toContain('Typing Test Text Sources')
  })
})
