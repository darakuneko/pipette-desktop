// SPDX-License-Identifier: GPL-2.0-or-later

/** Press-time layer-switch latch: which matrix keys are currently
 *  holding the typing test's layer indicator above the base layer, and
 *  what target layer each one latched onto at the moment it was
 *  resolved.
 *
 *  Mirrors the ownership pattern of the other per-frame trackers in this
 *  directory (PressDurationTracker in matrix-press-duration.ts,
 *  MatrixAnalyticsQueue in matrix-analytics-queue.ts): one instance per
 *  recording session, held in a ref by useTypingTest, with the same
 *  reset-on-toggle / reset-on-unmount lifecycle.
 *
 *  A key's target is captured once, by the press edge that resolves it
 *  (see processMatrixFrame in useTypingTest.ts), and is never
 *  re-resolved while the key stays held — matching QMK's own behavior
 *  of caching a key's action at press time instead of re-evaluating a
 *  held key against layers it (or another key) activates later. */
export class MatrixLayerLatch {
  private readonly targets = new Map<string, number | null>()

  /** Record the raw target layer a press resolved to (null for a
   * non-layer-switch key). Deliberately NOT Math.max'd against the base
   * layer that was active at press time — see {@link displayLayer} for
   * why the raw value is what keeps a base-layer change mid-hold
   * correct. */
  latch(key: string, target: number | null): void {
    this.targets.set(key, target)
  }

  /** Drop a key's latch on its release edge. */
  release(key: string): void {
    this.targets.delete(key)
  }

  /** Clear every latch. Call on record toggle, device change, keymap
   * reload, or unmount so a key still physically held afterward starts
   * fresh — re-latched from its next press edge — rather than keeping a
   * target left over from before the reset. */
  clear(): void {
    this.targets.clear()
  }

  /** The layer set to resolve a new press against, right now: the base
   * layer plus every currently latched (non-null) target, highest
   * first. Includes the base layer itself (not just as a trailing
   * fallback) so a latched target below the base layer correctly loses
   * to a base-layer override at the same position, matching QMK's
   * highest-active-layer walk. */
  activeLayers(baseLayer: number): number[] {
    const layers = new Set<number>([baseLayer])
    for (const target of this.targets.values()) {
      if (target != null) layers.add(target)
    }
    return [...layers].sort((a, b) => b - a)
  }

  /** The layer the UI indicator should show: the highest of the base
   * layer and every currently latched target. Each target is the raw
   * value latched at its own press time, so this stays correct even
   * after the base layer changes mid-hold (see setBaseLayer in
   * useTypingTest.ts, which calls this for the same reason). Walks the
   * map directly rather than going through {@link activeLayers} — this
   * runs once per frame (and once per setBaseLayer call) and only needs
   * the max, not the full sorted set a press resolution requires. */
  displayLayer(baseLayer: number): number {
    let highest = baseLayer
    for (const target of this.targets.values()) {
      if (target != null && target > highest) highest = target
    }
    return highest
  }
}
