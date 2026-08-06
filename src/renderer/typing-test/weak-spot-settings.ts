// SPDX-License-Identifier: GPL-2.0-or-later

/** Single per-field spec table for the Weak Spot Settings modal's 8 tunable
 *  fields (`WeakSpotDetailSettings` — see types.ts), plus the defaults +
 *  resolution built on top of it. Mirrors the RomajiSettingsModal layer
 *  split: types.ts owns the field shape, this module owns what "default"
 *  concretely means, what values are selectable, and how a possibly
 *  partial/undefined persisted value resolves into the fully-populated
 *  settings the detection/sampling layers actually consume. Kept out of
 *  weak-spot-scoring.ts / weak-spot-profile.ts /
 *  word-generator/weak-spot-weighting.ts themselves so those stay pure
 *  algorithm modules with no config-shape knowledge of their own — they
 *  only ever see already-resolved numbers, with defaulting/pruning
 *  contained in this one place.
 *
 *  `WEAK_SPOT_FIELD_SPECS` is the ONE enumeration of the 8 fields — every
 *  other per-field concern (the modal's option-button rows, the
 *  persisted-value validator in device-prefs-validate.ts, the
 *  metadata-snapshot sanitizer in typing-test-result-sanitize.ts,
 *  defaults/resolve/prune/normalize below) derives from it rather than
 *  re-listing the 8 names by hand. */

import {
  DEFAULT_MIN_MISS_COUNT, DEFAULT_SLOWNESS_RATIO_THRESHOLD, DEFAULT_STALL_RATE_THRESHOLD,
  DEFAULT_STALL_MULTIPLE, DEFAULT_MIN_TIMING_OBSERVATIONS,
} from './weak-spot-scoring'
import { DEFAULT_WEAK_SPOT_BIAS_RATIO } from './word-generator/weak-spot-weighting'
import type { WeakSpotResolvedSettings } from '../../shared/types/pipette-settings'
import type { WeakSpotDetailSettings, WeakSpotMissWindow, WeakSpotDecayHalfLife } from './types'

/** Every selectable value for the missWindow/decayHalfLifeDays option-button
 *  rows — standalone exports kept for callers (the modal) that only need
 *  one field's option list, not the whole spec table. */
export const WEAK_SPOT_MISS_WINDOW_OPTIONS: readonly WeakSpotMissWindow[] = [10, 25, 50, 100, 'all']
export const WEAK_SPOT_DECAY_HALF_LIFE_OPTIONS: readonly WeakSpotDecayHalfLife[] = ['none', 7, 14, 30]

/** One field's selectable value set + default, plus (for a 0..1 fraction
 *  field) whether it's presented to the user as a whole percent. Options
 *  and `default` are always in the field's ACTUAL persisted/config unit —
 *  `percent: true` only changes how the modal DISPLAYS/collects the value
 *  (× 100 to show, / 100 to write back), never the stored representation,
 *  so validator membership checks (`options.includes(configValue)`) never
 *  have to know about the percent/fraction distinction at all. */
export interface WeakSpotFieldSpec<T extends number | string = number | string> {
  readonly options: readonly T[]
  readonly default: T
  readonly percent?: boolean
}

