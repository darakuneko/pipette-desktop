// SPDX-License-Identifier: GPL-2.0-or-later
// The checks the Pipette Hub server makes on what it is sent, with its
// error texts, for the fake Hub of server.ts: the display-name rules and
// the `test:<email>` id_token of the Hub's test mode, and the validators of
// the uploads (language packs, theme packs, key labels, analytics exports,
// the favorite JSON of a feature post). They follow the Hub worker's
// services (i18n-validation, theme-validation, key-label-validation,
// analytics-validation, user-name-policy, test-auth) rule for rule, so the
// fake refuses what the Hub refuses with the same text.

export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const MAX_DISPLAY_NAME_LENGTH = 50
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?$/

export const I18N_MAX_BYTES = 256 * 1024
const I18N_MAX_DEPTH = 8
const I18N_MAX_KEYS = 5000
const I18N_MAX_NAME_LENGTH = 64
const I18N_KEY_SEGMENT_REGEX = /^[\w-]+$/
const I18N_RESERVED_TOP_LEVEL_KEYS = new Set(['name', 'version'])

export const THEME_MAX_BYTES = 64 * 1024
const THEME_MAX_NAME_LENGTH = 64
export const THEME_COLOR_KEYS = [
  'surface', 'surface-alt', 'surface-dim', 'surface-raised',
  'content', 'content-secondary', 'content-muted', 'content-inverse',
  'edge', 'edge-subtle', 'edge-strong',
  'accent', 'accent-hover', 'accent-alt', 'success', 'warning', 'danger', 'pending',
  'key-bg', 'key-bg-hover', 'key-bg-active', 'key-border', 'key-shadow',
  'key-label', 'key-sublabel', 'key-label-remap', 'key-bg-multi-selected',
  'tab-bg-active', 'tab-text', 'tab-text-active',
  'picker-bg', 'picker-item-bg', 'picker-item-hover', 'picker-item-text', 'picker-item-border',
] as const
export const THEME_PREVIEW_KEYS = ['surface', 'content', 'accent', 'key-bg', 'key-label', 'success', 'danger'] as const
const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const CSS_FN_COLOR_REGEX = /^(?:rgb|hsl)a?\([\d\s,./%+-]+\)$/i

const MAX_KEY_LABEL_NAME_LENGTH = 100
const MAX_KEY_LABEL_VALUE_LENGTH = 50
const MAX_KEY_LABEL_MAP_ENTRIES = 500
const KEYCODE_NAME_RE = /^(?:0x[0-9a-fA-F]+|[A-Z][A-Z0-9_]*(?:\([^()]*\))?)$/

const ANALYTICS_MIN_KEYSTROKES = 100
const ANALYTICS_MAX_RANGE_MS = 30 * 86_400_000
const ANALYTICS_ARRAY_FIELDS = [
  'minuteStats', 'matrixCells', 'matrixCellsByDay', 'layerUsage', 'sessions',
  'bksMinute', 'bigramTop', 'bigramSlow', 'appUsage', 'wpmByApp',
] as const

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function invalid<T>(reason: string): Checked<T> {
  return { ok: false, error: `INVALID_PAYLOAD: ${reason}` }
}

// --- Accounts ------------------------------------------------------------------

/** Trimmed, cut to 50 code points; null when empty. */
export function normalizeDisplayName(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return Array.from(trimmed).slice(0, MAX_DISPLAY_NAME_LENGTH).join('')
}

const RESERVED_PREFIXES = ['pipette', 'darakuneko']
const RESERVED_EXACT = ['admin', 'administrator', 'root', 'owner', 'moderator', 'mod', 'official', 'staff', 'support', 'system']
// Zero-width and bidi formatting characters.
const ZERO_WIDTH_PATTERN = /[​-‏‪-‮⁠-⁤﻿]/g

