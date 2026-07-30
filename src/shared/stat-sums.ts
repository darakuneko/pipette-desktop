// SPDX-License-Identifier: GPL-2.0-or-later
// Shared sum / sum-of-squares statistics — used by every accumulator in
// this codebase that persists Σx and Σx² instead of raw samples (bigram
// IKI, keypress duration, ...) so a range aggregate can derive a true
// standard deviation without re-deriving the formula per metric. Zero
// dependencies on main or renderer so both processes can import it.

/** Standard deviation from accumulated sum / sum-of-squares. Clips the
 * variance to 0 before the sqrt — with equally-spaced samples,
 * floating-point rounding in `sumSq/n - (sum/n)^2` can go very slightly
 * negative, which would otherwise produce NaN instead of the correct
 * answer (0). Returns null when there are fewer than 2 samples (SD is
 * undefined for n < 2). */
export function sdFromSums(sum: number, sumSq: number, count: number): number | null {
  if (count < 2) return null
  const mean = sum / count
  const variance = sumSq / count - mean * mean
  return Math.sqrt(Math.max(0, variance))
}
