// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo, memo } from 'react'
import type { KleKey } from '../../../shared/kle/types'
import { filterVisibleKeys, repositionLayoutKeys } from '../../../shared/kle/filter-keys'
import { posKey, encoderPosKey } from '../../../shared/kle/pos-key'
import { KeyWidget } from './KeyWidget'
import { EncoderWidget } from './EncoderWidget'
import { KEY_UNIT, KEY_SPACING, KEYBOARD_PADDING, keyLabelFontSize } from './constants'
import { innerHeatmapFillForCell, outerHeatmapFillForCell } from './heatmap-fill'
import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { flashPropsFor, type KeyFlashState } from './key-flash'
import { keyCorners } from './key-geometry'
import { buildMatrixWires, rowLabelPitch, colLabelPitch } from './matrix-wires'
import { MatrixWiresOverlay } from './MatrixWiresOverlay'

/** A `data-key-pos` / `data-encoder-pos` attribute value (`"<a>,<b>"`) read
 *  back into its two numbers, or null when either side isn't one. */
function parsePosAttr(raw: string | null): [number, number] | null {
  const [a, b] = (raw ?? '').split(',').map(Number)
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null
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
  /** Flash state after a Key Label "apply to keymap" bulk rewrite or a
   *  successful undo/redo — threaded to both `KeyWidget` (`keys`) and
   *  `EncoderWidget` (`encoders`). */
  flash?: KeyFlashState
  everPressedKeys?: Set<string>
  remappedKeys?: Set<string>
  /** Encoder analogue of `remappedKeys`, keyed by `encoderPosKey(idx, dir)` —
   *  see `use-layer-keycodes.ts`'s `buildEncoderRemappedForLayer`. Colors
   *  the CW/CCW legend the pack's Rewrite touched (`EncoderWidget`'s
   *  `remapped` prop). */
  remappedEncoders?: Set<string>
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
  /** Active Key Label pack's per-key legend override — threaded straight
   *  to `KeyWidget` for masked (composite) keys' inner label (issue
   *  #295). The outer/plain label for non-masked keys is already
   *  remapped upstream in the `keycodes` map itself (`use-layer-
   *  keycodes.ts`), so this is only ever consulted for the inner path. */
  remapLabel?: (qmkId: string) => string
  onKeyClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onKeyDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  onEncoderClick?: (key: KleKey, direction: number, maskClicked: boolean) => void
  onEncoderDoubleClick?: (key: KleKey, direction: number, rect: DOMRect, maskClicked: boolean) => void
  onKeyHover?: (key: KleKey, keycode: string, rect: DOMRect) => void
  onKeyHoverEnd?: () => void
  /** Middle-click (mouse button 1) on a key delegated from the root `<svg>`
   *  — see the `auxclick`/`mousedown`/`mouseup` handlers below for why this
   *  is delegated rather than a per-`KeyWidget` prop. Gated the same way as
   *  `onKeyClick`: `readOnly` (or omitting both aux handlers) drops it. */
  onKeyAuxClick?: (pos: { row: number; col: number }) => void
  /** Encoder analogue of `onKeyAuxClick`. */
  onEncoderAuxClick?: (pos: { idx: number; dir: number }) => void
  readOnly?: boolean
  scale?: number
  /** View Matrix wiring overlay: each physical key's effective (row, col)
   *  — the View Matrix override when one exists, otherwise the physical
   *  position itself — keyed by `posKey(key.row, key.col)`. Undefined
   *  turns the overlay off entirely (no gutter, no wires, bounds
   *  identical to before this prop existed); a Map (even an empty one)
   *  turns it on. The caller (`useViewMatrixEditing`) owns building this
   *  Map — this component has no idea what View Matrix mode is. */
  matrixWires?: ReadonlyMap<string, { row: number; col: number }>
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
  flash,
  everPressedKeys,
  remappedKeys,
  remappedEncoders,
  multiSelectedKeys,
  layoutOptions,
  heatmapCells,
  heatmapMaxTotal = 0,
  heatmapMaxTap = 0,
  heatmapMaxHold = 0,
  labelOverrides,
  keyColors,
  remapLabel,
  onKeyClick,
  onKeyDoubleClick,
  onEncoderClick,
  onEncoderDoubleClick,
  onKeyHover,
  onKeyHoverEnd,
  onKeyAuxClick,
  onEncoderAuxClick,
  readOnly = false,
  scale = 1,
  matrixWires,
}: Props) {
  const effectiveTheme = useEffectiveTheme()

  // Middle-click undo is delegated on the root `<svg>` rather than wired
  // per KeyWidget/EncoderWidget: it only needs to resolve `event.target`
  // back to a position through the `data-key-pos` / `data-encoder-pos`
  // attributes those widgets already carry. `readOnly` gates it like every
  // other edit path here (`onClick={readOnly ? undefined : onKeyClick}`),
  // and it stays unwired unless the caller passed an aux handler, so a
  // preview pane never attaches middle-button listeners it has no use for.
  const auxUndoEnabled = !readOnly && (onKeyAuxClick != null || onEncoderAuxClick != null)

  // Chromium starts its Linux-style autoscroll AND (separately) its
  // PRIMARY-selection paste from the middle-button press/release, not from
  // `auxclick` — by the time `auxclick` fires both side effects have
  // already run. `mousedown` cancels the autoscroll; `mouseup` cancels the
  // paste. Left-button presses pass straight through untouched.
  const cancelMiddleButtonDefault = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button === 1) e.preventDefault()
  }

  const handleAuxClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 1) return
    const target = e.target as Element
    const keyEl = target.closest('[data-key-pos]')
    if (keyEl) {
      const pos = parsePosAttr(keyEl.getAttribute('data-key-pos'))
      if (pos) onKeyAuxClick?.({ row: pos[0], col: pos[1] })
      return
    }
    const encEl = target.closest('[data-encoder-pos]')
    if (!encEl) return
    const pos = parsePosAttr(encEl.getAttribute('data-encoder-pos'))
    if (pos) onEncoderAuxClick?.({ idx: pos[0], dir: pos[1] })
  }

  // Reposition runs on the full key list (including decals) so option 0's
  // bounding box is computed correctly; decals are dropped afterwards by
  // `filterVisibleKeys`. Mirrors `widgets/keyboard_widget.py:place_widgets` +
  // `update_layout` in vial-gui.
  const visibleKeys = useMemo(() => {
    const opts = layoutOptions ?? new Map<number, number>()
    return filterVisibleKeys(repositionLayoutKeys(keys, opts), opts)
  }, [keys, layoutOptions])

  // Same clamp KeyWidget/EncoderWidget use for their own label text, so the
  // gutter numbers read at a consistent size relative to the key legends
  // they sit next to.
  const matrixWiresFontSize = keyLabelFontSize(scale)

  // Computed before `bounds`: sizing the gutter needs to know how many
  // label lines each axis actually stacks onto (unbounded — matrix rows/
  // cols whose labels all collide keep opening new lines rather than a
  // third label landing back on top of the second), and `bounds` needs
  // that line count to size the gutter band it reserves.
  const matrixWiresLayout = useMemo(() => {
    if (!matrixWires) return null
    return buildMatrixWires(visibleKeys, matrixWires, scale, matrixWiresFontSize)
  }, [visibleKeys, matrixWires, scale, matrixWiresFontSize])

  // The label gutter only exists while the overlay is on, and each axis is
  // sized independently from the other: enough room for that axis's own
  // stacked label lines (plus one fontSize of breathing room beyond the
  // last line), or half a key unit, whichever is larger. `gutterLeft`
  // sizes the row-number gutter on the left (row labels stack
  // horizontally, using the wider row pitch); `gutterTop` sizes the
  // col-number gutter on top (col labels stack vertically, the narrower
  // col pitch). See matrix-wires.ts for the pitch values themselves.
  const gutterLeft = matrixWiresLayout
    ? Math.max(KEY_UNIT * 0.5 * scale, matrixWiresLayout.rowLineCount * rowLabelPitch(matrixWiresFontSize) + matrixWiresFontSize)
    : 0
  const gutterTop = matrixWiresLayout
    ? Math.max(KEY_UNIT * 0.5 * scale, matrixWiresLayout.colLineCount * colLabelPitch(matrixWiresFontSize) + matrixWiresFontSize)
    : 0

  // Calculate SVG bounds (track min to normalize position)
  const bounds = useMemo(() => {
    // Each axis's gutter widens the bounds symmetrically on its own two
    // sides — even though labels only ever draw into the left/top bands —
    // so the keyboard stays horizontally/vertically centered inside its
    // `justify-center` wrapper when the overlay is toggled on and off.
    const padX = KEYBOARD_PADDING + gutterLeft
    const padY = KEYBOARD_PADDING + gutterTop
    if (visibleKeys.length === 0) {
      return {
        width: padX * 2,
        height: padY * 2,
        originX: -padX,
        originY: -padY,
      }
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
      width: maxX - minX + padX * 2,
      height: maxY - minY + padY * 2,
      originX: minX - padX,
      originY: minY - padY,
    }
  }, [visibleKeys, scale, gutterLeft, gutterTop])

  return (
    <svg
      width={bounds.width}
      height={bounds.height}
      viewBox={`${bounds.originX} ${bounds.originY} ${bounds.width} ${bounds.height}`}
      className="select-none"
      onMouseDown={auxUndoEnabled ? cancelMiddleButtonDefault : undefined}
      onMouseUp={auxUndoEnabled ? cancelMiddleButtonDefault : undefined}
      onAuxClick={auxUndoEnabled ? handleAuxClick : undefined}
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
              remapped={remappedEncoders?.has(encoderPosKey(key.encoderIdx, key.encoderDir))}
              {...flashPropsFor(flash, 'encoders', encoderPosKey(key.encoderIdx, key.encoderDir))}
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
            {...flashPropsFor(flash, 'keys', pos)}
            everPressed={everPressedKeys?.has(pos)}
            remapped={remappedKeys?.has(pos)}
            heatmapOuterFill={outerHeatmapFillForCell(heatmapCells, heatmapMaxHold, heatmapMaxTotal, pos, effectiveTheme)}
            heatmapInnerFill={innerHeatmapFillForCell(heatmapCells, heatmapMaxTap, pos, effectiveTheme)}
            effectiveTheme={effectiveTheme}
            customFill={keyColors?.get(pos) ?? null}
            labelOverride={labelOverrides?.get(pos)}
            remapLabel={remapLabel}
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
              remapped={remappedEncoders?.has(encoderPosKey(key.encoderIdx, key.encoderDir))}
              {...flashPropsFor(flash, 'encoders', encoderPosKey(key.encoderIdx, key.encoderDir))}
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
            {...flashPropsFor(flash, 'keys', pos)}
            everPressed={everPressedKeys?.has(pos)}
            remapped={remappedKeys?.has(pos)}
            heatmapOuterFill={outerHeatmapFillForCell(heatmapCells, heatmapMaxHold, heatmapMaxTotal, pos, effectiveTheme)}
            heatmapInnerFill={innerHeatmapFillForCell(heatmapCells, heatmapMaxTap, pos, effectiveTheme)}
            effectiveTheme={effectiveTheme}
            customFill={keyColors?.get(pos) ?? null}
            labelOverride={labelOverrides?.get(pos)}
            remapLabel={remapLabel}
            onClick={readOnly ? undefined : onKeyClick}
            onDoubleClick={readOnly ? undefined : onKeyDoubleClick}
            onHover={onKeyHover}
            onHoverEnd={onKeyHoverEnd}
            scale={scale}
          />
        )
      })}
      {matrixWiresLayout && (
        <MatrixWiresOverlay
          layout={matrixWiresLayout}
          scale={scale}
          gutter={{
            originX: bounds.originX,
            originY: bounds.originY,
            left: gutterLeft,
            top: gutterTop,
            fontSize: matrixWiresFontSize,
          }}
        />
      )}
    </svg>
  )
}

export const KeyboardWidget = memo(KeyboardWidgetInner)
