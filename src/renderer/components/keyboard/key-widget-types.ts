// SPDX-License-Identifier: GPL-2.0-or-later

import type { KleKey } from '../../../shared/kle/types'
import type { EffectiveTheme } from '../../hooks/useEffectiveTheme'

export interface Props {
  kleKey: KleKey
  keycode: string
  maskKeycode?: string
  selected?: boolean
  multiSelected?: boolean
  selectedMaskPart?: boolean
  pressed?: boolean
  highlighted?: boolean
  /** True for one beat right after a bulk keymap rewrite (Key Label
   *  "apply to keymap") or an undo/redo lands on this position. Renders an extra overlay
   *  (same fill as `selected`, `KEY_SELECTED_COLOR`) on top of the key's
   *  normal fill so the user can see what changed, then fades via the
   *  declarative `key-flash` CSS keyframe (see `style.css`) once the
   *  caller clears the flag — independent of `selected`/`multiSelected`/
   *  `highlighted`/`everPressed`, which the base fill still resolves on
   *  its own regardless of this flag. */
  flashed?: boolean
  /** Bumped by the caller on every successful apply (`KeyFlashState.generation`
   *  in `KeyboardWidget`). Used as the overlay element's React `key` so a
   *  re-apply mid-flash forces a fresh DOM node — remounting restarts the
   *  CSS animation instead of reusing a node whose animation may already
   *  be sitting at opacity 0 (`animation-fill-mode: forwards`). */
  flashGeneration?: number
  /** `Date.now()` at the apply that produced this flash (`KeyFlashState.startedAt`).
   *  Used to compute a negative `animation-delay` so an overlay that
   *  mounts after the flash already started (e.g. a layer switch reveals
   *  a different rewritten position mid-window) joins the SAME global
   *  fade timeline instead of restarting from full opacity. */
  flashStartedAt?: number
  everPressed?: boolean
  remapped?: boolean
  /** Heatmap fill for the outer rect (or the whole key on non-masked
   * keys). Lives below the pressed / selected / multi / highlighted /
   * everPressed priority levels so the immediate feedback colours are
   * never painted over by the overlay. Null leaves the default key
   * background in place. */
  heatmapOuterFill?: string | null
  /** Heatmap fill for the inner (tap) rect of a masked LT/MT key.
   * Null leaves the default mask-rect colour in place so masked keys
   * still visually announce themselves when there is no tap data
   * yet. Ignored for non-masked keys. */
  heatmapInnerFill?: string | null
  /** Direct background override. Sits below every interactive / heatmap
   * state so "pressed" and friends still win. Used by the Finger
   * Assignment modal to paint keys in their estimated finger colour. */
  customFill?: string | null
  /** Bypasses the global keycode registration when rendering labels.
   *  The Analyze view uses this so snapshots whose LT/LM composites are
   *  not covered by the connected keyboard's current layer count still
   *  get pretty multi-part labels. `masked` also dictates which render
   *  branch (plain vs. tap/hold-split) the widget takes. */
  labelOverride?: { outer: string; inner: string; masked: boolean }
  /** Active Key Label pack's per-key legend override — same source
   *  `KeycodeGrid`/`BasicKeyboardView` already receive (see
   *  `useDevicePrefs`/`useKeyboardLayout`). A masked (composite) key's
   *  inner (tap/base) label falls back to `remap()`'d automatically
   *  upstream via `use-layer-keycodes.ts`'s `keycodes` map for the
   *  composite string as a whole — but a pack practically only ever
   *  remaps the plain inner basic keycode, not the full composite
   *  string, so this is threaded here to resolve that specifically.
   *  Ignored for `labelOverride`/`maskKeycode` callers, which already
   *  bypass keycode-table lookups entirely. */
  remapLabel?: (qmkId: string) => string
  onClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  onHover?: (key: KleKey, keycode: string, rect: DOMRect) => void
  onHoverEnd?: () => void
  hoverMaskParts?: boolean
  /** For a masked key, report hover only while the pointer is over the
   *  outer (hold) part: entering the inner rect calls `onHoverEnd`, and
   *  moving from the inner rect back to the outer part calls `onHover`
   *  again. The thin margin around the inner rect counts as outer.
   *  Independent of `hoverMaskParts`, which only drives the hover fill. */
  hoverOuterPartOnly?: boolean
  selectedFill?: boolean
  scale?: number
  /** Current effective theme. Drives the invert-text decision for
   * light-fill keys (pressed green, heatmap warm end, etc.). Optional
   * so direct KeyWidget callers (KeycodeField, Macro chips) don't have
   * to thread the hook; defaults to 'light' which matches the label
   * default. KeyboardWidget always passes the real value. */
  effectiveTheme?: EffectiveTheme
}
