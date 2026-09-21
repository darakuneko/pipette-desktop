// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useState } from 'react'
import {
  keycodeLabel,
  isMask,
  findOuterKeycode,
  findInnerKeycode,
} from '../../../shared/keycodes/keycodes'
import { getRemapDisplayLabel } from '../keycodes/KeycodeGrid'
import {
  KEY_UNIT,
  KEY_SPACING,
  KEY_FACE_INSET,
  KEY_ROUNDNESS,
  KEY_BG_COLOR,
  KEY_BORDER_COLOR,
  KEY_SELECTED_COLOR,
  KEY_MULTI_SELECTED_COLOR,
  KEY_PRESSED_COLOR,
  KEY_EVER_PRESSED_COLOR,
  KEY_HIGHLIGHT_COLOR,
  KEY_TEXT_COLOR,
  KEY_INVERTED_TEXT_COLOR,
  KEY_REMAP_COLOR,
  KEY_MASK_RECT_COLOR,
  KEY_HOVER_COLOR,
  keyLabelFontSize,
} from './constants'
import { shouldInvertText } from './fill-luminance'
import { computeUnionPath } from '../../../shared/kle/rect-union'
import { flashAnimationDelayMs } from './key-flash'
import type { Props } from './key-widget-types'
import { KeyFlashOverlay } from './KeyFlashOverlay'

