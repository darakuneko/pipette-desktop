// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateThemePack } from '../validate'

// sample-packs/themes/*.json ship as ready-to-use example theme packs
// (docs/OPERATION-GUIDE.md §6.4). Every one of them must validate against
// the same schema Pipette itself enforces on import/Hub-download, and —
// since Task-kaw-sim-color — every one now defines an explicit, palette-
// matched `key-label-simulated` token rather than relying on the
// auto-complement fallback.
const THEMES_DIR = join(__dirname, '../../../../sample-packs/themes')

function loadThemeFiles(): { name: string; raw: unknown }[] {
  return readdirSync(THEMES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((name) => ({ name, raw: JSON.parse(readFileSync(join(THEMES_DIR, name), 'utf-8')) }))
}

describe('sample-packs/themes/*.json', () => {
  const files = loadThemeFiles()

  it('finds at least one sample theme pack', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files.map((f) => [f.name, f.raw] as const))('%s validates against the theme pack schema', (_name, raw) => {
    const result = validateThemePack(raw)
    expect(result.errors).toHaveLength(0)
    expect(result.ok).toBe(true)
  })

  it.each(files.map((f) => [f.name, f.raw] as const))('%s defines an explicit key-label-simulated token', (_name, raw) => {
    const colors = (raw as { colors: Record<string, string> }).colors
    expect(colors['key-label-simulated']).toBeDefined()
    expect(colors['key-label-simulated']).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  it.each(files.map((f) => [f.name, f.raw] as const))('%s gives key-label-simulated a distinct value from key-label-remap', (_name, raw) => {
    const colors = (raw as { colors: Record<string, string> }).colors
    expect(colors['key-label-simulated'].toLowerCase()).not.toBe(colors['key-label-remap'].toLowerCase())
  })
})
