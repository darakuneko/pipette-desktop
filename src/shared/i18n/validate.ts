// SPDX-License-Identifier: GPL-2.0-or-later
//
// Pure-function validators for i18n language pack JSON. The same
// rules are applied on both Desktop (during import) and Hub Worker
// (when accepting an upload) so a malformed pack cannot persist
// past either gate. The module deliberately has no Electron / Node
// dependency so it can be ported into pipette-hub verbatim.

const MAX_FILE_SIZE_BYTES = 256 * 1024
const MAX_DEPTH = 8
const MAX_KEYS = 5000
const MAX_NAME_LENGTH = 64
const KEY_SEGMENT_REGEX = /^[\w\-]+$/
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?$/
/** Object keys that JS engines treat as prototype-pollution vectors.
 * Exported so coverage.ts (and any future helper) can re-use the same
 * deny-list rather than duplicating the literal. */
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export interface ValidatePackOptions {
  /** Reserved for future overrides; size enforcement now happens
   * server-side only so a small Desktop-side payload is never blocked
   * by an upstream limit change. */
  maxFileSizeBytes?: number
}

export interface ValidatePackResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  dangerousKeys: string[]
  /** When the input is a valid pack header, the canonical form is exposed
   * so callers can persist consistent meta without re-parsing. */
  header?: { name: string; version: string }
}

/** Returns the byte length of `pack` when re-serialised. Callers that
 * already have a string body should use Buffer.byteLength on the body
 * directly rather than calling this helper twice. */
export function packBodyByteLength(pack: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(pack), 'utf-8')
  } catch {
    // Cyclic / non-serialisable — surface as oversized so the caller
    // hits the size error path with a sane value.
    return Number.POSITIVE_INFINITY
  }
}

export function validateName(value: unknown): string | null {
  if (typeof value !== 'string') return 'name must be a string'
  const trimmed = value.trim()
  if (!trimmed) return 'name must not be empty'
  if (trimmed.length > MAX_NAME_LENGTH) return `name must be at most ${String(MAX_NAME_LENGTH)} characters`
  return null
}

export function validateVersion(value: unknown): string | null {
  if (typeof value !== 'string') return 'version must be a string'
  if (!SEMVER_REGEX.test(value.trim())) return 'version must be a valid semver (e.g. 0.1.0)'
  return null
}

/** Walk the translations tree, validating depth, key shape, leaf
 * type, and prototype-pollution-prone keys. Mutates the supplied
 * accumulators in place so the caller can report a single rolled-up
 * pass / fail. */
function walk(
  node: unknown,
  path: string[],
  acc: { errors: string[]; dangerousKeys: string[]; keyCount: { value: number } },
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    acc.errors.push(`Translation tree exceeds depth ${String(MAX_DEPTH)} at "${path.join('.')}"`)
    return
  }
  if (node === null || typeof node !== 'object') {
    if (typeof node === 'string') return
    acc.errors.push(`Leaf at "${path.join('.')}" must be a string (got ${typeof node})`)
    return
  }
  // Arrays of strings are a valid i18next leaf shape (used for bullet
  // lists like editor.typingTest.consent.collectedItems). Walk each
  // element so a non-string entry still surfaces as an error.
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const child = node[i]
      if (typeof child !== 'string') {
        acc.errors.push(`Array element at "${path.join('.')}[${String(i)}]" must be a string`)
      }
    }
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (DANGEROUS_KEYS.has(key)) {
      acc.dangerousKeys.push([...path, key].join('.'))
      continue
    }
    if (!KEY_SEGMENT_REGEX.test(key)) {
      acc.errors.push(`Invalid key segment "${key}" at "${path.join('.')}"`)
      continue
    }
    acc.keyCount.value += 1
    if (acc.keyCount.value > MAX_KEYS) {
      // Bail out early — the final error message is added once after the walk.
      return
    }
    walk(value, [...path, key], acc, depth + 1)
  }
}

const RESERVED_TOP_LEVEL_KEYS = new Set(['name', 'version'])

/** Validate a parsed pack body. The body is the JSON object the user
 * imported (or a Hub post body) — it carries `name`, `version`,
 * plus the nested translation tree at the top
 * level. */
export function validatePack(raw: unknown, _options: ValidatePackOptions = {}): ValidatePackResult {
  const errors: string[] = []
  const warnings: string[] = []
  const dangerousKeys: string[] = []

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Pack must be a JSON object'], warnings, dangerousKeys }
  }
  const obj = raw as Record<string, unknown>

  const nameError = validateName(obj.name)
  if (nameError) errors.push(nameError)
  const versionError = validateVersion(obj.version)
  if (versionError) errors.push(versionError)

  // Walk only the translation portion (skip reserved keys).
  const translations: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (RESERVED_TOP_LEVEL_KEYS.has(k)) continue
    translations[k] = v
  }
  const acc = { errors, dangerousKeys, keyCount: { value: 0 } }
  walk(translations, [], acc, 0)
  if (acc.keyCount.value > MAX_KEYS) {
    errors.push(`Pack exceeds ${String(MAX_KEYS)} keys`)
  }
  if (Object.keys(translations).length === 0) {
    warnings.push('Pack contains no translations beyond the metadata fields')
  }

  const ok = errors.length === 0 && dangerousKeys.length === 0
  if (!ok) {
    return { ok, errors, warnings, dangerousKeys }
  }
  const name = (obj.name as string).trim()
  const version = (obj.version as string).trim()
  return {
    ok,
    errors,
    warnings,
    dangerousKeys,
    header: { name, version },
  }
}

export const I18N_PACK_LIMITS = {
  MAX_FILE_SIZE_BYTES,
  MAX_DEPTH,
  MAX_KEYS,
  MAX_NAME_LENGTH,
  KEY_SEGMENT_REGEX,
  SEMVER_REGEX,
} as const
