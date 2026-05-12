// SPDX-License-Identifier: GPL-2.0-or-later

import { THEME_COLOR_KEYS, THEME_COLOR_SCHEMES, THEME_PACK_LIMITS, type ThemeColorKey } from '../types/theme-store'

const MAX_NAME_LENGTH = THEME_PACK_LIMITS.MAX_NAME_LENGTH
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?$/
const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const CSS_FN_COLOR_REGEX = /^(?:rgb|hsl)a?\(.+\)$/i
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
const REQUIRED_KEYS = new Set<ThemeColorKey>(THEME_COLOR_KEYS)

export interface ValidateThemePackResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  header?: { name: string; version: string }
}

export function validateName(value: unknown): string | null {
  if (typeof value !== 'string') return 'name must be a string'
  const trimmed = value.trim()
  if (!trimmed) return 'name must not be empty'
  if (trimmed.length > MAX_NAME_LENGTH) return `name must be at most ${MAX_NAME_LENGTH} characters`
  return null
}

export function validateVersion(value: unknown): string | null {
  if (typeof value !== 'string') return 'version must be a string'
  if (!SEMVER_REGEX.test(value.trim())) return 'version must be a valid semver (e.g. 1.0.0)'
  return null
}

function isValidCssColor(value: string): boolean {
  return HEX_COLOR_REGEX.test(value) || CSS_FN_COLOR_REGEX.test(value)
}

export function validateThemePack(raw: unknown): ValidateThemePackResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Theme pack must be a JSON object'], warnings }
  }
  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      errors.push(`Dangerous key "${key}" is not allowed`)
    }
  }

  const nameError = validateName(obj.name)
  if (nameError) errors.push(nameError)
  const versionError = validateVersion(obj.version)
  if (versionError) errors.push(versionError)

  if (typeof obj.colorScheme !== 'string' || !THEME_COLOR_SCHEMES.includes(obj.colorScheme as 'light' | 'dark')) {
    errors.push(`colorScheme must be exactly "light" or "dark"`)
  }

  if (!obj.colors || typeof obj.colors !== 'object' || Array.isArray(obj.colors)) {
    errors.push('colors must be an object')
    return { ok: false, errors, warnings }
  }

  const colors = obj.colors as Record<string, unknown>

  for (const key of Object.keys(colors)) {
    if (DANGEROUS_KEYS.has(key)) {
      errors.push(`Dangerous key "colors.${key}" is not allowed`)
    }
  }

  const presentKeys = Object.keys(colors)
  const presentKeySet = new Set(presentKeys)
  for (const required of THEME_COLOR_KEYS) {
    if (!presentKeySet.has(required)) {
      errors.push(`Missing required color: "${required}"`)
    }
  }

  for (const key of presentKeys) {
    if (!REQUIRED_KEYS.has(key as ThemeColorKey)) {
      warnings.push(`Unknown color key "${key}" will be ignored`)
    }
  }

  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      errors.push(`Color "${key}" must be a string`)
      continue
    }
    if (!isValidCssColor(value)) {
      errors.push(`Color "${key}" has invalid CSS color value: "${value}"`)
    }
  }

  const ok = errors.length === 0
  if (!ok) return { ok, errors, warnings }

  return {
    ok,
    errors,
    warnings,
    header: {
      name: (obj.name as string).trim(),
      version: (obj.version as string).trim(),
    },
  }
}

export { THEME_PACK_LIMITS } from '../types/theme-store'