export function isReservedDisplayName(name: string): boolean {
  const normalized = name.normalize('NFKC').replace(ZERO_WIDTH_PATTERN, '').trim().toLowerCase()
  if (normalized === '') return false
  if (RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true
  return RESERVED_EXACT.includes(normalized)
}

/** What the Hub reads from a verified id_token. */
export interface IdTokenIdentity {
  email: string
  /** The Google profile name; the display name a new account gets. */
  name: string | undefined
}

/** A `test:<email>` id_token of the Hub's test mode: one `@`, a domain of
 *  example.com or one ending in `.test`, a local part that is not a
 *  reserved name. The display name is the local part. */
export function parseTestIdToken(idToken: string): IdTokenIdentity | null {
  if (!idToken.startsWith('test:')) return null
  const raw = idToken.slice('test:'.length)
  if (raw.split('@').length !== 2) return null
  const email = raw.toLowerCase()
  const [localPart, domain] = email.split('@') as [string, string]
  if (localPart.length === 0 || domain.length === 0) return null
  if (domain !== 'example.com' && !domain.endsWith('.test')) return null
  if (isReservedDisplayName(localPart)) return null
  return { email, name: localPart }
}

/** Any other id_token: a JWT whose payload has an email. The signature is
 *  not checked, so the id_token of the fake Google token endpoint (and of
 *  the Rust in-memory one) signs in. */
export function parseUnverifiedJwt(idToken: string): IdTokenIdentity | null {
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(payload) || typeof payload.email !== 'string' || payload.email.length === 0) return null
  return { email: payload.email, name: typeof payload.name === 'string' ? payload.name : undefined }
}

// --- Language packs ------------------------------------------------------------

function walkTranslations(node: unknown, path: string[], depth: number, keyCount: { value: number }): string | null {
  if (depth > I18N_MAX_DEPTH) return `tree exceeds depth ${I18N_MAX_DEPTH} at "${path.join('.')}"`
  if (typeof node === 'string') return null
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] !== 'string') return `array element at "${path.join('.')}[${i}]" must be a string`
    }
    return null
  }
  if (!isObject(node)) return `leaf at "${path.join('.')}" must be a string`
  for (const [key, value] of Object.entries(node)) {
    if (DANGEROUS_KEYS.has(key)) return `forbidden key: ${key}`
    if (!I18N_KEY_SEGMENT_REGEX.test(key)) return `invalid key segment "${key}"`
    keyCount.value += 1
    if (keyCount.value > I18N_MAX_KEYS) return `pack exceeds ${I18N_MAX_KEYS} keys`
    const err = walkTranslations(value, [...path, key], depth + 1, keyCount)
    if (err) return err
  }
  return null
}

/** The `{version: 1, kind: 'i18n', exportedAt, pack}` export of a language
 *  pack; its trimmed name and version. */
export function parseI18nExport(raw: string): Checked<{ name: string; version: string }> {
  if (raw.length > I18N_MAX_BYTES) return invalid(`pack exceeds ${I18N_MAX_BYTES} bytes`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalid('invalid JSON')
  }
  if (!isObject(parsed)) return invalid('payload must be an object')
  if (parsed.version !== 1) return invalid('unsupported version')
  if (parsed.kind !== 'i18n') return invalid('kind mismatch')
  if (typeof parsed.exportedAt !== 'string' || parsed.exportedAt.length === 0) {
    return invalid('exportedAt must be a non-empty string')
  }
  const pack = parsed.pack
  if (!isObject(pack)) return invalid('pack must be an object')
  if (typeof pack.name !== 'string' || pack.name.trim().length === 0) return invalid('pack.name must be a non-empty string')
  if (pack.name.length > I18N_MAX_NAME_LENGTH) return invalid(`pack.name must be <= ${I18N_MAX_NAME_LENGTH} characters`)
  if (typeof pack.version !== 'string' || !SEMVER_REGEX.test(pack.version.trim())) {
    return invalid('pack.version must be valid semver (e.g. 0.1.0)')
  }
  const translations: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(pack)) {
    if (!I18N_RESERVED_TOP_LEVEL_KEYS.has(key)) translations[key] = value
  }
  const treeErr = walkTranslations(translations, [], 0, { value: 0 })
  if (treeErr) return invalid(treeErr)
  return { ok: true, value: { name: pack.name.trim(), version: pack.version.trim() } }
}

// --- Theme packs ---------------------------------------------------------------

/** A theme pack body `{name, version, colorScheme, colors}`; its trimmed
 *  name and version. */
