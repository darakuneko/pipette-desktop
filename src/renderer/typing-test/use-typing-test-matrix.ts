// SPDX-License-Identifier: GPL-2.0-or-later

/** Matrix-press analytics pipeline for useTypingTest: press/release edge
 *  walking, layer-switch latching, tap/hold queue ordering, and the layer
 *  indicator (`effectiveLayer`) it drives. Owns its own engine instances
 *  (queue/duration/latch) — one per mount, disposed together on unmount —
 *  so the host hook only has to thread refs through, not lifecycle.
 *
 *  The only edge back into the host's own state (`setBaseLayer`) is
 *  `applyBaseLayer`: a base-layer change must keep any key latched above
 *  it displayed at its latched target rather than snapping to the new
 *  base — see MatrixLayerLatch.displayLayer. */

import { useState, useRef, useCallback, useEffect, type RefObject } from 'react'
import { isTapKeycode } from './keycode-char-map'
import type { TypingTestConfig } from './types'
import type { TypingTestState } from './run-state'
import type { TypingAnalyticsEventPayload } from '../../shared/types/typing-analytics'
import {
  extractSwitchLayer,
  resolveEffectiveCodeWithLayer,
  matrixFrameEdges,
} from './matrix-layers'
import { MatrixAnalyticsQueue } from './matrix-analytics-queue'
import { PressDurationTracker } from './matrix-press-duration'
import { MatrixLayerLatch } from './matrix-layer-latch'
import { deriveExpectedChar } from './expected-char'
import type { UseTypingTestOptions } from './use-typing-test-types'

export interface TypingTestMatrixParams<TPreparedEvent> {
  stateRef: RefObject<TypingTestState>
  configRef: RefObject<TypingTestConfig>
  languageRef: RefObject<string>
  baseLayerRef: RefObject<number>
  windowFocusedRef: RefObject<boolean>
  prepareAnalyticsEventRef: RefObject<UseTypingTestOptions<TPreparedEvent>['onPrepareAnalyticsEvent']>
  emitAnalyticsEventRef: RefObject<UseTypingTestOptions<TPreparedEvent>['onEmitAnalyticsEvent']>
  noteKeystrokeRegistrationRef: RefObject<UseTypingTestOptions<TPreparedEvent>['onNoteKeystrokeRegistration']>
  tappingTermMsRef: RefObject<number>
}

export interface TypingTestMatrixResult {
  effectiveLayer: number
  /** Re-derive the layer indicator for a new base layer — the only
   * cross-cluster edge from the host's setBaseLayer into this hook. */
  applyBaseLayer: (layer: number) => void
  processMatrixFrame: (pressed: ReadonlySet<string>, keymap: Map<string, number>) => void
  /** Returns a promise that resolves once every drained item's emit has
   * settled — see {@link MatrixAnalyticsQueue.drainAll}. A caller that
   * finalizes a session (record-off, test-finish) before requesting a
   * flush must await it; a caller that just wants edge-tracking reset
   * (e.g. a keymap change) can ignore the return value. */
  resetMatrixPressTracking: () => Promise<void>
}

