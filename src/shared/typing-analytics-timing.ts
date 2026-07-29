// SPDX-License-Identifier: GPL-2.0-or-later
// Timing constant shared between the renderer's per-frame observation-hole
// detection (src/renderer/typing-test/matrix-press-duration.ts) and main's
// ingest-time validation of the pollGapMs field that detection produces
// (src/main/typing-analytics/typing-analytics-service.ts). Kept in one
// place so the validator's upper bound and the renderer's hole threshold
// can never drift apart: by construction, any pollGapMs the renderer ever
// legitimately emits is already <= this value.

/** Longest gap between two polled matrix frames that still counts as
 * continuous observation. 10x the renderer's ~20ms poll cadence (see
 * POLL_INTERVAL in src/renderer/components/editors/matrix-utils.ts) — an
 * ordinary sampling-period gap should never come close to this; anything
 * larger (or negative — a clock step backwards is just as much a break in
 * observation) means the HID read timed out, blocked behind another
 * queued request on the shared mutex (hid-service.ts), or the clock
 * jumped, and any overlap/duration inference spanning it would be
 * fabricating data the poller never actually saw. */
export const OBSERVATION_HOLE_MS = 200