export function parseThemePack(raw: string): Checked<{ name: string; version: string }> {
  if (raw.length > THEME_MAX_BYTES) return invalid(`pack exceeds ${THEME_MAX_BYTES} bytes`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalid('invalid JSON')
  }
  if (!isObject(parsed)) return invalid('payload must be an object')
  for (const key of Object.keys(parsed)) {
    if (DANGEROUS_KEYS.has(key)) return invalid(`forbidden key: ${key}`)
  }
  if (typeof parsed.name !== 'string' || parsed.name.trim().length === 0) return invalid('name must be a non-empty string')
  if (parsed.name.length > THEME_MAX_NAME_LENGTH) return invalid(`name must be <= ${THEME_MAX_NAME_LENGTH} characters`)
  if (typeof parsed.version !== 'string' || !SEMVER_REGEX.test(parsed.version.trim())) {
    return invalid('version must be valid semver (e.g. 1.0.0)')
  }
  const colors = parsed.colors
  if (!isObject(colors)) return invalid('colors must be an object')
  for (const key of Object.keys(colors)) {
    if (DANGEROUS_KEYS.has(key)) return invalid(`forbidden key in colors: ${key}`)
  }
  for (const required of THEME_COLOR_KEYS) {
    if (!(required in colors)) return invalid(`missing required color: "${required}"`)
  }
  if (parsed.colorScheme !== 'light' && parsed.colorScheme !== 'dark') return invalid('colorScheme must be "light" or "dark"')
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key]
    if (typeof value !== 'string') return invalid(`color "${key}" must be a string`)
    if (!HEX_COLOR_REGEX.test(value) && !CSS_FN_COLOR_REGEX.test(value)) return invalid(`color "${key}" has invalid CSS color value`)
  }
  return { ok: true, value: { name: parsed.name.trim(), version: parsed.version.trim() } }
}

// --- Key labels ----------------------------------------------------------------

export interface ParsedKeyLabel {
  name: string
  map: Record<string, string>
  compositeLabels: Record<string, string> | null
  /** Undefined when the field is absent: an update keeps the stored value. */
  keymapApplicable: boolean | undefined
}