function KeyWidgetInner({
  kleKey,
  keycode,
  maskKeycode,
  selected,
  multiSelected,
  selectedMaskPart,
  pressed,
  highlighted,
  flashed,
  flashGeneration,
  flashStartedAt,
  everPressed,
  remapped,
  heatmapOuterFill,
  heatmapInnerFill,
  customFill,
  labelOverride,
  remapLabel,
  onClick,
  onDoubleClick,
  onHover,
  onHoverEnd,
  hoverMaskParts,
  selectedFill = true,
  scale = 1,
  effectiveTheme = 'light',
}: Props) {
  const [hoveredPart, setHoveredPart] = useState<'outer' | 'inner' | null>(null)
  const s = KEY_UNIT * scale
  const spacing = KEY_SPACING * scale
  const inset = KEY_FACE_INSET * scale
  const corner = s * KEY_ROUNDNESS

  // Grid-cell rect (used for rotation center, label centering)
  const gx = s * kleKey.x
  const gy = s * kleKey.y
  const gw = s * kleKey.width - spacing
  const gh = s * kleKey.height - spacing

  // Visual key face: inset from grid cell to create breathing room (matches Python shadow)
  const x = gx + inset
  const y = gy + inset
  const w = gw - 2 * inset
  const h = gh - 2 * inset

  // Key fill color (always use theme colors, ignore KLE color overrides)
  // Priority: pressed > selected > multiSelected > highlighted > everPressed
  //           > hover > heatmap > customFill > default
  // Heatmap sits below every interactive state so the typing-view
  // overlay can never mask immediate user feedback (pressed, selection).
  // For masked keys with inner selected, use default fill (stroke-only selection)
  // `flashed` deliberately has no branch here — it's painted by a
  // separate component, KeyFlashOverlay (the `key-flash-overlay`
  // element), on top of whatever this chain resolves to, animated by a
  // declarative CSS keyframe instead of participating in this priority
  // chain.
  const masked = labelOverride?.masked ?? isMask(keycode)
  const innerSelected = selected && selectedMaskPart && masked
  let fillColor = KEY_BG_COLOR
  if (pressed) fillColor = KEY_PRESSED_COLOR
  else if (selected && !innerSelected && selectedFill) fillColor = KEY_SELECTED_COLOR
  else if (multiSelected) fillColor = KEY_MULTI_SELECTED_COLOR
  else if (highlighted) fillColor = KEY_HIGHLIGHT_COLOR
  else if (everPressed) fillColor = KEY_EVER_PRESSED_COLOR
  else if (hoverMaskParts && masked && hoveredPart === 'outer') fillColor = KEY_HOVER_COLOR
  else if (heatmapOuterFill) fillColor = heatmapOuterFill
  else if (customFill) fillColor = customFill

  // Label text color: invert when the fill is light enough to wash out
  // the default label (see `fill-luminance.ts`); otherwise pick the
  // remap tint for remapped keys and fall back to the default. While
  // flashed, the overlay covers the base fill with `KEY_SELECTED_COLOR`
  // (below the label — see KeyFlashOverlay.tsx, rendered before the label
  // in the same `<g>`), so the invert decision is made against that
  // colour instead — the same visual `selected` gets.
  const invertText = shouldInvertText(flashed ? KEY_SELECTED_COLOR : fillColor, effectiveTheme)
  let labelColor = KEY_TEXT_COLOR
  if (invertText) labelColor = KEY_INVERTED_TEXT_COLOR
  else if (remapped) labelColor = KEY_REMAP_COLOR

  // Inner rect fill + matching label colour for masked keys. The inner
  // rect's fill picks up hover/heatmap just like the outer, so its
  // label runs through the same invert decision. Remap tint mirrors the
  // outer label's priority (invert wins over remap) — `remapped` is set
  // upstream (`use-layer-keycodes.ts`) whenever either the composite
  // string itself or its inner basic keycode is affected by the active
  // pack, so this key's tap symbol getting the blue tint here stays
  // consistent with the picker's row-level tinting (#294).
  const innerFillColor =
    hoverMaskParts && hoveredPart === 'inner'
      ? KEY_HOVER_COLOR
      : heatmapInnerFill ?? KEY_MASK_RECT_COLOR
  const innerInvertText = shouldInvertText(innerFillColor, effectiveTheme)
  let innerLabelColor = KEY_TEXT_COLOR
  if (innerInvertText) innerLabelColor = KEY_INVERTED_TEXT_COLOR
  else if (remapped) innerLabelColor = KEY_REMAP_COLOR

  // Label
  const outerLabel = labelOverride?.outer ?? keycodeLabel(keycode)
  // A pack practically only ever remaps the plain inner basic keycode,
  // not the full composite string (that would take an explicit
  // compositeLabels override, which already wins upstream by replacing
  // `keycode` itself with non-mask-shaped text before this component
  // ever sees it — see `use-layer-keycodes.ts`). So this only needs to
  // resolve the inner basic keycode's own remap; `getRemapDisplayLabel`
  // (same helper the picker/grid already use, not re-derived) falls
  // back to the current unremapped behaviour whenever `remapLabel` is
  // absent or the inner keycode isn't affected by the pack (issue #295).
  const innerQmkId = findInnerKeycode(keycode)?.qmkId ?? ''
  const innerLabel = maskKeycode
    ? keycodeLabel(maskKeycode)
    : labelOverride
      ? labelOverride.inner
      : masked
        ? getRemapDisplayLabel(innerQmkId, remapLabel) ?? keycodeLabel(innerQmkId)
        : ''

  // Text rendering: split by \n. Layout is part-count driven —
  //   1 part : centered
  //   2 parts: top / bottom (legacy "(\n8" style)
  //   3 parts: three horizontal slices
  //   4 parts: 2 × 2 quadrants (TL, TR, BL, BR; "" leaves a slot empty)
  // Excess parts beyond 4 are dropped — the layout has no slot for them.
  const labelLines = outerLabel.split('\n').slice(0, 4)
  const fontSize = keyLabelFontSize(scale)

  // Rotation transform
  const hasRotation = kleKey.rotation !== 0
  const rotX = s * kleKey.rotationX
  const rotY = s * kleKey.rotationY

  // Union path for stepped/ISO keys (two overlapping rects merged into one outline)
  const hasSecondRect =
    kleKey.width2 !== kleKey.width ||
    kleKey.height2 !== kleKey.height ||
    kleKey.x2 !== 0 ||
    kleKey.y2 !== 0
  const gx2 = gx + s * kleKey.x2
  const gy2 = gy + s * kleKey.y2
  const gw2 = s * kleKey.width2 - spacing
  const gh2 = s * kleKey.height2 - spacing
  const unionPath = hasSecondRect
    ? computeUnionPath(gx, gy, gw, gh, gx2, gy2, gw2, gh2, corner, inset)
    : ''

  // Inner rect geometry for masked keys (inset on all sides)
  const innerPad = 2 * scale
  const innerX = x + innerPad
  const innerY = y + h * 0.4 + innerPad
  const innerW = Math.max(0, w - innerPad * 2)
  const innerH = Math.max(0, h * 0.6 - innerPad * 2)
  const innerCorner = corner * 0.8

  // Border state: outer gets accent only when outer is selected,
  // inner rect gets accent only when inner is selected
  const outerBorderActive = selected && !innerSelected
  const innerBorderActive = !!innerSelected
  const isClickable = !kleKey.decal && !!(onClick || onDoubleClick)

  // Stroke color and width for outer key rects
  let outerStroke = KEY_BORDER_COLOR
  let outerStrokeWidth = 1
  if (outerBorderActive) {
    outerStroke = KEY_SELECTED_COLOR
    outerStrokeWidth = 2
  } else if (multiSelected) {
    outerStroke = KEY_MULTI_SELECTED_COLOR
    outerStrokeWidth = 2
  }

  const handleClick = (e: React.MouseEvent) => {
    if (onClick && isClickable) {
      e.stopPropagation()
      onClick(kleKey, false, { ctrlKey: e.ctrlKey || e.metaKey, shiftKey: e.shiftKey })
    }
  }

  const handleInnerClick = (e: React.MouseEvent) => {
    if (onClick && isClickable) {
      e.stopPropagation()
      onClick(kleKey, true, { ctrlKey: e.ctrlKey || e.metaKey, shiftKey: e.shiftKey })
    }
  }

  const handleDoubleClick = (e: React.MouseEvent<SVGGElement>) => {
    if (onDoubleClick && isClickable) {
      onDoubleClick(kleKey, e.currentTarget.getBoundingClientRect(), false)
    }
  }

  const handleInnerDoubleClick = (e: React.MouseEvent<SVGRectElement>) => {
    e.stopPropagation()
    if (onDoubleClick && isClickable) {
      const g = e.currentTarget.closest('g')
      const rect = g ? g.getBoundingClientRect() : e.currentTarget.getBoundingClientRect()
      onDoubleClick(kleKey, rect, true)
    }
  }

  const groupTransform = hasRotation
    ? `translate(${rotX}, ${rotY}) rotate(${kleKey.rotation}) translate(${-rotX}, ${-rotY})`
    : undefined

  // How far into the shared `key-flash` timeline this overlay is joining.
  // Computed once at render (a re-render is guaranteed at mount; the
  // animation runs off CSS afterwards, so no ticking timer is needed).
  // Fed to KeyFlashOverlay's `animation-delay` style as a NEGATIVE value —
  // that starts the CSS animation already partway through, so an overlay
  // mounted late (e.g. a layer switch revealing a different rewritten
  // position mid-window) shows the correct mid-fade opacity immediately
  // and finishes at the same wall-clock moment as every other overlay
  // from this same flash, instead of restarting its own fade from full
  // opacity.
  const flashElapsedMs = flashed && flashStartedAt !== undefined
    ? flashAnimationDelayMs(flashStartedAt)
    : 0

  return (
    <g
      transform={groupTransform}
      data-key-pos={kleKey.row >= 0 && kleKey.col >= 0 ? `${kleKey.row},${kleKey.col}` : undefined}
      data-pressed={pressed ? 'true' : undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={(e) => {
        if (hoverMaskParts && masked) setHoveredPart('outer')
        if (onHover && isClickable) {
          const rect = (e.currentTarget as SVGGElement).getBoundingClientRect()
          onHover(kleKey, keycode, rect)
        }
      }}
      onMouseLeave={() => {
        if (hoverMaskParts && masked) setHoveredPart(null)
        onHoverEnd?.()
      }}
      style={isClickable ? { cursor: 'pointer' } : undefined}
    >
      {/* Key shape: unified path for ISO/stepped keys, simple rect for normal */}
      {unionPath ? (
        <path
          d={unionPath}
          fill={fillColor}
          stroke={outerStroke}
          strokeWidth={outerStrokeWidth}
        />
      ) : (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={corner}
          ry={corner}
          fill={fillColor}
          stroke={outerStroke}
          strokeWidth={outerStrokeWidth}
        />
      )}

      {flashed && (
        <KeyFlashOverlay
          flashed={flashed}
          unionPath={unionPath}
          flashGeneration={flashGeneration}
          x={x}
          y={y}
          w={w}
          h={h}
          corner={corner}
          flashElapsedMs={flashElapsedMs}
          outerStroke={outerStroke}
          outerStrokeWidth={outerStrokeWidth}
        />
      )}

      {/* Inner rect for masked keys */}
      {masked && innerW > 0 && innerH > 0 && (
        <rect
          data-testid="mask-inner-rect"
          x={innerX}
          y={innerY}
          width={innerW}
          height={innerH}
          rx={innerCorner}
          ry={innerCorner}
          fill={innerFillColor}
          stroke={innerBorderActive ? KEY_SELECTED_COLOR : KEY_BORDER_COLOR}
          strokeWidth={innerBorderActive ? 2 : 1}
          onClick={handleInnerClick}
          onDoubleClick={handleInnerDoubleClick}
          onMouseEnter={hoverMaskParts ? () => setHoveredPart('inner') : undefined}
          onMouseLeave={hoverMaskParts ? () => setHoveredPart('outer') : undefined}
        />
      )}

      {/* Key label */}
      {masked ? (
        <>
          {/* Outer (modifier) label — top portion. Only the first two
              `\n` parts are honoured: a 4-part label like "1\n2\n3\n4"
              would collide with the inner rect (which sits in the
              bottom half), so parts 3+ are intentionally dropped. */}
          {(() => {
            const rawOuter = labelOverride
              ? labelOverride.outer
              : keycodeLabel(findOuterKeycode(keycode)?.qmkId ?? keycode).replace(/\n?\(kc\)$/, '')
            const outerParts = rawOuter.split('\n').slice(0, 2)
            if (outerParts.length === 2) {
              return outerParts.map((part, i) => (
                <text
                  key={i}
                  x={x + w * (i === 0 ? 0.25 : 0.75)}
                  y={y + h * 0.25}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={labelColor}
                  fontSize={fontSize * 0.85}
                  fontFamily="sans-serif"
                  style={{ pointerEvents: 'none' }}
                >
                  {part}
                </text>
              ))
            }
            return (
              <text
                x={x + w / 2}
                y={y + h * 0.25}
                textAnchor="middle"
                dominantBaseline="central"
                fill={labelColor}
                fontSize={fontSize * 0.85}
                fontFamily="sans-serif"
                style={{ pointerEvents: 'none' }}
              >
                {outerParts[0] ?? ''}
              </text>
            )
          })()}
          {/* Inner (base) label - inverts when the inner rect fill is
              light enough to wash the default label out. A shift+base
              pair ("(\n8") stacks vertically — shifted char on top,
              base below — matching Vial's convention (and `SplitKey`'s
              own base/shifted split elsewhere in the picker) instead of
              cramming both onto one line ("issue #296"). A single part
              renders centered as before; parts beyond 2 are dropped —
              same "excess parts have no slot" convention the outer
              label's own 2-part branch above already documents. */}
          {(() => {
            const innerParts = innerLabel.split('\n').slice(0, 2)
            if (innerParts.length === 2) {
              return innerParts.map((part, i) => (
                <text
                  key={i}
                  x={x + w / 2}
                  y={innerY + innerH * (i === 0 ? 0.3 : 0.7)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={innerLabelColor}
                  fontSize={fontSize * 0.7}
                  fontFamily="sans-serif"
                  style={{ pointerEvents: 'none' }}
                >
                  {part}
                </text>
              ))
            }
            return (
              <text
                x={x + w / 2}
                y={innerY + innerH / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill={innerLabelColor}
                fontSize={fontSize * 0.85}
                fontFamily="sans-serif"
                style={{ pointerEvents: 'none' }}
              >
                {innerParts[0] ?? ''}
              </text>
            )
          })()}
        </>
      ) : labelLines.length === 4 ? (
        // 2 × 2 quadrant layout. Empty strings leave the slot blank so
        // "1\n2\n\n4" renders the bottom-left empty without affecting
        // the other three positions.
        labelLines.map((line, i) => {
          const col = i % 2
          const row = Math.floor(i / 2)
          return (
            <text
              key={i}
              x={x + w * (col === 0 ? 0.25 : 0.75)}
              y={y + h * (row === 0 ? 0.33 : 0.67)}
              textAnchor="middle"
              dominantBaseline="central"
              fill={labelColor}
              fontSize={fontSize * 0.85}
              fontFamily="sans-serif"
            >
              {line}
            </text>
          )
        })
      ) : (
        labelLines.map((line, i) => (
          <text
            key={i}
            x={x + w / 2}
            y={y + (h / (labelLines.length + 1)) * (i + 1)}
            textAnchor="middle"
            dominantBaseline="central"
            fill={labelColor}
            fontSize={fontSize}
            fontFamily="sans-serif"
          >
            {line}
          </text>
        ))
      )}
    </g>
  )
}

export const KeyWidget = memo(KeyWidgetInner)
