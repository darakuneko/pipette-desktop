// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo, memo } from 'react'
import type { KleKey } from '../../../shared/kle/types'
import { filterVisibleKeys, repositionLayoutKeys } from '../../../shared/kle/filter-keys'
import { posKey } from '../../../shared/kle/pos-key'
import { KeyWidget } from './KeyWidget'
import { EncoderWidget } from './EncoderWidget'
import { KEY_UNIT, KEY_SPACING, KEYBOARD_PADDING } from './constants'
import { innerHeatmapFillForCell, outerHeatmapFillForCell } from './heatmap-fill'
import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'

/** Rotate point (px, py) by `angle` degrees around center (cx, cy). */
export function rotatePoint(
  px: number,
  py: number,
  angle: number,
  cx: number,
  cy: number,
): [number, number] {
  const rad = (angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = px - cx
  const dy = py - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

/** Compute bounding-box corners of a key (both rects), accounting for rotation. */
function keyCorners(
  key: KleKey,
  s: number,
  spacing: number,
): [number, number][] {
  const x0 = s * key.x
  const y0 = s * key.y
  const x1 = s * (key.x + key.width) - spacing
  const y1 = s * (key.y + key.height) - spacing
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  // Include secondary rect corners for stepped/ISO keys
  const has2 =
    key.width2 !== key.width ||
    key.height2 !== key.height ||
    key.x2 !== 0 ||
    key.y2 !== 0
  if (has2) {
    const sx0 = x0 + s * key.x2
    const sy0 = y0 + s * key.y2
    const sx1 = s * (key.x + key.x2 + key.width2) - spacing
    const sy1 = s * (key.y + key.y2 + key.height2) - spacing
    corners.push([sx0, sy0], [sx1, sy0], [sx1, sy1], [sx0, sy1])
  }
  if (key.rotation === 0) return corners
  const cx = s * key.rotationX
  const cy = s * key.rotationY
  return corners.map(([px, py]) => rotatePoint(px, py, key.rotation, cx, cy))
}

interface Props {
  keys: KleKey[]
  keycodes: Map<string, string>
  maskKeycodes?: Map<string, string>
  encoderKeycodes?: Map<string, [string, string]>
  selectedKey?: { row: number; col: number } | null
  selectedEncoder?: { idx: number; dir: 0 | 1 } | null
  pressedKeys?: Set<string>
  highlightedKeys?: Set<string>
  everPressedKeys?: Set<string>
  remappedKeys?: Set<string>
  multiSelectedKeys?: Set<string>
  layoutOptions?: Map<number, number>
  selectedMaskPart?: boolean
  /** Per-cell press triples for the typing-view heatmap overlay,
   * keyed by `"row,col"`. The overlay is hidden when this is null. */
  heatmapCells?: Map<string, TypingHeatmapCell> | null
  /** Peak `total` across `heatmapCells` — paints the single heatmap
   * rect on non-tap-hold keys. */
  heatmapMaxTotal?: number
  /** Peak `tap` across `heatmapCells` — scales the inner (tap) rect
   * of masked LT/MT keys independently of the outer (hold) ramp. */
  heatmapMaxTap?: number
  /** Peak `hold` across `heatmapCells` — scales the outer rect of
   * masked LT/MT keys. */
  heatmapMaxHold?: number
  /** Optional per-key pretty-label override keyed by `"row,col"`. The
   *  Analyze view passes this so snapshot keymaps render with multi-part
   *  LT/LM labels even when the connected keyboard does not currently
   *  register those composites. */
  labelOverrides?: Map<string, { outer: string; inner: string; masked: boolean }>
  /** Optional per-key background fill keyed by `"row,col"`. Lives below
   *  the interactive and heatmap fill layers so pressed/selected/etc.
   *  still win. Used by the Finger Assignment modal to paint each key
   *  with its finger colour. */
  keyColors?: Map<string, string>
  onKeyClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onKeyDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  onEncoderClick?: (key: KleKey, direction: number, maskClicked: boolean) => void
  onEncoderDoubleClick?: (key: KleKey, direction: number, rect: DOMRect, maskClicked: boolean) => void
  onKeyHover?: (key: KleKey, keycode: string, rect: DOMRect) => void
  onKeyHoverEnd?: () => void
  readOnly?: boolean
  scale?: number
}

function KeyboardWidgetInner({
  keys,
  keycodes,
  maskKeycodes,
  encoderKeycodes,
  selectedKey,
  selectedEncoder,
  selectedMaskPart,
  pressedKeys,
  highlightedKeys,
  everPressedKeys,
  remappedKeys,
  multiSelectedKeys,
  layoutOptions,
  heatmapCells,
  heatmapMaxTotal = 0,
  heatmapMaxTap = 0,
  heatmapMaxHold = 0,
  labelOverrides,
  keyColors,
  onKeyClick,
  onKeyDoubleClick,
  onEncoderClick,
  onEncoderDoubleClick,
  onKeyHover,
  onKeyHoverEnd,
  readOnly = false,
  scale = 1,
}: Props) {
  const effectiveTheme = useEffectiveTheme()

  // Reposition runs on the full key list (including decals) so option 0's
  // bounding box is computed correctly; decals are dropped afterwards by
  // `filterVisibleKeys`. Mirrors `widgets/keyboard_widget.py:place_widgets` +
  // `update_layout` in vial-gui.
  const visibleKeys = useMemo(() => {
    const opts = layoutOptions ?? new Map<number, number>()
    return filterVisibleKeys(repositionLayoutKeys(keys, opts), opts)
  }, [keys, layoutOptions])

  // Calculate SVG bounds (track min to normalize position)
  const bounds = useMemo(() => {
    const pad2 = KEYBOARD_PADDING * 2
    if (visibleKeys.length === 0) {
      return { width: pad2, height: pad2, originX: -KEYBOARD_PADDING, originY: -KEYBOARD_PADDING }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const s = KEY_UNIT * scale
    const spacing = KEY_SPACING * scale
    for (const key of visibleKeys) {
      for (const [cx, cy] of keyCorners(key, s, spacing)) {
        if (cx < minX) minX = cx
        if (cy < minY) minY = cy
        if (cx > maxX) maxX = cx
        if (cy > maxY) maxY = cy
      }
    }
    return {
      width: maxX - minX + pad2,
      height: maxY - minY + pad2,
      originX: minX - KEYBOARD_PADDING,
      originY: minY - KEYBOARD_PADDING,
    }
  }, [visibleKeys, scale])

  return (
    <svg
      width={bounds.width}
      height={bounds.height}
      viewBox={`${bounds.originX} ${bounds.originY} ${bounds.width} ${bounds.height}`}
      className="select-none"
    >
      {/* Render non-selected keys first, then selected key on top so its
          stroke is never hidden by adjacent keys painted later in DOM order */}
      {visibleKeys.map((key, idx) => {
        const isEncoder = key.encoderIdx >= 0
        const isSelected = isEncoder
          ? selectedEncoder?.idx === key.encoderIdx && selectedEncoder?.dir === key.encoderDir
          : selectedKey?.row === key.row && selectedKey?.col === key.col
        if (isSelected) return null

        if (isEncoder) {
          const encKey = String(key.encoderIdx)
          const [cw, ccw] = encoderKeycodes?.get(encKey) ?? ['KC_NO', 'KC_NO']
          const kc = key.encoderDir === 0 ? cw : ccw
          return (
            <EncoderWidget
              key={`enc-${key.encoderIdx}-${key.encoderDir}-${idx}`}
              kleKey={key}
              keycode={kc}
              selected={false}
              onClick={readOnly ? undefined : onEncoderClick}
              onDoubleClick={readOnly ? undefined : onEncoderDoubleClick}
              scale={scale}
            />
          )
        }

        const pos = posKey(key.row, key.col)
        return (
          <KeyWidget
            key={`key-${key.row}-${key.col}-${idx}`}
            kleKey={key}
            keycode={keycodes.get(pos) ?? 'KC_NO'}
            maskKeycode={maskKeycodes?.get(pos)}
            selected={false}
            multiSelected={multiSelectedKeys?.has(pos)}
            pressed={pressedKeys?.has(pos)}
            highlighted={highlightedKeys?.has(pos)}
            everPressed={everPressedKeys?.has(pos)}
            remapped={remappedKeys?.has(pos)}
            heatmapOuterFill={outerHeatmapFillForCell(heatmapCells, heatmapMaxHold, heatmapMaxTotal, pos, effectiveTheme)}
            heatmapInnerFill={innerHeatmapFillForCell(heatmapCells, heatmapMaxTap, pos, effectiveTheme)}
            effectiveTheme={effectiveTheme}
            customFill={keyColors?.get(pos) ?? null}
            labelOverride={labelOverrides?.get(pos)}
            onClick={readOnly ? undefined : onKeyClick}
            onDoubleClick={readOnly ? undefined : onKeyDoubleClick}
            onHover={onKeyHover}
            onHoverEnd={onKeyHoverEnd}
            scale={scale}
          />
        )
      })}
      {/* Selected key rendered last for top z-order */}
      {visibleKeys.map((key, idx) => {
        const isEncoder = key.encoderIdx >= 0
        const isSelected = isEncoder
          ? selectedEncoder?.idx === key.encoderIdx && selectedEncoder?.dir === key.encoderDir
          : selectedKey?.row === key.row && selectedKey?.col === key.col
        if (!isSelected) return null

        if (isEncoder) {
          const encKey = String(key.encoderIdx)
          const [cw, ccw] = encoderKeycodes?.get(encKey) ?? ['KC_NO', 'KC_NO']
          const kc = key.encoderDir === 0 ? cw : ccw
          return (
            <EncoderWidget
              key={`enc-${key.encoderIdx}-${key.encoderDir}-${idx}`}
              kleKey={key}
              keycode={kc}
              selected
              selectedMaskPart={selectedMaskPart}
              onClick={readOnly ? undefined : onEncoderClick}
              onDoubleClick={readOnly ? undefined : onEncoderDoubleClick}
              scale={scale}
            />
          )
        }

        const pos = posKey(key.row, key.col)
        return (
          <KeyWidget
            key={`key-${key.row}-${key.col}-${idx}`}
            kleKey={key}
            keycode={keycodes.get(pos) ?? 'KC_NO'}
            maskKeycode={maskKeycodes?.get(pos)}
            selected
            multiSelected={multiSelectedKeys?.has(pos)}
            selectedMaskPart={selectedMaskPart}
            pressed={pressedKeys?.has(pos)}
            highlighted={highlightedKeys?.has(pos)}
            everPressed={everPressedKeys?.has(pos)}
            remapped={remappedKeys?.has(pos)}
            heatmapOuterFill={outerHeatmapFillForCell(heatmapCells, heatmapMaxHold, heatmapMaxTotal, pos, effectiveTheme)}
            heatmapInnerFill={innerHeatmapFillForCell(heatmapCells, heatmapMaxTap, pos, effectiveTheme)}
            effectiveTheme={effectiveTheme}
            customFill={keyColors?.get(pos) ?? null}
            labelOverride={labelOverrides?.get(pos)}
            onClick={readOnly ? undefined : onKeyClick}
            onDoubleClick={readOnly ? undefined : onKeyDoubleClick}
            onHover={onKeyHover}
            onHoverEnd={onKeyHoverEnd}
            scale={scale}
          />
        )
      })}
    </svg>
  )
}

export const KeyboardWidget = memo(KeyboardWidgetInner)
