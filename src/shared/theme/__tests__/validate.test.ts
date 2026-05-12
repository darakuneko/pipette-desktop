// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { validateThemePack, validateName, validateVersion } from '../validate'
import { THEME_COLOR_KEYS, THEME_PACK_LIMITS } from '../../types/theme-store'

function validColors(): Record<string, string> {
  const colors: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = '#aabbcc'
  }
  return colors
}

function validPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'My Theme',
    version: '1.0.0',
    colorScheme: 'dark',
    colors: validColors(),
    ...overrides,
  }
}

describe('validateThemePack', () => {
  describe('valid pack', () => {
    it('returns ok for a fully valid light pack', () => {
      const result = validateThemePack(validPack({ colorScheme: 'light' }))
      expect(result.ok).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
      expect(result.header).toEqual({ name: 'My Theme', version: '1.0.0' })
    })

    it('returns ok for a fully valid dark pack', () => {
      const result = validateThemePack(validPack({ colorScheme: 'dark' }))
      expect(result.ok).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.header).toEqual({ name: 'My Theme', version: '1.0.0' })
    })

    it('trims name and version in header', () => {
      const result = validateThemePack(validPack({ name: '  Trimmed  ', version: '  2.0.0  ' }))
      expect(result.ok).toBe(true)
      expect(result.header).toEqual({ name: 'Trimmed', version: '2.0.0' })
    })

    it('accepts hex colors with alpha (#RRGGBBAA)', () => {
      const colors = validColors()
      colors['surface'] = '#aabbccdd'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })

    it('accepts shorthand hex (#RGB)', () => {
      const colors = validColors()
      colors['surface'] = '#abc'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })

    it('accepts shorthand hex with alpha (#RGBA)', () => {
      const colors = validColors()
      colors['surface'] = '#abcd'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })

    it('accepts rgb() function colors', () => {
      const colors = validColors()
      colors['surface'] = 'rgb(255, 128, 0)'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })

    it('accepts rgba() function colors', () => {
      const colors = validColors()
      colors['surface'] = 'rgba(255, 128, 0, 0.5)'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })

    it('accepts hsl() function colors', () => {
      const colors = validColors()
      colors['surface'] = 'hsl(180, 50%, 50%)'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })

    it('accepts hsla() function colors', () => {
      const colors = validColors()
      colors['surface'] = 'hsla(180, 50%, 50%, 0.8)'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })

    it('accepts semver with pre-release tag', () => {
      const result = validateThemePack(validPack({ version: '1.0.0-beta.1' }))
      expect(result.ok).toBe(true)
    })
  })

  describe('non-object input', () => {
    it.each([null, undefined, 42, 'string', true])('returns error for %s', (input) => {
      const result = validateThemePack(input)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Theme pack must be a JSON object')
    })

    it('returns error for array', () => {
      const result = validateThemePack([1, 2, 3])
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Theme pack must be a JSON object')
    })
  })

  describe('colorScheme validation', () => {
    it('returns error when colorScheme is missing', () => {
      const pack = validPack()
      delete pack.colorScheme
      const result = validateThemePack(pack)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('colorScheme must be exactly "light" or "dark"')
    })

    it('returns error when colorScheme is not "light" or "dark"', () => {
      const result = validateThemePack(validPack({ colorScheme: 'auto' }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('colorScheme must be exactly "light" or "dark"')
    })

    it('returns error when colorScheme is a number', () => {
      const result = validateThemePack(validPack({ colorScheme: 0 }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('colorScheme must be exactly "light" or "dark"')
    })
  })

  describe('missing required color keys', () => {
    it('reports each missing key', () => {
      const colors = validColors()
      delete colors['surface']
      delete colors['accent']
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Missing required color: "surface"')
      expect(result.errors).toContain('Missing required color: "accent"')
    })

    it('reports error when colors is empty object', () => {
      const result = validateThemePack(validPack({ colors: {} }))
      expect(result.ok).toBe(false)
      expect(result.errors.filter((e) => e.startsWith('Missing required color'))).toHaveLength(
        THEME_COLOR_KEYS.length,
      )
    })

    it('reports error when colors is not an object', () => {
      const result = validateThemePack(validPack({ colors: 'not-object' }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('colors must be an object')
    })

    it('reports error when colors is an array', () => {
      const result = validateThemePack(validPack({ colors: ['#fff'] }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('colors must be an object')
    })

    it('reports error when colors is null', () => {
      const result = validateThemePack(validPack({ colors: null }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('colors must be an object')
    })
  })

  describe('invalid CSS color values', () => {
    it('rejects named color', () => {
      const colors = validColors()
      colors['surface'] = 'red'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Color "surface" has invalid CSS color value: "red"')
    })

    it('rejects hex without hash', () => {
      const colors = validColors()
      colors['accent'] = 'aabbcc'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Color "accent" has invalid CSS color value: "aabbcc"')
    })

    it('rejects invalid hex length', () => {
      const colors = validColors()
      colors['edge'] = '#abcde'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Color "edge" has invalid CSS color value: "#abcde"')
    })

    it('rejects non-string color value', () => {
      const colors = validColors() as Record<string, unknown>
      colors['surface'] = 123
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Color "surface" must be a string')
    })

    it('rejects empty string', () => {
      const colors = validColors()
      colors['content'] = ''
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Color "content" has invalid CSS color value: ""')
    })
  })

  describe('unknown color keys', () => {
    it('produces warnings for unknown keys but still succeeds', () => {
      const colors = validColors()
      ;(colors as Record<string, string>)['custom-color'] = '#ff0000'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
      expect(result.warnings).toContain('Unknown color key "custom-color" will be ignored')
    })

    it('produces multiple warnings for multiple unknown keys', () => {
      const colors = validColors()
      ;(colors as Record<string, string>)['foo'] = '#111'
      ;(colors as Record<string, string>)['bar'] = '#222'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
      expect(result.warnings).toHaveLength(2)
    })
  })

  describe('name validation within validateThemePack', () => {
    it('rejects missing name', () => {
      const pack = validPack()
      delete pack.name
      const result = validateThemePack(pack)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('name must be a string')
    })

    it('rejects empty name', () => {
      const result = validateThemePack(validPack({ name: '' }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('name must not be empty')
    })

    it('rejects whitespace-only name', () => {
      const result = validateThemePack(validPack({ name: '   ' }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('name must not be empty')
    })

    it('rejects name exceeding max length', () => {
      const longName = 'a'.repeat(THEME_PACK_LIMITS.MAX_NAME_LENGTH + 1)
      const result = validateThemePack(validPack({ name: longName }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain(
        `name must be at most ${THEME_PACK_LIMITS.MAX_NAME_LENGTH} characters`,
      )
    })

    it('accepts name at exact max length', () => {
      const name = 'a'.repeat(THEME_PACK_LIMITS.MAX_NAME_LENGTH)
      const result = validateThemePack(validPack({ name }))
      expect(result.ok).toBe(true)
    })

    it('rejects non-string name', () => {
      const result = validateThemePack(validPack({ name: 42 }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('name must be a string')
    })
  })

  describe('version validation within validateThemePack', () => {
    it('rejects missing version', () => {
      const pack = validPack()
      delete pack.version
      const result = validateThemePack(pack)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('version must be a string')
    })

    it('rejects invalid semver', () => {
      const result = validateThemePack(validPack({ version: 'v1.0' }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('version must be a valid semver (e.g. 1.0.0)')
    })

    it('rejects non-string version', () => {
      const result = validateThemePack(validPack({ version: 1 }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('version must be a string')
    })
  })

  describe('CSS injection via function colors', () => {
    it('rejects hsl() with embedded closing paren and injected CSS', () => {
      const colors = validColors()
      colors['surface'] = 'hsl(0); --injected: evil)'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Color "surface" has invalid CSS color value: "hsl(0); --injected: evil)"')
    })

    it('rejects rgb() with embedded closing paren', () => {
      const colors = validColors()
      colors['surface'] = 'rgb(0,0,0); pointer-events: none)'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
    })

    it('still accepts valid nested modern CSS color syntax', () => {
      const colors = validColors()
      colors['surface'] = 'hsl(200 50% 50%)'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(true)
    })
  })

  describe('dangerous keys', () => {
    it.each(['constructor', 'prototype'])('rejects dangerous top-level key "%s"', (key) => {
      const pack = validPack()
      ;(pack as Record<string, unknown>)[key] = 'malicious'
      const result = validateThemePack(pack)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain(`Dangerous key "${key}" is not allowed`)
    })

    it('rejects dangerous top-level key "__proto__"', () => {
      const pack = Object.create(null) as Record<string, unknown>
      const base = validPack()
      for (const k of Object.keys(base)) pack[k] = base[k]
      pack['__proto__'] = 'malicious'
      const result = validateThemePack(pack)
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Dangerous key "__proto__" is not allowed')
    })

    it.each(['constructor', 'prototype'])('rejects dangerous key "%s" inside colors', (key) => {
      const colors = validColors()
      ;(colors as Record<string, string>)[key] = '#ff0000'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain(`Dangerous key "colors.${key}" is not allowed`)
    })

    it('rejects dangerous key "__proto__" inside colors', () => {
      const colors = Object.create(null) as Record<string, string>
      for (const [k, v] of Object.entries(validColors())) colors[k] = v
      colors['__proto__'] = '#ff0000'
      const result = validateThemePack(validPack({ colors }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('Dangerous key "colors.__proto__" is not allowed')
    })
  })

  describe('multiple errors', () => {
    it('collects errors from name, version, colorScheme, and colors at once', () => {
      const result = validateThemePack({
        name: '',
        version: 'bad',
        colorScheme: 'neon',
        colors: {},
      })
      expect(result.ok).toBe(false)
      expect(result.errors.length).toBeGreaterThanOrEqual(4)
    })

    it('does not include header when validation fails', () => {
      const result = validateThemePack(validPack({ name: '' }))
      expect(result.ok).toBe(false)
      expect(result.header).toBeUndefined()
    })
  })

  describe('early return when colors is not an object', () => {
    it('returns immediately without checking individual color keys', () => {
      const result = validateThemePack(validPack({ colors: 42 }))
      expect(result.ok).toBe(false)
      expect(result.errors).toContain('colors must be an object')
      expect(result.errors.filter((e) => e.startsWith('Missing required'))).toHaveLength(0)
    })
  })
})

describe('validateName', () => {
  it('returns null for valid name', () => {
    expect(validateName('My Theme')).toBeNull()
  })

  it('returns error for non-string', () => {
    expect(validateName(42)).toBe('name must be a string')
    expect(validateName(null)).toBe('name must be a string')
    expect(validateName(undefined)).toBe('name must be a string')
  })

  it('returns error for empty string', () => {
    expect(validateName('')).toBe('name must not be empty')
  })

  it('returns error for whitespace-only string', () => {
    expect(validateName('   ')).toBe('name must not be empty')
    expect(validateName('\t\n')).toBe('name must not be empty')
  })

  it('returns error when exceeding max length', () => {
    const longName = 'x'.repeat(THEME_PACK_LIMITS.MAX_NAME_LENGTH + 1)
    expect(validateName(longName)).toBe(
      `name must be at most ${THEME_PACK_LIMITS.MAX_NAME_LENGTH} characters`,
    )
  })

  it('returns null at exact max length', () => {
    const name = 'x'.repeat(THEME_PACK_LIMITS.MAX_NAME_LENGTH)
    expect(validateName(name)).toBeNull()
  })
})

describe('validateVersion', () => {
  it('returns null for valid semver', () => {
    expect(validateVersion('1.0.0')).toBeNull()
    expect(validateVersion('0.0.1')).toBeNull()
    expect(validateVersion('12.34.56')).toBeNull()
  })

  it('returns null for semver with pre-release', () => {
    expect(validateVersion('1.0.0-alpha')).toBeNull()
    expect(validateVersion('1.0.0-beta.1')).toBeNull()
    expect(validateVersion('1.0.0-rc.2.3')).toBeNull()
  })

  it('returns error for non-string', () => {
    expect(validateVersion(42)).toBe('version must be a string')
    expect(validateVersion(null)).toBe('version must be a string')
    expect(validateVersion(undefined)).toBe('version must be a string')
  })

  it('returns error for invalid semver format', () => {
    expect(validateVersion('1.0')).toBe('version must be a valid semver (e.g. 1.0.0)')
    expect(validateVersion('v1.0.0')).toBe('version must be a valid semver (e.g. 1.0.0)')
    expect(validateVersion('1')).toBe('version must be a valid semver (e.g. 1.0.0)')
    expect(validateVersion('')).toBe('version must be a valid semver (e.g. 1.0.0)')
    expect(validateVersion('abc')).toBe('version must be a valid semver (e.g. 1.0.0)')
    expect(validateVersion('1.0.0.0')).toBe('version must be a valid semver (e.g. 1.0.0)')
  })
})
