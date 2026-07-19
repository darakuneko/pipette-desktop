// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useId } from 'react'
import { keycodeLabel, isMask, findInnerKeycode } from '../../../shared/keycodes/keycodes'
import type { KleKey } from '../../../shared/kle/types'
import {
  KEY_UNIT,
  KEY_SPACING,
  KEY_BG_COLOR,
  KEY_BORDER_COLOR,
  KEY_SELECTED_COLOR,
  KEY_TEXT_COLOR,
  KEY_INVERTED_TEXT_COLOR,
  KEY_MASK_RECT_COLOR,
} from './constants'
import { flashAnimationDelayMs } from './key-flash'

interface Props {
  kleKey: KleKey
  keycode: string
  selected?: boolean
  selectedMaskPart?: boolean
  /** True for one beat right after a bulk keymap rewrite (Key Label
   *  "apply to keymap") or an undo/redo lands on this encoder position.
   *  Mirrors `KeyWidget`'s `flashed` — renders an extra overlay (same fill
   *  as `selected`, `KEY_SELECTED_COLOR`) on top of the encoder's normal
   *  fill, fading via the declarative `key-flash` CSS keyframe (style.css)
   *  once the caller clears the flag. */
  flashed?: boolean
  /** Bumped by the caller on every successful apply (`KeyFlashState.generation`
   *  in `KeyboardWidget`). Used as the overlay element's React `key` so a
   *  re-apply mid-flash remounts (and thus restarts) the overlay. */
  flashGeneration?: number
  /** `Date.now()` at the apply that produced this flash (`KeyFlashState.startedAt`).
   *  Used to compute a negative `animation-delay` so a late-mounted overlay
   *  joins the same global fade timeline instead of restarting from full
   *  opacity. */
  flashStartedAt?: number
  onClick?: (key: KleKey, direction: number, maskClicked: boolean) => void
  onDoubleClick?: (key: KleKey, direction: number, rect: DOMRect, maskClicked: boolean) => void
  scale?: number
}

