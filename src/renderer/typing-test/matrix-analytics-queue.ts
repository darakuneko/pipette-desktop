// SPDX-License-Identifier: GPL-2.0-or-later

/** Press-order emission queue for matrix analytics events. Serves every
 *  matrix recording path (typing test, ambient REC, anything else that
 *  feeds processMatrixFrame-shaped presses into analytics) — nothing here
 *  is specific to a typing test.
 *
 *  It exists because tap-hold keys (LT/MT) don't resolve to a tap/hold
 *  classification until their release edge or their deferred-emit
 *  deadline, whichever comes first — and either can land later than
 *  physical presses that follow it. Emitting those later presses
 *  immediately would hand the main-process n-gram aggregator a masked
 *  key's event stamped with an earlier timestamp than events already
 *  emitted for what came after it; the aggregator treats a
 *  non-increasing timestamp as out of order and silently drops it,
 *  losing the masked key from every pair around it. Queuing every press
 *  behind an unresolved one and draining in order once it resolves keeps
 *  the emitted stream monotonic.
 *
 *  {@link MatrixAnalyticsQueue} is the module's public surface: it owns
 *  the queue array itself so callers deal in named operations (push a
 *  resolved press, push a pending tap-hold, resolve one by key, drain
 *  everything on teardown) rather than holding a bare array and knowing
 *  how ordering/draining works. */

import type { TypingAnalyticsEventPayload, TypingMatrixAction } from '../../shared/types/typing-analytics'
import { MAX_TAP_HOLD_DEFER_MS } from '../../shared/qmk-settings-tapping-term'
import type { PressStartRecord } from './matrix-layers'

/** `emit` may hand back a promise the caller can wait on (used by
 * {@link MatrixAnalyticsQueue.drainAll} so a forced teardown drain can be
 * awaited all the way into main) or nothing at all (the normal
 * press/release/deadline paths stay fire-and-forget — nobody downstream
 * needs to know when those land). */
type Emit<TPreparedEvent> = (prepared: TPreparedEvent, event: TypingAnalyticsEventPayload) => void | Promise<void>

/** One entry in the press-order matrix-event queue. Ordinary keys are
 * queued only when they land behind a still-unresolved tap-hold press;
 * `event` is already populated for them at push time. A tap-hold press
 * starts with `event: null` and `pending` set, and gets its `event`
 * filled in — by the release edge or by the deadline timer, whichever
 * comes first — without ever moving position in the queue, so press
 * order survives resolution happening out of press order.
 *
 * `prepared` is the opaque value onPrepareAnalyticsEvent returned at
 * press time (gate + tag already decided then); it travels with the
 * item untouched and is handed back to onEmitAnalyticsEvent once the
 * item is ready to ship, so a flush that happens later — possibly
 * after the state that authorized it has changed — still ships with
 * the context that was live at press time. */
interface QueuedMatrixItem<TPreparedEvent> {
  event: TypingAnalyticsEventPayload | null
  prepared: TPreparedEvent
  pending?: {
    key: string
    start: PressStartRecord
    /** TAPPING_TERM captured at press time. */
    tappingTermMs: number
    timer: ReturnType<typeof setTimeout>
  }
}

/** Emit every queued item whose event is ready, stopping at the first
 * still-unresolved press (or an empty queue). Called both right after a
 * press/release edge and from the deadline timer, since either can be
 * what makes the front of the queue ready. */
function flushMatrixQueue<TPreparedEvent>(
  queue: QueuedMatrixItem<TPreparedEvent>[],
  emit: Emit<TPreparedEvent> | undefined,
): void {
  while (queue.length > 0 && queue[0].event !== null) {
    const item = queue.shift()!
    emit?.(item.prepared, item.event!)
  }
}

/** Settle a pending tap-hold into the event it should ship as. Shared so
 * the release edge, the deadline timer and the teardown drain all build
 * the same payload — a field added to one of them can't drift. */
function settleTapHold<TPreparedEvent>(
  item: QueuedMatrixItem<TPreparedEvent>,
  pending: NonNullable<QueuedMatrixItem<TPreparedEvent>['pending']>,
  action: TypingMatrixAction,
): void {
  clearTimeout(pending.timer)
  item.event = {
    kind: 'matrix',
    row: pending.start.row,
    col: pending.start.col,
    layer: pending.start.layer,
    keycode: pending.start.keycode,
    ts: pending.start.tsMs,
    action,
  }
  item.pending = undefined
}

/** Classify a still-pending tap-hold entry and let the queue drain past
 * it. A no-op if it was already resolved by the other path (release vs.
 * deadline racing) or already drained (e.g. resetMatrixPressTracking ran
 * first) — `pending` is cleared exactly once, by whichever resolves it. */
function resolveQueuedTapHold<TPreparedEvent>(
  item: QueuedMatrixItem<TPreparedEvent>,
  action: TypingMatrixAction,
  queue: QueuedMatrixItem<TPreparedEvent>[],
  emit: Emit<TPreparedEvent> | undefined,
): void {
  const pending = item.pending
  if (!pending) return
  settleTapHold(item, pending, action)
  flushMatrixQueue(queue, emit)
}

