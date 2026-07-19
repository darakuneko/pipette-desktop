// SPDX-License-Identifier: GPL-2.0-or-later

/** Total length of the `key-flash` CSS keyframe (style.css): 500ms hold at
 *  full opacity + 200ms fade out. Kept here as the single source of truth
 *  shared by the editor's clear timer, the animation-delay clamp below,
 *  and the keyframe's own percentage stops — all three must stay in sync
 *  with this number. Lives in this neutral module (not KeyWidget) so
 *  editor code doesn't have to depend on a display component just to read
 *  a timing constant. */
export const KEY_FLASH_DURATION_MS = 700

/** Post-rewrite key flash state (Key Label "apply to keymap" bulk
 *  rewrite, and undo/redo). Bundles the flashed positions with the
 *  generation/start-time every `KeyWidget`/`EncoderWidget` overlay needs to
 *  stay synced to the SAME CSS-keyframe timeline (see `KeyWidget`'s
 *  `key-flash-overlay` element) — one prop instead of three loose ones so
 *  it threads cleanly through `KeyboardPane` -> `KeyboardWidget`. */
export interface KeyFlashState {
  /** Key positions to flash, pos-keyed like `highlightedKeys`. */
  keys: Set<string>
  /** Encoder positions to flash, keyed `'idx,dir'` (mirrors `keys`' pos-key
   *  convention for regular keys). */
  encoders: Set<string>
  /** Bumped on every successful apply. Forwarded to `KeyWidget`/`EncoderWidget`
   *  as `flashGeneration` so a re-apply mid-flash remounts (and thus
   *  restarts) the overlay instead of reusing a DOM node whose CSS
   *  animation may already be finished. */
  generation: number
  /** `Date.now()` at the apply that produced this batch. Forwarded to
   *  `KeyWidget`/`EncoderWidget` as `flashStartedAt` so it can compute a
   *  negative `animation-delay` — overlays that mount late (e.g. a layer
   *  switch mid-window) join the same global timeline instead of
   *  restarting the fade from full opacity. */
  startedAt: number
}

/** How far into the shared `key-flash` timeline an overlay starting at
 *  `startedAt` is joining, clamped to `KEY_FLASH_DURATION_MS` so a stale
 *  `startedAt` (e.g. a very late render) never produces a delay larger
 *  than the animation itself. Fed to `animation-delay` as a NEGATIVE
 *  value by callers — that starts the CSS animation already partway
 *  through, so an overlay mounted late shows the correct mid-fade opacity
 *  immediately and finishes at the same wall-clock moment as every other
 *  overlay from this same flash, instead of restarting its own fade from
 *  full opacity. */
export function flashAnimationDelayMs(startedAt: number): number {
  return Math.min(KEY_FLASH_DURATION_MS, Math.max(0, Date.now() - startedAt))
}

/** Resolves the `flashed`/`flashGeneration`/`flashStartedAt` prop triple for
 *  one `KeyWidget`/`EncoderWidget` instance from the shared `flash` state.
 *  Non-members get back `{ flashed: false }` (the other two fields omitted,
 *  i.e. `undefined`) instead of `flash.generation`/`flash.startedAt` passed
 *  through unconditionally — `KeyboardWidget` renders 80+ of these widgets,
 *  and threading the same `generation`/`startedAt` numbers to every one of
 *  them regardless of membership would flip those props undefined<->number
 *  for the WHOLE board every time a flash window opens or closes, busting
 *  `React.memo` on every widget instead of just the flashed ones. */
export function flashPropsFor(
  flash: KeyFlashState | undefined,
  member: 'keys' | 'encoders',
  pos: string,
): { flashed: boolean; flashGeneration?: number; flashStartedAt?: number } {
  if (!flash || !flash[member].has(pos)) return { flashed: false }
  return { flashed: true, flashGeneration: flash.generation, flashStartedAt: flash.startedAt }
}