function EncoderWidgetInner({
  kleKey,
  keycode,
  selected,
  selectedMaskPart,
  flashed,
  flashGeneration,
  flashStartedAt,
  onClick,
  onDoubleClick,
  scale = 1,
}: Props) {
  const clipId = useId()
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale

  const x = s * kleKey.x
  const y = s * kleKey.y
  const w = s * kleKey.width - spacing
  const h = s * kleKey.height - spacing
  const r = Math.min(w, h) / 2
  const cx = x + w / 2
  const cy = y + h / 2

  const masked = isMask(keycode)
  const innerSelected = selected && selectedMaskPart && masked
  const fillColor = selected && !innerSelected ? KEY_SELECTED_COLOR : KEY_BG_COLOR
  const labelColor = selected && !innerSelected ? KEY_INVERTED_TEXT_COLOR : KEY_TEXT_COLOR
  const fontSize = Math.max(8, Math.min(12, 12 * scale))
  const outerBorderActive = selected && !innerSelected

  // Rotation transform
  const hasRotation = kleKey.rotation !== 0
  const rotX = s * kleKey.rotationX
  const rotY = s * kleKey.rotationY
  const groupTransform = hasRotation
    ? `translate(${rotX}, ${rotY}) rotate(${kleKey.rotation}) translate(${-rotX}, ${-rotY})`
    : undefined

  const handleClick = (e: React.MouseEvent) => {
    if (onClick) { e.stopPropagation(); onClick(kleKey, kleKey.encoderDir, false) }
  }

  const handleDoubleClick = (e: React.MouseEvent<SVGGElement>) => {
    if (onDoubleClick) { e.stopPropagation(); onDoubleClick(kleKey, kleKey.encoderDir, e.currentTarget.getBoundingClientRect(), false) }
  }

  // How far into the shared `key-flash` timeline this overlay is joining —
  // same negative `animation-delay` trick as `KeyWidget` (see there for
  // the full rationale).
  const flashElapsedMs = flashed && flashStartedAt !== undefined
    ? flashAnimationDelayMs(flashStartedAt)
    : 0

  if (!masked) {
    const labelLines = keycodeLabel(keycode).split('\n')
    return (
      <g transform={groupTransform} onClick={handleClick} onDoubleClick={handleDoubleClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
        <circle cx={cx} cy={cy} r={r} fill={fillColor}
          stroke={outerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR} strokeWidth={outerBorderActive ? 2 : 1} />
        {/* Flash overlay (Key Label "apply to keymap" rewrite / undo/redo):
            painted on top of the outer fill/stroke above but below the
            label text, mirroring `KeyWidget`'s `key-flash-overlay`. */}
        {flashed && (
          <circle
            key={flashGeneration}
            cx={cx} cy={cy} r={r}
            data-testid="flash-overlay"
            className="key-flash-overlay"
            fill={KEY_SELECTED_COLOR}
            style={{ pointerEvents: 'none', animationDelay: `-${flashElapsedMs}ms` }}
          />
        )}
        {/* Border redraw: the overlay above paints its opaque fill on top
            of the outer stroke too, so redraw a stroke-only copy on top to
            keep the border crisp for the whole flash (mirrors `KeyWidget`'s
            `flash-overlay-border`). */}
        {flashed && (
          <circle
            cx={cx} cy={cy} r={r}
            data-testid="flash-overlay-border"
            fill="none"
            stroke={outerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR}
            strokeWidth={outerBorderActive ? 2 : 1}
            style={{ pointerEvents: 'none' }}
          />
        )}
        {labelLines.map((line, i) => (
          <text key={i} x={cx} y={cy + (i - (labelLines.length - 1) / 2) * (fontSize + 2)}
            textAnchor="middle" dominantBaseline="central" fill={labelColor} fontSize={fontSize} fontFamily="sans-serif">
            {line}
          </text>
        ))}
      </g>
    )
  }

  // --- Masked: split display with inner rect clipped to circle ---
  const outerLabel = keycodeLabel(keycode).split('\n')[0]
  const innerLabel = keycodeLabel(findInnerKeycode(keycode)?.qmkId ?? '').split('\n')[0]
  const innerBorderActive = !!innerSelected

  // Inner rect: bottom 50% of circle, fully inside the circle
  const innerRectW = r * 1.4
  const innerRectH = r * 0.7
  const innerRectX = cx - innerRectW / 2
  const innerRectY = cy + r * 0.05
  const innerCorner = r * 0.2

  const outerLabelY = cy - r * 0.35
  const innerLabelY = innerRectY + innerRectH / 2

  const handleInnerClick = (e: React.MouseEvent) => {
    if (onClick) { e.stopPropagation(); onClick(kleKey, kleKey.encoderDir, true) }
  }
  const handleInnerDoubleClick = (e: React.MouseEvent<SVGRectElement>) => {
    e.stopPropagation()
    if (onDoubleClick) {
      const g = e.currentTarget.closest('g')
      const rect = g ? g.getBoundingClientRect() : e.currentTarget.getBoundingClientRect()
      onDoubleClick(kleKey, kleKey.encoderDir, rect, true)
    }
  }

  return (
    <g transform={groupTransform} onClick={handleClick} onDoubleClick={handleDoubleClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <defs>
        <clipPath id={clipId}>
          <circle cx={cx} cy={cy} r={r - 1} />
        </clipPath>
      </defs>
      {/* Outer circle */}
      <circle cx={cx} cy={cy} r={r} fill={fillColor}
        stroke={outerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR} strokeWidth={outerBorderActive ? 2 : 1} />
      {/* Flash overlay + border redraw: painted above the outer circle but
          below the inner mask rect and labels (both rendered below), same
          stacking as the non-masked branch and `KeyWidget`'s masked keys —
          the inner rect and its label stay visible on top of the overlay. */}
      {flashed && (
        <circle
          key={flashGeneration}
          cx={cx} cy={cy} r={r}
          data-testid="flash-overlay"
          className="key-flash-overlay"
          fill={KEY_SELECTED_COLOR}
          style={{ pointerEvents: 'none', animationDelay: `-${flashElapsedMs}ms` }}
        />
      )}
      {flashed && (
        <circle
          cx={cx} cy={cy} r={r}
          data-testid="flash-overlay-border"
          fill="none"
          stroke={outerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR}
          strokeWidth={outerBorderActive ? 2 : 1}
          style={{ pointerEvents: 'none' }}
        />
      )}
      {/* Inner rect clipped to circle — same style as KeyWidget (stroke-only selection) */}
      <rect x={innerRectX} y={innerRectY} width={innerRectW} height={innerRectH}
        rx={innerCorner} ry={innerCorner}
        fill={KEY_MASK_RECT_COLOR}
        stroke={innerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR} strokeWidth={innerBorderActive ? 2 : 1}
        clipPath={`url(#${clipId})`}
        onClick={handleInnerClick} onDoubleClick={handleInnerDoubleClick} style={{ cursor: onClick ? 'pointer' : 'default' }} />
      {/* Outer label (modifier) */}
      <text x={cx} y={outerLabelY} textAnchor="middle" dominantBaseline="central"
        fill={labelColor} fontSize={fontSize * 0.85} fontFamily="sans-serif" style={{ pointerEvents: 'none' }}>
        {outerLabel}
      </text>
      {/* Inner label (basic key) */}
      <text x={cx} y={innerLabelY} textAnchor="middle" dominantBaseline="central"
        fill={KEY_TEXT_COLOR} fontSize={fontSize} fontFamily="sans-serif" style={{ pointerEvents: 'none' }}>
        {innerLabel}
      </text>
    </g>
  )
}

export const EncoderWidget = memo(EncoderWidgetInner)
