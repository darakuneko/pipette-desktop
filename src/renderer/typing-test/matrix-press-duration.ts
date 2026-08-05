// SPDX-License-Identifier: GPL-2.0-or-later

/** Per-key press-duration + physical-overlap tracking for matrix analytics.
 *  Split out of useTypingTest.ts to keep it under the project's 600-line
 *  custom-hook size ceiling — this owns state the queue-based tap/hold classifier
 *  (matrix-analytics-queue.ts) doesn't need: how long every physical
 *  press (masked or not) stays down, and whether consecutive presses
 *  physically overlapped. Both are read straight off the `pressed` set
 *  processMatrixFrame already computes each frame — no new HID protocol,
 *  just carrying data through that used to be discarded on release.
 *
 *  ## Overlap
 *  Binary only: whether the immediately preceding press-edge key was
 *  still in the current frame's `pressed` set when the new key's press
 *  edge was observed. This says nothing about *how much* the two presses
 *  overlapped in time — sub-poll-interval timing isn't available from the
 *  HID layer, so no attempt is made to estimate it (see
 *  Plan-typing-metrics-chi2018.md "制約 2").
 *
 *  ## Observation holes
 *  The renderer polls on a ~20ms cadence, but a HID read can block behind
 *  other queued requests on the shared mutex (`hid-service.ts`) or simply
 *  time out, opening a gap of unknown length with zero visibility into
 *  what happened during it. A key could have been released and
 *  re-pressed inside that gap without either edge ever reaching this
 *  tracker. Treating the frame right after such a gap as an ordinary
 *  frame would let a stale "previous press" pollute the next overlap
 *  determination, and would let a press that started before the gap
 *  report a duration that silently includes unobserved time. Both are
 *  refused instead: see {@link PressDurationTracker.onFrame} and
 *  {@link PressDurationTracker.resolveRelease}. */

import type { TypingAnalyticsEventPayload } from '../../shared/types/typing-analytics'
import { OBSERVATION_HOLE_MS } from '../../shared/typing-analytics-timing'
import type { PressStartRecord } from './matrix-layers'

// Re-exported so existing imports (this module used to define the
// constant itself) keep working — main's validator imports the same
// constant directly from shared/typing-analytics-timing.ts.
export { OBSERVATION_HOLE_MS }

interface PressRecord<TPreparedEvent> {
  tsMs: number
  row: number
  col: number
  layer: number
  keycode: number
  prepared: TPreparedEvent
}

/** Input to {@link PressDurationTracker.registerPress}, bundled into one
 * object rather than positional params: `start`'s row/col/layer/keycode
 * are all bare numbers, and passing them positionally alongside `key`
 * and `ts` invites a silent transposition (e.g. col and layer swapped)
 * that nothing would catch until the data looked wrong in Analyze.
 * `start` mirrors {@link PressStartRecord} from matrix-layers.ts (the
 * equivalent record the tap-hold queue keeps) rather than inventing a
 * parallel shape. */
export interface RegisterPressInput<TPreparedEvent> {
  key: string
  start: PressStartRecord
  prepared: TPreparedEvent
  pressed: ReadonlySet<string>
  frame: FrameObservation
}

/** Result of {@link PressDurationTracker.onFrame} — read once at the top
 * of processMatrixFrame and passed to every {@link PressDurationTracker.registerPress}
 * call for that same frame. */
export interface FrameObservation {
  /** True when this frame's ts followed a gap larger than
   * OBSERVATION_HOLE_MS since the previous frame, OR the gap was
   * negative (the clock stepped backwards — e.g. an NTP correction or a
   * suspend/resume with a skewed monotonic source). A backwards step is
   * just as much an observation discontinuity as a forward one: it means
   * `ts` ordering between this frame and the last one can't be trusted,
   * so there is equally no way to vouch for what happened in between.
   * Every press edge processed in this frame must treat overlap as
   * unknown and must not receive a pollGapMs sample. */
  isHole: boolean
  /** ts - previous frame's ts. Only meaningful (and only ever consumed
   * by {@link PressDurationTracker.registerPress}) when `!isHole`; null
   * on a hole frame (a hole is a break in sampling, not a sample of the
   * sampling period — see onFrame), when there is no previous frame yet,
   * or once a press edge this same frame has already claimed it —
   * registerPress nulls it out after reading it so a chord's later keys
   * don't also report the same sample (see registerPress). */
  gapMs: number | null
}

/** What to emit for a resolved release, or null when nothing should be
 * emitted — either the key was never tracked (its press was rejected by
 * onPrepareAnalyticsEvent, so it never entered the map) or its press
 * predates the last observed hole and the resulting duration would
 * include unobserved time (see the class doc comment). */
export interface ResolvedRelease<TPreparedEvent> {
  prepared: TPreparedEvent
  event: TypingAnalyticsEventPayload & { kind: 'matrix-release' }
}

