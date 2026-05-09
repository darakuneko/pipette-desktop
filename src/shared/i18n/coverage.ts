// SPDX-License-Identifier: GPL-2.0-or-later
//
// Coverage helpers for i18n language packs. `flattenTranslations`
// walks a nested JSON object and emits a flat `path.to.key -> value`
// map; `computeCoverage` compares two such maps to surface missing /
// excess keys against the bundled English baseline.

import { DANGEROUS_KEYS } from './validate'

const RESERVED_TOP_LEVEL_KEYS = new Set(['name', 'version'])

export interface CoverageResult {
  totalKeys: number
  coveredKeys: number
  missingKeys: string[]
  excessKeys: string[]
  /** 0..1 — coveredKeys / totalKeys. Returns 1 when both sides are empty. */
  coverageRatio: number
}

export interface FlattenOptions {
  separator?: string
  maxDepth?: number
}

/** Walks `obj` recursively and yields a flat key map. Reserved
 * top-level keys (`name`, `version`) are dropped at the
 * root so meta does not pollute the translation namespace. Dangerous
 * prototype keys are skipped so flattening is safe even if validation
 * has been bypassed. */
export function flattenTranslations(
  obj: unknown,
  options: FlattenOptions = {},
): Record<string, string> {
  const separator = options.separator ?? '.'
  const maxDepth = options.maxDepth ?? 16
  const out: Record<string, string> = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out

  function visit(node: unknown, path: string[], depth: number): void {
    if (depth > maxDepth) return
    if (typeof node === 'string') {
      out[path.join(separator)] = node
      return
    }
    // Array leaves (e.g. consent bullet lists) collapse to a single
    // joined string keyed by the parent path so coverage matches the
    // pack structure even when the leaf is a list.
    if (Array.isArray(node)) {
      out[path.join(separator)] = node.filter((v) => typeof v === 'string').join('\n')
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (DANGEROUS_KEYS.has(k)) continue
      if (depth === 0 && RESERVED_TOP_LEVEL_KEYS.has(k)) continue
      visit(v, [...path, k], depth + 1)
    }
  }
  visit(obj, [], 0)
  return out
}

/** Compute coverage of `pack` against `base`. Both inputs are full
 * pack bodies (with reserved meta keys at the top level). Reserved
 * keys are stripped during flattening so they do not skew the ratio.
 *
 * `missingKeys` is sorted for stable rendering in the UI and capped at
 * `sampleLimit` to keep the IPC payload bounded — if more keys are
 * missing the count is still accurate but the list itself is
 * truncated. */
export function computeCoverage(
  pack: unknown,
  base: unknown,
  options: { sampleLimit?: number; flatten?: FlattenOptions } = {},
): CoverageResult {
  const sampleLimit = options.sampleLimit ?? 200
  const baseFlat = flattenTranslations(base, options.flatten)
  const packFlat = flattenTranslations(pack, options.flatten)

  const baseKeys = Object.keys(baseFlat)
  const packKeys = new Set(Object.keys(packFlat))

  const missing: string[] = []
  let covered = 0
  for (const key of baseKeys) {
    if (packKeys.has(key)) {
      covered += 1
    } else {
      missing.push(key)
    }
  }

  const excess = Object.keys(packFlat)
    .filter((k) => !(k in baseFlat))
    .sort()

  missing.sort()

  const totalKeys = baseKeys.length
  const coverageRatio = totalKeys === 0 ? 1 : covered / totalKeys

  return {
    totalKeys,
    coveredKeys: covered,
    missingKeys: missing.slice(0, sampleLimit),
    excessKeys: excess.slice(0, sampleLimit),
    coverageRatio,
  }
}

/** Build a nested JSON subset of `base` containing only the keys in
 * `keyPaths` (dot-separated). Used to export a "missing keys" template
 * the user can edit and re-import. Reserved meta keys (`name`,
 * `version`) and `DANGEROUS_KEYS` are dropped from the output. */
export function buildSubsetFromKeys(
  base: unknown,
  keyPaths: readonly string[],
  separator = '.',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!base || typeof base !== 'object' || Array.isArray(base)) return out
  for (const path of keyPaths) {
    const segments = path.split(separator)
    if (segments.length === 0) continue
    // Reserved meta keys (name / version) only collide at the root —
    // a nested `i18n.preview.version` is a real translation key.
    if (RESERVED_TOP_LEVEL_KEYS.has(segments[0])) continue
    if (segments.some((s) => DANGEROUS_KEYS.has(s))) continue
    let srcNode: unknown = base
    for (const seg of segments) {
      if (!srcNode || typeof srcNode !== 'object' || Array.isArray(srcNode)) {
        srcNode = undefined
        break
      }
      srcNode = (srcNode as Record<string, unknown>)[seg]
    }
    if (srcNode === undefined) continue
    let dstNode = out
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]
      const existing = dstNode[seg]
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        const next: Record<string, unknown> = {}
        dstNode[seg] = next
        dstNode = next
      } else {
        dstNode = existing as Record<string, unknown>
      }
    }
    dstNode[segments[segments.length - 1]] = srcNode
  }
  return out
}

/** Strip the meta keys from a pack body, returning only the
 * translation tree. Used by the renderer before calling
 * `i18next.addResourceBundle`. */
export function stripMetaKeys(pack: unknown): Record<string, unknown> {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(pack as Record<string, unknown>)) {
    if (RESERVED_TOP_LEVEL_KEYS.has(k)) continue
    if (DANGEROUS_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}