function validateLabelMap(raw: unknown, field: string, required: boolean): Checked<Record<string, string> | null> {
  if (raw == null) return { ok: true, value: required ? {} : null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${field} must be an object` }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_KEY_LABEL_MAP_ENTRIES) return { ok: false, error: `${field} exceeds ${MAX_KEY_LABEL_MAP_ENTRIES} entries` }
  const result: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!KEYCODE_NAME_RE.test(key)) return { ok: false, error: `${field} key "${key}" is not a valid keycode name` }
    if (typeof value !== 'string') return { ok: false, error: `${field} value for "${key}" must be a string` }
    if (value.length > MAX_KEY_LABEL_VALUE_LENGTH) {
      return { ok: false, error: `${field} value for "${key}" exceeds ${MAX_KEY_LABEL_VALUE_LENGTH} characters` }
    }
    result[key] = value
  }
  return { ok: true, value: result }
}

export function validateKeyLabelPayload(body: unknown): Checked<ParsedKeyLabel> {
  if (!isObject(body)) return { ok: false, error: 'Request body must be a JSON object' }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { ok: false, error: 'name is required' }
  if (name.length > MAX_KEY_LABEL_NAME_LENGTH) return { ok: false, error: `name must be ${MAX_KEY_LABEL_NAME_LENGTH} characters or less` }
  const map = validateLabelMap(body.map, 'map', true)
  if (!map.ok) return map
  const composite = validateLabelMap(body.composite_labels, 'composite_labels', false)
  if (!composite.ok) return composite
  const applicable = body.keymap_applicable
  if (applicable !== undefined && typeof applicable !== 'boolean') return { ok: false, error: 'keymap_applicable must be a boolean' }
  return { ok: true, value: { name, map: map.value ?? {}, compositeLabels: composite.value, keymapApplicable: applicable } }
}

// --- Analytics exports ---------------------------------------------------------

/** The index fields of an analytics post. */
export interface AnalyticsIndex {
  productName: string
  keyboardUid: string
  totalKeystrokes: number
  rangeFromMs: number
  rangeToMs: number
}

function analyticsDataError(value: unknown, path: string): string | null {
  if (!isObject(value)) return `${path} must be an object`
  for (const field of ANALYTICS_ARRAY_FIELDS) {
    if (!Array.isArray(value[field])) return `${path}.${field} must be array`
  }
  if (!isObject(value.peakRecords)) return `${path}.peakRecords must be an object`
  if (value.layoutComparison !== null && !isObject(value.layoutComparison)) return `${path}.layoutComparison must be an object or null`
  return null
}

function snapshotError(snapshot: unknown): string | null {
  if (!isObject(snapshot)) return 'snapshot must be an object'
  const keyboard = snapshot.keyboard
  if (!isObject(keyboard)) return 'snapshot.keyboard must be an object'
  if (typeof keyboard.uid !== 'string' || keyboard.uid.length === 0) return 'snapshot.keyboard.uid must be a non-empty string'
  if (typeof keyboard.productName !== 'string') return 'snapshot.keyboard.productName must be a string'
  const range = snapshot.range
  if (!isObject(range)) return 'snapshot.range must be an object'
  if (!isFiniteNumber(range.fromMs) || !isFiniteNumber(range.toMs)) return 'snapshot.range.fromMs/toMs must be numbers'
  if (range.toMs < range.fromMs) return 'snapshot.range.toMs must be >= fromMs'
  if (range.toMs - range.fromMs > ANALYTICS_MAX_RANGE_MS) return 'range exceeds 30 days'
  if (!isFiniteNumber(snapshot.totalKeystrokes)) return 'snapshot.totalKeystrokes must be a number'
  if (snapshot.totalKeystrokes < ANALYTICS_MIN_KEYSTROKES) return 'keystrokes below threshold'
  if (!isObject(snapshot.keymapSnapshot)) return 'snapshot.keymapSnapshot must be an object'
  if (!Array.isArray(snapshot.appScopes)) return 'snapshot.appScopes must be array'
  return null
}

export function parseAnalyticsExport(raw: string): Checked<AnalyticsIndex> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalid('invalid JSON')
  }
  if (!isObject(parsed)) return invalid('payload must be an object')
  if (parsed.version !== 1) return invalid('unsupported version')
  if (parsed.kind !== 'analytics') return invalid('kind mismatch')
  if (typeof parsed.exportedAt !== 'string' || parsed.exportedAt.length === 0) return invalid('exportedAt must be a non-empty string')
  const snapErr = snapshotError(parsed.snapshot)
  if (snapErr) return invalid(snapErr)
  if (!isObject(parsed.filters)) return invalid('filters must be an object')
  const dataErr = analyticsDataError(parsed.data, 'data')
  if (dataErr) return invalid(dataErr)
  if (parsed.appData !== undefined) {
    if (!isObject(parsed.appData)) return invalid('appData must be an object')
    for (const [appName, slice] of Object.entries(parsed.appData)) {
      if (DANGEROUS_KEYS.has(appName)) return invalid(`forbidden key in appData: ${appName}`)
      const appErr = analyticsDataError(slice, `appData["${appName}"]`)
      if (appErr) return invalid(appErr)
    }
  }
  const snapshot = parsed.snapshot as { keyboard: { uid: string; productName: string }; range: { fromMs: number; toMs: number }; totalKeystrokes: number }
  return {
    ok: true,
    value: {
      productName: snapshot.keyboard.productName,
      keyboardUid: snapshot.keyboard.uid,
      totalKeystrokes: snapshot.totalKeystrokes,
      rangeFromMs: snapshot.range.fromMs,
      rangeToMs: snapshot.range.toMs,
    },
  }
}

// --- Feature (favorite) posts --------------------------------------------------

const FEATURE_JSON_INSPECT_LIMIT = 1024 * 1024

/** A favorite export of version 3 needs a non-negative integer
 *  `vial_protocol`; anything the Hub cannot read as JSON passes. */
export function featureJsonError(bytes: Buffer): string | null {
  if (bytes.length > FEATURE_JSON_INSPECT_LIMIT) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(parsed) || parsed.version !== 3) return null
  const protocol = parsed.vial_protocol
  return typeof protocol === 'number' && Number.isInteger(protocol) && protocol >= 0
    ? null
    : 'vial_protocol is required for FavoriteExportFile v3'
}

/** `expires_in_days` of a private upload: absent or empty is 180 days,
 *  otherwise a plain digit string from 1 to 180. */
export function parseExpiresInDays(raw: unknown): Checked<number> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 180 }
  const rangeError = { ok: false as const, error: 'expires_in_days must be an integer between 1 and 180' }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return rangeError
  const days = Number(raw.trim())
  return Number.isInteger(days) && days >= 1 && days <= 180 ? { ok: true, value: days } : rangeError
}