// The trailing `satisfies Record<keyof WeakSpotResolvedSettings,
// WeakSpotFieldSpec>` is the compile-time guarantee this table is actually
// exhaustive: if a field is ever added to (or removed from)
// `WeakSpotResolvedSettings` without a matching entry here, this object
// literal stops type-checking instead of silently leaving the new field
// undocumented. The per-field `satisfies WeakSpotFieldSpec<...>` casts stay
// too — they narrow each entry's `options`/`default` to that field's own
// value type (e.g. `WeakSpotMissWindow` for `missWindow`), which the
// broader whole-table `satisfies` (using `WeakSpotFieldSpec`'s
// `number | string` default type param) doesn't provide on its own.
export const WEAK_SPOT_FIELD_SPECS = {
  missThreshold: { options: [1, 2, 3, 5, 10], default: DEFAULT_MIN_MISS_COUNT } satisfies WeakSpotFieldSpec<number>,
  slownessRatio: { options: [1.2, 1.5, 2, 2.5, 3], default: DEFAULT_SLOWNESS_RATIO_THRESHOLD } satisfies WeakSpotFieldSpec<number>,
  stallRate: {
    options: [10, 20, 30, 40, 50].map((n) => n / 100), default: DEFAULT_STALL_RATE_THRESHOLD, percent: true,
  } satisfies WeakSpotFieldSpec<number>,
  stallMultiple: { options: [1.5, 2, 2.5, 3, 4], default: DEFAULT_STALL_MULTIPLE } satisfies WeakSpotFieldSpec<number>,
  minTimingSamples: { options: [5, 10, 15, 25, 50], default: DEFAULT_MIN_TIMING_OBSERVATIONS } satisfies WeakSpotFieldSpec<number>,
  missWindow: { options: WEAK_SPOT_MISS_WINDOW_OPTIONS, default: 50 } satisfies WeakSpotFieldSpec<WeakSpotMissWindow>,
  decayHalfLifeDays: { options: WEAK_SPOT_DECAY_HALF_LIFE_OPTIONS, default: 'none' } satisfies WeakSpotFieldSpec<WeakSpotDecayHalfLife>,
  biasRatio: {
    options: [20, 40, 60, 80, 100].map((n) => n / 100), default: DEFAULT_WEAK_SPOT_BIAS_RATIO, percent: true,
  } satisfies WeakSpotFieldSpec<number>,
} as const satisfies Record<keyof WeakSpotResolvedSettings, WeakSpotFieldSpec>

export type WeakSpotFieldKey = keyof typeof WEAK_SPOT_FIELD_SPECS

/** The 8 field names, in the table's own declared order — the single
 *  enumeration every field-list consumer (resolve/prune/sanitize/validate)
 *  iterates instead of hand-spelling all 8 names itself. */
export const WEAK_SPOT_FIELD_KEYS = Object.keys(WEAK_SPOT_FIELD_SPECS) as WeakSpotFieldKey[]

/** The 7 detection-only field names (excludes `biasRatio` — see
 *  `WeakSpotDetectionSettings`'s own doc comment), in the same declared
 *  order as `WEAK_SPOT_FIELD_KEYS` — the single enumeration
 *  `normalizeWeakSpotDetectionSettingsKey` iterates, so a future detection
 *  field automatically enters the cache key without a hand-edited template
 *  literal. */
export const WEAK_SPOT_DETECTION_FIELD_KEYS = WEAK_SPOT_FIELD_KEYS.filter(
  (key): key is Exclude<WeakSpotFieldKey, 'biasRatio'> => key !== 'biasRatio',
)

export const DEFAULT_MISS_WINDOW = WEAK_SPOT_FIELD_SPECS.missWindow.default
export const DEFAULT_DECAY_HALF_LIFE = WEAK_SPOT_FIELD_SPECS.decayHalfLifeDays.default

/** Fully-resolved detection-only settings — excludes `biasRatio`
 *  deliberately (a sampling-side knob that never changes WHICH tokens are
 *  detected as weak, only how heavily biasing favors them once detected;
 *  see weak-spot-profile.ts's cache-key doc comment for why it must stay
 *  out of the memoization key this shape feeds). Every field always
 *  present, unlike the raw possibly-partial `WeakSpotDetailSettings`. */
export type WeakSpotDetectionSettings = Omit<WeakSpotResolvedSettings, 'biasRatio'>

export const DEFAULT_WEAK_SPOT_SETTINGS: WeakSpotResolvedSettings = Object.fromEntries(
  WEAK_SPOT_FIELD_KEYS.map((key) => [key, WEAK_SPOT_FIELD_SPECS[key].default]),
) as unknown as WeakSpotResolvedSettings