export class PressDurationTracker<TPreparedEvent> {
  private readonly presses = new Map<string, PressRecord<TPreparedEvent>>()
  private prevFrameTs: number | null = null
  private lastHoleTs: number | null = null
  /** The most recent press-edge key, or null when there is none to
   * reference — either nothing has been pressed yet, or a hole was just
   * observed (see {@link onFrame}: a hole clears this immediately, which
   * is equivalent to invalidating it as an overlap reference without
   * needing to separately track and compare its own timestamp against
   * `lastHoleTs`). */
  private lastPressKey: string | null = null

  /** Call once per processMatrixFrame invocation, before handling any
   * press edges in that frame, with the frame's own timestamp. Updates
   * the rolling previous-frame ts and records a new hole boundary when
   * the gap since the last frame is too large OR negative (see
   * {@link FrameObservation.isHole}). */
  onFrame(ts: number): FrameObservation {
    const prev = this.prevFrameTs
    this.prevFrameTs = ts
    if (prev === null) return { isHole: false, gapMs: null }
    const gapMs = ts - prev
    if (gapMs > OBSERVATION_HOLE_MS || gapMs < 0) {
      this.lastHoleTs = ts
      // The previous reference press may have been released and
      // re-pressed inside the gap we just observed — its "still held"
      // status can no longer be trusted, so drop it as a reference
      // rather than let a later press compare against it.
      this.lastPressKey = null
      // A hole is a break in sampling, not a sample of the sampling
      // period — the raw (possibly negative or absurdly large) gap must
      // never reach pollGapMs, so it's nulled here rather than left for
      // registerPress's `!frame.isHole` guard to filter out.
      return { isHole: true, gapMs: null }
    }
    return { isHole: false, gapMs }
  }

  /** Register a NEW press edge (must be called once per press edge, in
   * press order within the frame — it both reads and advances the
   * "most recent press" pointer, so a chord's second and third keys see
   * the first, still-held key as their overlap reference). Records the
   * press for later {@link resolveRelease} and returns the overlap /
   * pollGapMs values to attach to the outgoing `matrix` event. */
  registerPress(input: RegisterPressInput<TPreparedEvent>): { overlap: boolean | undefined; pollGapMs: number | undefined } {
    const { key, start, prepared, pressed, frame } = input
    const overlap = this.overlapFor(key, pressed, frame)
    let pollGapMs: number | undefined
    if (!frame.isHole && frame.gapMs !== null) {
      pollGapMs = frame.gapMs
      // Claim it on the frame itself so a later press this same frame
      // (a chord) doesn't also report it.
      frame.gapMs = null
    }
    this.presses.set(key, { tsMs: start.tsMs, row: start.row, col: start.col, layer: start.layer, keycode: start.keycode, prepared })
    return { overlap, pollGapMs }
  }

  private overlapFor(key: string, pressed: ReadonlySet<string>, frame: FrameObservation): boolean | undefined {
    const overlap = frame.isHole || this.lastPressKey === null ? undefined : pressed.has(this.lastPressKey)
    this.lastPressKey = key
    return overlap
  }

  /** Resolve a release edge against its press record. Returns the event
   * to emit, or null when nothing should ship (untracked key, or a
   * duration that would span an observation hole — see the class doc
   * comment). Always removes the press record either way. */
  resolveRelease(key: string, ts: number): ResolvedRelease<TPreparedEvent> | null {
    const press = this.presses.get(key)
    this.presses.delete(key)
    if (!press) return null
    if (this.lastHoleTs !== null && press.tsMs < this.lastHoleTs) {
      // A hole opened sometime between this press and now — the key may
      // have been released and re-pressed inside it, so the observed
      // duration would silently include time nobody actually watched.
      return null
    }
    const durationMs = ts - press.tsMs
    // A zero (or negative) measurement is a sub-clock-resolution
    // artifact, not a real instantaneous tap — a genuine press shorter
    // than the poll period never produces a press AND a release edge in
    // the first place (both would land in the same polled frame with no
    // edge to detect at all). Discarding rather than reporting 0 is
    // deliberate, not a rounding nicety: main's own validator agrees
    // (`durationMs > 0` — see isValidEvent in typing-analytics-service.ts).
    if (durationMs <= 0) return null
    return {
      prepared: press.prepared,
      event: {
        kind: 'matrix-release',
        row: press.row,
        col: press.col,
        layer: press.layer,
        keycode: press.keycode,
        ts,
        durationMs,
      },
    }
  }

  /** Clear all tracked presses and rolling frame/hole state. Call on
   * record toggle, device change, keymap reload, and unmount — an
   * unresolved press is discarded, never synthesized into a release. */
  reset(): void {
    this.presses.clear()
    this.prevFrameTs = null
    this.lastHoleTs = null
    this.lastPressKey = null
  }
}
