// SPDX-License-Identifier: GPL-2.0-or-later
// Colour ramp for the typing-view heatmap overlay. Kept in its own
// module so the KeyWidget fill-priority chain stays readable and the
// ramp can be tweaked without touching the rest of the key renderer.

/** Maps a normalized 0-1 intensity to an HSL fill. 0 returns a soft
 * yellow tint; 1 returns a saturated red. Intensities above 1 are
 * clamped so the hottest key cannot go beyond full red. */
export function heatmapFill(intensity: number): string {
  const t = Math.max(0, Math.min(1, intensity))
  // Hue slides from yellow (60°) to red (0°). Lightness drops so the
  // high end reads as a filled red key rather than a washed-out tint.
  const hue = Math.round(60 - 60 * t)
  const saturation = 70
  const lightness = Math.round(80 - 30 * t)
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`
}

/** Returns the HSL fill for the given `"row,col"` cell using the raw
 * count map + the pre-computed peak. Returns null when the cell has
 * no count or the peak is zero; callers should fall back to the
 * default key background in that case. Keeping the peak outside of
 * this function lets callers compute it once per frame instead of
 * per-key. Accepting `posKey` as the `"row,col"` string the caller
 * already formatted for other Set/Map lookups avoids a second
 * per-key allocation in the render loop. */
export function heatmapFillForCell(
  intensityByCell: Map<string, number> | null | undefined,
  maxCount: number,
  posKey: string,
): string | null {
  if (!intensityByCell || maxCount <= 0) return null
  const count = intensityByCell.get(posKey)
  if (!count || count <= 0) return null
  return heatmapFill(count / maxCount)
}