/** The queue entry still waiting on the release of `key`, if any. Scanned
 * rather than indexed by a second map: the queue only holds presses from
 * the last tapping-term window, so it is a handful of items at most, and
 * one source of truth cannot fall out of sync with itself. */
function findPendingByKey<TPreparedEvent>(
  queue: readonly QueuedMatrixItem<TPreparedEvent>[],
  key: string,
): QueuedMatrixItem<TPreparedEvent> | undefined {
  return queue.find((item) => item.pending?.key === key)
}

/** Owning type for the press-order matrix analytics queue. One instance
 * per recording session, held in a ref by the caller (e.g.
 * `useTypingTest`); its methods are the only thing that touches the
 * queue's internals, so the caller never needs to know it's backed by an
 * array or how draining preserves order. */
export class MatrixAnalyticsQueue<TPreparedEvent> {
  private readonly items: QueuedMatrixItem<TPreparedEvent>[] = []

  /** Whether anything is still waiting to be emitted. A resolved press
   * can skip the queue entirely and emit straight away when this is
   * empty — see {@link pushResolved}'s caller. */
  get isEmpty(): boolean {
    return this.items.length === 0
  }

  /** Push an already-resolved (non-masked) press onto the back of the
   * queue, behind whatever is still unresolved ahead of it. */
  pushResolved(event: TypingAnalyticsEventPayload, prepared: TPreparedEvent): void {
    this.items.push({ event, prepared })
  }

  /** Push a tap-hold press awaiting classification, and arm the deadline
   * timer that resolves it as `hold` if the release edge doesn't arrive
   * first. The timer itself never waits longer than
   * {@link MAX_TAP_HOLD_DEFER_MS}, regardless of `tappingTermMs` — see
   * that constant's doc comment for the misclassify-vs-corrupt trade-off
   * this caps. `tappingTermMs` is still stored and used uncapped for the
   * release-edge tap/hold comparison in {@link resolveReleaseByKey}: a
   * release arriving before the (possibly capped) deadline fires is
   * always compared against the real configured term. */
  pushPending(
    prepared: TPreparedEvent,
    start: PressStartRecord,
    key: string,
    tappingTermMs: number,
    emit: Emit<TPreparedEvent> | undefined,
  ): void {
    const item: QueuedMatrixItem<TPreparedEvent> = { event: null, prepared }
    const deferMs = Math.min(tappingTermMs, MAX_TAP_HOLD_DEFER_MS)
    const timer = setTimeout(() => {
      resolveQueuedTapHold(item, 'hold', this.items, emit)
    }, deferMs)
    item.pending = { key, start, tappingTermMs, timer }
    this.items.push(item)
  }

  /** Resolve the release edge for `key` against its still-pending entry,
   * if any, classifying it as tap or hold by comparing the hold duration
   * to the TAPPING_TERM captured at press time, then let the queue drain
   * past it. A no-op if `key` has no pending entry (e.g. it was never a
   * tap-hold key). */
  resolveReleaseByKey(key: string, releaseTs: number, emit: Emit<TPreparedEvent> | undefined): void {
    const item = findPendingByKey(this.items, key)
    if (!item?.pending) return
    const duration = releaseTs - item.pending.start.tsMs
    const action: TypingMatrixAction = duration < item.pending.tappingTermMs ? 'tap' : 'hold'
    resolveQueuedTapHold(item, action, this.items, emit)
  }

  /** Finalize every still-unresolved press as `hold` and emit the whole
   * queue in press order, then empty it. Used on record toggle, device
   * change, or keymap reload so an in-flight masked-key press and the
   * queue behind it aren't silently discarded — a hold only breaks the
   * n-gram chain downstream, it never fabricates a pair.
   *
   * Returns a promise that resolves once every emitted item's own
   * promise (if `emit` returned one) has settled. Callers that finalize
   * a session — e.g. resetMatrixPressTracking ahead of a record-off
   * flush — must await this before requesting that flush: main's
   * ingestEvent does a real `await` before the event reaches its minute
   * buffer, so a flush IPC call fired without waiting can be serviced
   * before a drained event lands, landing it in a fresh buffer entry
   * after the session it belonged to was already finalized. Ordinary
   * per-keystroke emits (press/release/deadline) stay fire-and-forget —
   * only a forced drain needs this. */
  drainAll(emit: Emit<TPreparedEvent> | undefined): Promise<void> {
    const emitted: Array<void | Promise<void>> = []
    for (const item of this.items) {
      if (item.pending) settleTapHold(item, item.pending, 'hold')
      if (item.event) emitted.push(emit?.(item.prepared, item.event))
    }
    this.items.length = 0
    return Promise.all(emitted).then(() => undefined)
  }

  /** Clear every still-armed deadline timer without emitting anything,
   * and empty the queue. Call once on unmount: a timer left running past
   * that point would still fire and call back into a hook whose refs
   * (emit sink, prepared context) are about to be torn down along with
   * it. Unlike {@link drainAll}, this discards rather than finalizes —
   * there is no live caller left to hand a finalized event to. */
  dispose(): void {
    for (const item of this.items) {
      if (item.pending) clearTimeout(item.pending.timer)
    }
    this.items.length = 0
  }
}
