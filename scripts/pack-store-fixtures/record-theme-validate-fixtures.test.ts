// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the theme pack check of
// src-tauri/crates/pipette-pack-stores (theme_validate.rs): runs
// validateThemePack (src/shared/theme/validate.ts) on hand-picked packs and
// on seeded random ones, and records each pack with what the check
// answered. It also records the limits and key lists the check reads
// (src/shared/types/theme-store.ts), which the crate's constants must
// equal. A case without `input` checks `undefined`.

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { random32 } from '../fixture-random'
import { REPO_ROOT } from '../fixture-vitest-config'
import { validateThemePack } from '../../src/shared/theme/validate'
import { OPTIONAL_THEME_COLOR_KEYS, THEME_COLOR_KEYS, THEME_PACK_LIMITS } from '../../src/shared/types/theme-store'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-pack-stores/tests/fixtures/ts_theme_validate_cases.json')

const colors = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ ...Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, '#2e3440'])), ...extra })
const theme = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ name: 'Nord', version: '1.0.0', colorScheme: 'dark', colors: colors(), ...extra })
const withoutColor = (key: string): Record<string, unknown> => {
  const all = colors()
  delete all[key]
  return theme({ colors: all })
}

const NAMES: unknown[] = ['  Spaced  ', 'x'.repeat(64), 'x'.repeat(65), '😀'.repeat(32), '😀'.repeat(32) + 'x', ' 　 ', '', 5, null, ['x'], 'Lone \ud800']
const VERSIONS: unknown[] = [' 2.0.0 ', '1.0.0-beta.1', '1.0.0-a_b.c', '10.20.30', '1', '1.0', 'v1.0.0', '1.0.0-', '1.0.0-a b', '1.0.0\n', '１.0.0', '1..0', '1.0.0-ü', '1.0.0+build', 1, null]
const SCHEMES: unknown[] = ['light', 'Dark', 'blue', '', 5, null]
const COLOR_VALUES: unknown[] = [
  '#fff', '#FFFF', '#a1b2c3', '#A1B2C3D4', 'rgb(1,2,3)', 'RGBA(1 2 3 / .5)', 'hsl(1, 2%, 3%)', 'Hsla(a\nb)', 'rgb(1)',
  'red', '#12', '#12345', '#1234567', '#ggg', 'rgb()', 'rgb(1,2,3', 'rgb(1)(2)', ' #fff', '#fff ', 'rgbaa(1)', 'rgb (1)',
  'hsl(\ud800)', '\ud800', '', 5, null, true, [], {},
]

function handPicked(): unknown[] {
  const cases: unknown[] = [
    undefined, null, 5, 'text', true, false, [], [theme()], {},
    theme(),
    theme({ colorScheme: 'light', unknownTop: 1 }),
    theme({ colors: colors({ 'key-label-simulated': '#123', 'wire-row': 'rgb(1,2,3)', 'wire-col': 'hsl(1,2%,3%)' }) }),
    theme({ colors: colors({ extra: '#fff', other: 5 }) }),
    theme({ colors: undefined }),
    theme({ colors: null }), theme({ colors: [] }), theme({ colors: 'x' }), theme({ colors: 5 }),
    { name: 5, version: 1, colorScheme: 'x', colors: null },
    { name: 5, version: 1, colorScheme: 'x', colors: { surface: 'red', extra: 1 } },
    theme({ colors: {} }),
    withoutColor('surface'),
    withoutColor('picker-item-border'),
    JSON.parse(`{"__proto__":1,"constructor":2,"name":"Proto","version":"1.0.0","colorScheme":"dark","prototype":3,"colors":${JSON.stringify(colors())}}`),
    theme({ colors: JSON.parse(`{"__proto__":"#fff","constructor":"#fff",${JSON.stringify(colors()).slice(1, -1)},"prototype":"#fff"}`) }),
    { colors: colors(), colorScheme: 'dark', version: '1.0.0', name: 'Reordered', '2': 'index key' },
  ]
  for (const name of NAMES) cases.push(theme({ name }))
  for (const version of VERSIONS) cases.push(theme({ version }))
  for (const colorScheme of SCHEMES) cases.push(theme({ colorScheme }))
  for (const value of COLOR_VALUES) {
    cases.push(theme({ colors: colors({ accent: value }) }))
    cases.push(theme({ colors: colors({ 'wire-col': value }) }))
  }
  return cases
}

const ALPHABET = ['#', '0', '9', 'a', 'A', 'f', 'F', 'g', 'G', '(', ')', ',', 'r', 'R', 'g', 'b', 'h', 's', 'l', 'L', 'a', ' ', '%', '.', '-', '_', '1', '\n', '　', '\ud800']

function randomString(next: () => number): string {
  const length = next() % 12
  let text = next() % 3 === 0 ? ['rgb(', 'hsla(', '#', 'RGB'][next() % 4] : ''
  for (let i = 0; i < length; i++) text += ALPHABET[next() % ALPHABET.length]
  return text
}

function randomCases(count: number): unknown[] {
  const next = random32(0x7e3e)
  const cases: unknown[] = []
  for (let i = 0; i < count; i++) {
    const picked = colors()
    for (let j = next() % 4; j > 0; j--) picked[THEME_COLOR_KEYS[next() % THEME_COLOR_KEYS.length]] = randomString(next)
    if (next() % 4 === 0) delete picked[THEME_COLOR_KEYS[next() % THEME_COLOR_KEYS.length]]
    if (next() % 5 === 0) picked[randomString(next)] = randomString(next)
    const version = next() % 2 === 0 ? `${next() % 20}.${next() % 20}.${next() % 20}${randomString(next)}` : randomString(next)
    cases.push(theme({ name: next() % 6 === 0 ? randomString(next) : 'Random', version, colors: picked }))
  }
  return cases
}

describe('theme pack check fixtures', () => {
  it('records each pack with what validateThemePack answers', () => {
    const cases = [...handPicked(), ...randomCases(100)].map((input) =>
      input === undefined ? { result: validateThemePack(input) } : { input, result: validateThemePack(input) })
    writeJsonFixture(OUT, {
      maxNameLength: THEME_PACK_LIMITS.MAX_NAME_LENGTH,
      colorKeys: THEME_COLOR_KEYS,
      optionalColorKeys: OPTIONAL_THEME_COLOR_KEYS,
      cases,
    })
    expect(cases.some((c) => c.result.ok)).toBe(true)
    expect(cases.some((c) => c.result.warnings.length > 0)).toBe(true)
  })
})
