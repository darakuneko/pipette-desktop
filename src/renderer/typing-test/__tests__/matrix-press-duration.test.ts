// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { PressDurationTracker, OBSERVATION_HOLE_MS, type RegisterPressInput } from '../matrix-press-duration'

/** Builds the `start` half of a {@link RegisterPressInput} from a
 * "row,col" key string plus the remaining PressStartRecord fields, so
 * call sites below don't have to spell out the nested object literal
 * every time. */
function start(key: string, tsMs: number, row: number, col: number, layer: number, keycode: number) {
  return { key, start: { tsMs, row, col, layer, keycode } }
}

function press<TPreparedEvent>(
  t: PressDurationTracker<TPreparedEvent>,
  key: string,
  tsMs: number,
  row: number,
  col: number,
  layer: number,
  keycode: number,
  prepared: TPreparedEvent,
  pressed: ReadonlySet<string>,
  frame: RegisterPressInput<TPreparedEvent>['frame'],
) {
  return t.registerPress({ ...start(key, tsMs, row, col, layer, keycode), prepared, pressed, frame })
}

describe('PressDurationTracker', () => {
  describe('onFrame', () => {
    it('reports no hole and a null gap on the very first frame', () => {
      const t = new PressDurationTracker<true>()
      expect(t.onFrame(1000)).toEqual({ isHole: false, gapMs: null })
    })

    it('reports the gap when it is within the observation window', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      expect(t.onFrame(1020)).toEqual({ isHole: false, gapMs: 20 })
    })

    it('flags a hole when the gap exceeds OBSERVATION_HOLE_MS', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      const frame = t.onFrame(1000 + OBSERVATION_HOLE_MS + 1)
      expect(frame.isHole).toBe(true)
      expect(frame.gapMs).toBeNull()
    })

    it('does not flag a hole exactly at the threshold', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      const frame = t.onFrame(1000 + OBSERVATION_HOLE_MS)
      expect(frame.isHole).toBe(false)
    })

    it('flags a hole when the clock steps backwards (negative gap)', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      const frame = t.onFrame(900)
      expect(frame.isHole).toBe(true)
      expect(frame.gapMs).toBeNull()
    })

    it('does not flag a hole for a zero gap (two frames at the same ts)', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      const frame = t.onFrame(1000)
      expect(frame.isHole).toBe(false)
      expect(frame.gapMs).toBe(0)
    })
  })

  describe('registerPress — overlap', () => {
    it('is undefined for the first press ever registered', () => {
      const t = new PressDurationTracker<true>()
      const frame = t.onFrame(1000)
      const { overlap } = press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame)
      expect(overlap).toBeUndefined()
    })

    it('is true when the previous press-edge key is still in the pressed set', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      const frame2 = t.onFrame(1010)
      const { overlap } = press(t, '0,1', 1010, 0, 1, 0, 5, true, new Set(['0,0', '0,1']), frame2)
      expect(overlap).toBe(true)
    })

    it('is false when the previous press-edge key is no longer in the pressed set', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      const frame2 = t.onFrame(1010)
      const { overlap } = press(t, '0,1', 1010, 0, 1, 0, 5, true, new Set(['0,1']), frame2)
      expect(overlap).toBe(false)
    })

    it('handles a 3-key chord landing in one frame: first undefined, rest true', () => {
      const t = new PressDurationTracker<true>()
      const frame = t.onFrame(1000)
      const pressed = new Set(['0,0', '0,1', '0,2'])
      const a = press(t, '0,0', 1000, 0, 0, 0, 4, true, pressed, frame)
      const b = press(t, '0,1', 1000, 0, 1, 0, 5, true, pressed, frame)
      const c = press(t, '0,2', 1000, 0, 2, 0, 6, true, pressed, frame)
      expect(a.overlap).toBeUndefined()
      expect(b.overlap).toBe(true)
      expect(c.overlap).toBe(true)
    })

    it('is undefined when the current frame itself is a hole', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      const holeTs = 1000 + OBSERVATION_HOLE_MS + 1
      const holeFrame = t.onFrame(holeTs)
      const { overlap } = press(t, '0,1', holeTs, 0, 1, 0, 5, true, new Set(['0,0', '0,1']), holeFrame)
      expect(overlap).toBeUndefined()
    })

    it('is undefined when the current frame is a hole caused by a backwards clock step', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      const holeFrame = t.onFrame(900)
      const { overlap } = press(t, '0,1', 900, 0, 1, 0, 5, true, new Set(['0,0', '0,1']), holeFrame)
      expect(overlap).toBeUndefined()
    })

    it('is undefined when the reference press predates the last recorded hole, even in a later, non-hole frame', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      // Hole frame — records lastHoleTs and clears the reference key.
      t.onFrame(1000 + OBSERVATION_HOLE_MS + 1)

      // A later, ordinary-gap frame still can't trust '0,0' as a
      // reference, because it was last registered before the hole.
      const frame3 = t.onFrame(1000 + OBSERVATION_HOLE_MS + 20)
      const { overlap } = press(t, '0,1', 1000 + OBSERVATION_HOLE_MS + 20, 0, 1, 0, 5, true, new Set(['0,0', '0,1']), frame3)
      expect(overlap).toBeUndefined()
    })
  })

  describe('registerPress — pollGapMs', () => {
    it('attaches to the first press edge of a frame only', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      const frame2 = t.onFrame(1020)
      const pressed = new Set(['0,0', '0,1'])
      const a = press(t, '0,0', 1020, 0, 0, 0, 4, true, pressed, frame2)
      const b = press(t, '0,1', 1020, 0, 1, 0, 5, true, pressed, frame2)
      expect(a.pollGapMs).toBe(20)
      expect(b.pollGapMs).toBeUndefined()
    })

    it('is absent on the very first frame (no previous frame to diff against)', () => {
      const t = new PressDurationTracker<true>()
      const frame = t.onFrame(1000)
      const { pollGapMs } = press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame)
      expect(pollGapMs).toBeUndefined()
    })

    it('is absent when the frame is a hole', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      const holeFrame = t.onFrame(1000 + OBSERVATION_HOLE_MS + 1)
      const { pollGapMs } = press(t, '0,0', 1000 + OBSERVATION_HOLE_MS + 1, 0, 0, 0, 4, true, new Set(['0,0']), holeFrame)
      expect(pollGapMs).toBeUndefined()
    })

    it('is absent when the frame is a hole caused by a backwards clock step', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      const holeFrame = t.onFrame(900)
      const { pollGapMs } = press(t, '0,0', 900, 0, 0, 0, 4, true, new Set(['0,0']), holeFrame)
      expect(pollGapMs).toBeUndefined()
    })
  })

  describe('resolveRelease', () => {
    it('returns null for a key that was never registered', () => {
      const t = new PressDurationTracker<true>()
      expect(t.resolveRelease('0,0', 1000)).toBeNull()
    })

    it('computes durationMs from the matching press and clears the entry', () => {
      const t = new PressDurationTracker<string>()
      const frame = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 2, 0x04, 'ctx', new Set(['0,0']), frame)

      const resolved = t.resolveRelease('0,0', 1150)
      expect(resolved).toEqual({
        prepared: 'ctx',
        event: { kind: 'matrix-release', row: 0, col: 0, layer: 2, keycode: 0x04, ts: 1150, durationMs: 150 },
      })

      // Resolved once — a second release for the same key finds nothing.
      expect(t.resolveRelease('0,0', 1200)).toBeNull()
    })

    it('discards a press whose duration would span an observation hole', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      // A hole opens between the press and the eventual release.
      t.onFrame(1000 + OBSERVATION_HOLE_MS + 1)

      const resolved = t.resolveRelease('0,0', 1000 + OBSERVATION_HOLE_MS + 50)
      expect(resolved).toBeNull()
    })

    it('discards a press whose duration would span a backwards-clock-step hole', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      // The clock jumps backwards between the press and the release.
      t.onFrame(900)

      const resolved = t.resolveRelease('0,0', 950)
      expect(resolved).toBeNull()
    })

    it('does not discard a press registered AFTER the last hole', () => {
      const t = new PressDurationTracker<true>()
      t.onFrame(1000)
      // Hole frame.
      t.onFrame(1000 + OBSERVATION_HOLE_MS + 1)
      // A fresh press registered post-hole.
      const frame3 = t.onFrame(1000 + OBSERVATION_HOLE_MS + 20)
      press(t, '0,0', 1000 + OBSERVATION_HOLE_MS + 20, 0, 0, 0, 4, true, new Set(['0,0']), frame3)

      const resolved = t.resolveRelease('0,0', 1000 + OBSERVATION_HOLE_MS + 70)
      expect(resolved).not.toBeNull()
      expect(resolved?.event.durationMs).toBe(50)
    })

    it('returns null for a non-positive duration instead of emitting a zero/negative sample', () => {
      const t = new PressDurationTracker<true>()
      const frame = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame)
      expect(t.resolveRelease('0,0', 1000)).toBeNull()
    })
  })

  describe('reset', () => {
    it('discards an unresolved press instead of letting a later release resolve it', () => {
      const t = new PressDurationTracker<true>()
      const frame = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame)

      t.reset()

      expect(t.resolveRelease('0,0', 2000)).toBeNull()
    })

    it('clears hole/overlap state so the next press is treated as the first observation', () => {
      const t = new PressDurationTracker<true>()
      const frame1 = t.onFrame(1000)
      press(t, '0,0', 1000, 0, 0, 0, 4, true, new Set(['0,0']), frame1)

      t.reset()

      const frame2 = t.onFrame(5000)
      expect(frame2).toEqual({ isHole: false, gapMs: null })
      const { overlap } = press(t, '0,1', 5000, 0, 1, 0, 5, true, new Set(['0,1']), frame2)
      expect(overlap).toBeUndefined()
    })
  })
})