const { biasRatio: _defaultBiasRatio, ...DEFAULT_WEAK_SPOT_DETECTION_SETTINGS_VALUE } = DEFAULT_WEAK_SPOT_SETTINGS
export const DEFAULT_WEAK_SPOT_DETECTION_SETTINGS: WeakSpotDetectionSettings = DEFAULT_WEAK_SPOT_DETECTION_SETTINGS_VALUE

/** Resolves a possibly-undefined/possibly-partial persisted
 *  `WeakSpotDetailSettings` into the fully-populated 8-field settings the
 *  modal/sampling/detection layers consume — each field independently
 *  falls back to its own default. Safe to call on an already-validated
 *  config (every present field individually well-formed — see
 *  device-prefs-validate.ts's field-level validation) or on a fresh
 *  in-memory config the modal just produced. The one place every caller
 *  that needs the FULL (detection + bias) resolved shape should go through
 *  — see `resolveWeakSpotDetectionSettings`/`resolveWeakSpotBiasRatio`
 *  below for the two narrower slices most call sites actually need. */
export function resolveWeakSpotSettings(raw: WeakSpotDetailSettings | undefined): WeakSpotResolvedSettings {
  const rawFields = raw as Record<string, unknown> | undefined
  const out: Record<string, unknown> = {}
  for (const key of WEAK_SPOT_FIELD_KEYS) {
    const value = rawFields?.[key]
    out[key] = value ?? WEAK_SPOT_FIELD_SPECS[key].default
  }
  return out as unknown as WeakSpotResolvedSettings
}

/** Resolves the detection-only slice (excludes `biasRatio` — see
 *  `WeakSpotDetectionSettings`'s own doc comment). */
export function resolveWeakSpotDetectionSettings(raw: WeakSpotDetailSettings | undefined): WeakSpotDetectionSettings {
  const { biasRatio: _biasRatio, ...detection } = resolveWeakSpotSettings(raw)
  return detection
}

/** Resolves just the sampling-side bias ratio, independent of detection
 *  settings (see `WeakSpotDetectionSettings`'s own doc comment for why
 *  it's kept out of that shape entirely). */
export function resolveWeakSpotBiasRatio(raw: WeakSpotDetailSettings | undefined): number {
  return resolveWeakSpotSettings(raw).biasRatio
}

/** Stable cache-key fragment for a resolved `WeakSpotDetectionSettings` —
 *  consumed by weak-spot-profile.ts's `MistakeProfileCache` so any
 *  detection-settings change invalidates the memoized profile instead of
 *  silently serving one computed under different parameters. Iterates
 *  `WEAK_SPOT_DETECTION_FIELD_KEYS` (the spec table's own fixed field
 *  order) rather than a hand-spelled positional template literal, so a
 *  future detection field added to the spec table automatically joins the
 *  key instead of requiring a matching manual edit here — worth the small
 *  extra array allocation this runs on every profile lookup, since a
 *  silently-stale cache key (a new field that never invalidates the cache)
 *  is a far worse failure mode than the allocation cost. The same settings
 *  always normalize to the same string regardless of how the object was
 *  constructed. */
export function normalizeWeakSpotDetectionSettingsKey(settings: WeakSpotDetectionSettings): string {
  return WEAK_SPOT_DETECTION_FIELD_KEYS.map((key) => settings[key]).join(',')
}

/** Drops fields set back to their default value, mirroring
 *  RomajiSettingsModal's `pruneRomaji` exactly — a persisted config only
 *  ever carries what the user actually changed from the built-in
 *  defaults. Returns undefined once every field is back at its default
 *  (nothing left worth persisting). */
export function pruneWeakSpotSettings(next: WeakSpotDetailSettings): WeakSpotDetailSettings | undefined {
  const nextFields = next as Record<string, unknown>
  const pruned: Record<string, unknown> = {}
  for (const key of WEAK_SPOT_FIELD_KEYS) {
    const value = nextFields[key]
    if (value !== undefined && value !== WEAK_SPOT_FIELD_SPECS[key].default) pruned[key] = value
  }
  return Object.keys(pruned).length > 0 ? (pruned as WeakSpotDetailSettings) : undefined
}