export function useTypingTestMatrix<TPreparedEvent>(
  params: TypingTestMatrixParams<TPreparedEvent>,
): TypingTestMatrixResult {
  const {
    stateRef, configRef, languageRef, baseLayerRef, windowFocusedRef,
    prepareAnalyticsEventRef, emitAnalyticsEventRef, noteKeystrokeRegistrationRef, tappingTermMsRef,
  } = params

  const [effectiveLayer, setEffectiveLayer] = useState(0)
  const prevPressedRef = useRef<ReadonlySet<string>>(new Set())
  const latchedLayersRef = useRef(new MatrixLayerLatch())
  // Press-order emission queue for matrix analytics events. See
  // matrix-analytics-queue.ts for why this exists instead of emitting
  // non-masked keys unconditionally on press.
  const matrixQueueRef = useRef(new MatrixAnalyticsQueue<TPreparedEvent>())
  // Per-key press-duration + overlap tracking, independent of the queue
  // above — it covers every press (masked or not) and ships its own
  // 'matrix-release' event straight through `emit`, bypassing the queue
  // entirely. Safe to bypass: a release event only touches the per-cell
  // duration accumulator in main (no keystrokes/intervals/activeMs/n-gram),
  // so it can never corrupt the ordering the queue exists to protect, and
  // a release arriving late relative to a still-queued masked press is
  // absorbed by the main-process MinuteBuffer's retention window instead
  // of needing to arrive in order. See matrix-press-duration.ts.
  const matrixDurationRef = useRef(new PressDurationTracker<TPreparedEvent>())

  const processMatrixFrame = useCallback((pressed: ReadonlySet<string>, keymap: Map<string, number>) => {
    const bl = baseLayerRef.current
    const prev = prevPressedRef.current
    const latched = latchedLayersRef.current

    // Matrix events come from HID polling and should fire regardless of
    // window focus; it's the caller's responsibility to stop calling
    // processMatrixFrame when recording should pause (e.g. record
    // toggle off).
    const prepare = prepareAnalyticsEventRef.current
    const emit = emitAnalyticsEventRef.current
    const queue = matrixQueueRef.current
    const duration = matrixDurationRef.current
    const ts = Date.now()
    const tappingTermMs = tappingTermMsRef.current
    // Read once per frame, before any press edge, regardless of whether
    // any press lands this frame — onFrame's rolling gap/hole tracking
    // needs a sample every frame to detect a hole between frames with no
    // edges at all. Always defined together with `prepare`; both are
    // checked together below purely so `frame`'s type narrows to
    // non-null at the registerPress call site.
    const frame = prepare ? duration.onFrame(ts) : null

    // Walk this frame's press/release edges in row-major order — a held
    // key (no edge) is skipped entirely, since its action was already
    // latched on the frame it was pressed and QMK never re-resolves a
    // held key against layers it or another key activates later. A
    // release drops its own latch; a press resolves against whatever is
    // latched right now (base layer + targets latched by keys already
    // held, or by an earlier edge in this same walk), THEN latches its
    // own target — so a same-frame rollover between a release and a
    // press "sees" each other in the deterministic row-scan order rather
    // than in whatever order a Set happened to iterate.
    for (const edge of matrixFrameEdges(prev, pressed)) {
      if (!edge.isPress) {
        latched.release(edge.key)
        if (prepare) {
          queue.resolveReleaseByKey(edge.key, ts, emit)
          const resolved = duration.resolveRelease(edge.key, ts)
          if (resolved) emit?.(resolved.prepared, resolved.event)
        }
        continue
      }

      const sortedLayers = latched.activeLayers(bl)
      const resolved = resolveEffectiveCodeWithLayer(edge.row, edge.col, keymap, sortedLayers, bl)
      if (!resolved) continue
      const { code, layer: eventLayer } = resolved
      latched.latch(edge.key, extractSwitchLayer(code))

      if (!prepare || !frame) continue
      // Authorize + tag at press time, not when this press eventually
      // reaches the sink (which may be up to TAPPING_TERM later if it
      // queues behind an unresolved masked key ahead of it). A press
      // that isn't authorized right now is dropped for good — it never
      // enters the queue, so it can't be "un-dropped" by a state change
      // (e.g. recording toggling back on) while it would have waited.
      const prepared = prepare('matrix', windowFocusedRef.current)
      if (prepared == null) continue
      // Run-keystroke-log word attribution, snapshotted now (registration
      // time) rather than whenever this press eventually emits — see
      // onNoteKeystrokeRegistration's doc comment. Gated on window focus
      // here (the primary gate — HID matrix polling itself is NOT gated
      // on focus, see the comment atop this function, so without this
      // check a keystroke typed into a different, unfocused application
      // on the same keyboard would be attributed to the run log): only
      // ever called while the app window is actually focused.
      if (windowFocusedRef.current) {
        noteKeystrokeRegistrationRef.current?.(
          stateRef.current.runId, edge.row, edge.col, ts, stateRef.current.currentWordIndex,
          () => deriveExpectedChar(stateRef.current, configRef.current, languageRef.current),
          windowFocusedRef.current,
        )
      }
      // Overlap / pollGapMs are derived from the raw pressed set, not
      // from anything queue-related — see matrix-press-duration.ts.
      // registerPress also records this press so the matching release
      // edge (in a later frame) can compute its duration and ship the
      // same `prepared` context this press already captured.
      const { overlap, pollGapMs } = duration.registerPress({
        key: edge.key,
        start: { tsMs: ts, row: edge.row, col: edge.col, layer: eventLayer, keycode: code },
        prepared,
        pressed,
        frame,
      })
      // Non-masked keys carry no action field and are queued/emitted in
      // press order like everything else. Masked keys (LT/MT) resolve to
      // tap vs hold on a deadline fixed at press time (see
      // matrix-analytics-queue.ts), by the release edge if it arrives
      // first or by the deadline timer if the key is still held — so
      // resolution can land later than physical presses that follow it.
      // Emitting those later presses immediately would hand the main
      // process a masked key's event stamped with an earlier timestamp
      // than events already emitted for what came after it; its n-gram
      // chain treats a non-increasing timestamp as out of order and
      // silently drops it, losing the masked key from every pair around
      // it (the motivating case: a thumb LT(1, KC_SPACE) overlapping the
      // next letter in ordinary fast typing). Queuing every press behind
      // an unresolved one and draining in order once it resolves keeps
      // the emitted stream monotonic. See resetMatrixPressTracking for
      // what happens to a press still unresolved when recording stops.
      // Only LT / MT style tap-hold keys need the deferred classify
      // pass. LSFT(kc) etc. are "masked" too but always fire the
      // modifier + base together, so the heatmap treats them as regular
      // presses.
      if (isTapKeycode(code)) {
        queue.pushPending(
          prepared,
          { tsMs: ts, row: edge.row, col: edge.col, layer: eventLayer, keycode: code, overlap, pollGapMs },
          edge.key,
          tappingTermMs,
          emit,
        )
      } else {
        const event: TypingAnalyticsEventPayload = { kind: 'matrix', row: edge.row, col: edge.col, layer: eventLayer, keycode: code, ts, overlap, pollGapMs }
        // An empty queue means nothing ahead is still unresolved, so
        // this press can go straight out instead of paying for a round
        // trip through the queue.
        if (queue.isEmpty) {
          emit?.(prepared, event)
        } else {
          queue.pushResolved(event, prepared)
        }
      }
    }

    setEffectiveLayer(latched.displayLayer(bl))
    // `pressed` is a fresh Set the caller builds every poll and never
    // mutates afterward (see parseMatrixState in matrix-utils.ts), so
    // adopting the reference is safe and skips a same-size Set clone on
    // every frame, busy or idle.
    prevPressedRef.current = pressed
  }, [])

  /** Reset press-edge tracking. Call on record toggle, device change, or
   * keymap reload so the next frame doesn't emit stale "newly pressed"
   * events.
   *
   * Also drains any in-flight masked-key press and the queue behind it:
   * every unresolved press is finalized as `hold` (the keystroke must
   * not vanish just because recording stopped mid-hold — a hold only
   * breaks the n-gram chain downstream, it never fabricates a pair),
   * then the whole queue is flushed in press order so ordinary keys
   * queued behind it aren't dropped either. Simply clearing the maps,
   * as before this queue existed, would have silently discarded more
   * than just the pending press.
   *
   * Each item ships with the `prepared` context its own press already
   * captured via onPrepareAnalyticsEvent — not whatever is live right
   * now. resetMatrixPressTracking itself typically runs *because* that
   * live state just changed (e.g. recording toggled off), so re-reading
   * it here would gate or tag every drained item by state that arrived
   * after the keystroke, which is exactly what this queue exists to
   * avoid.
   *
   * Returns the promise {@link MatrixAnalyticsQueue.drainAll} hands back.
   * A caller finalizing a session (record toggling off, a test
   * finishing) must await it before requesting a flush for that session
   * — see the promise's own doc comment for why firing the flush
   * without waiting can lose or misplace exactly the events this drain
   * just sent. */
  const resetMatrixPressTracking = useCallback((): Promise<void> => {
    const drained = matrixQueueRef.current.drainAll(emitAnalyticsEventRef.current)
    prevPressedRef.current = new Set()
    // A latch with no corresponding entry in prevPressedRef (now empty)
    // can never be reached by a future release edge — its key would
    // have to reappear in `pressed` AND `prev` at once to register as
    // "held, no edge", which can't happen once prev is cleared. Left
    // uncleared, a key still physically held through this reset would
    // keep its stale target forever, permanently inflating the layer
    // indicator. Clearing here is safe either way: a key still actually
    // held gets treated as a fresh press (and re-latched) on the very
    // next frame, per its own row/col resolution at that point.
    latchedLayersRef.current.clear()
    // Discard rather than finalize — an in-flight press with no release
    // yet must not be synthesized into a fabricated release event (see
    // matrix-press-duration.ts). Unlike the queue's forced hold
    // classification, there is nothing to salvage here: a duration
    // sample without an observed release is just noise.
    matrixDurationRef.current.reset()
    return drained
  }, [])

  // Clear any still-armed deadline timer on unmount. Without this, a
  // timer set by MatrixAnalyticsQueue.pushPending can outlive the
  // component and fire against refs that are no longer meaningful — see
  // MatrixAnalyticsQueue.dispose.
  useEffect(() => {
    return () => {
      matrixQueueRef.current.dispose()
      matrixDurationRef.current.reset()
      latchedLayersRef.current.clear()
    }
  }, [])

  const applyBaseLayer = useCallback((layer: number) => {
    // A layer key held across the base-layer change (e.g. the keyboard
    // popover's own layer selector) must keep the indicator on its
    // latched target rather than snapping to the newly selected base.
    setEffectiveLayer(latchedLayersRef.current.displayLayer(layer))
  }, [])

  return { effectiveLayer, applyBaseLayer, processMatrixFrame, resetMatrixPressTracking }
}
