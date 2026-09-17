// SPDX-License-Identifier: GPL-2.0-or-later

import { memo } from 'react'
import type { MatrixWire, MatrixWireLabel, MatrixWiresLayout, MatrixWiresGutter, WirePoint } from './matrix-wires'
import { rowLabelPitch, colLabelPitch } from './matrix-wires'
import { WIRE_ROW_COLOR, WIRE_COL_COLOR, WIRE_NODE_COLOR } from './constants'

interface Props {
  layout: MatrixWiresLayout
  scale: number
  gutter: MatrixWiresGutter
}

/** One entry per wire axis — row wires/labels are drawn first, then col,
 *  matching the overlay's documented DOM order (polylines, nodes, then
 *  labels drawn in this same row-then-col order). */
const AXES: readonly { kind: 'row' | 'col'; color: string }[] = [
  { kind: 'row', color: WIRE_ROW_COLOR },
  { kind: 'col', color: WIRE_COL_COLOR },
]

function wiresFor(layout: MatrixWiresLayout, kind: 'row' | 'col'): MatrixWire[] {
  return kind === 'row' ? layout.rows : layout.cols
}

/** Turns a row label's `{ across, line }` into an SVG point: `across`
 *  (a y coordinate) is used as-is, and `line` places it within the left
 *  gutter band — the stack of lines is centered on the band's own
 *  midpoint so it grows evenly outward as more lines are needed instead
 *  of hugging one edge. */
function rowLabelPoint(label: MatrixWireLabel, layout: MatrixWiresLayout, gutter: MatrixWiresGutter): WirePoint {
  const pitch = rowLabelPitch(gutter.fontSize)
  const x = gutter.originX + gutter.left / 2 + (label.line - (layout.rowLineCount - 1) / 2) * pitch
  return { x, y: label.across }
}

/** Mirror of `rowLabelPoint` for col labels: `across` is an x coordinate,
 *  and the line stack centers within the top gutter band. */
function colLabelPoint(label: MatrixWireLabel, layout: MatrixWiresLayout, gutter: MatrixWiresGutter): WirePoint {
  const pitch = colLabelPitch(gutter.fontSize)
  const y = gutter.originY + gutter.top / 2 + (label.line - (layout.colLineCount - 1) / 2) * pitch
  return { x: label.across, y }
}

/** Renders the View Matrix wiring overlay: row wires, then col wires,
 *  then a hollow dot for every key's own node, then the row/col gutter
 *  numbers on top. Purely presentational — `buildMatrixWires` already
 *  did all the geometry (including which stacked line each label lands
 *  on), this just turns that layout into SVG. The whole group is
 *  `pointer-events-none` so it never intercepts clicks meant for the
 *  keys underneath, and `opacity-60` keeps the lines from fully
 *  obscuring the key legends they cross. */
function MatrixWiresOverlayInner({ layout, scale, gutter }: Props) {
  // Clamped so the overlay stays legible even at the editor's lowest zoom
  // (MIN_SCALE = 0.3, see keymap-editor-types.ts) instead of shrinking the
  // wires and nodes down to near-invisible.
  const strokeWidth = Math.max(0.75, scale)
  const nodeRadius = Math.max(2, 2.5 * scale)

  return (
    <g className="pointer-events-none opacity-60" data-testid="matrix-wires">
      {AXES.map((axis) =>
        wiresFor(layout, axis.kind).map((wire) =>
          wire.points.length >= 2 ? (
            <polyline
              key={`${axis.kind}-${wire.index}`}
              points={wire.points.map((p) => `${p.x},${p.y}`).join(' ')}
              stroke={axis.color}
              strokeWidth={strokeWidth}
              fill="none"
              strokeLinejoin="round"
            />
          ) : null,
        ),
      )}
      {layout.nodes.map((node) => (
        <circle
          key={node.posKey}
          cx={node.x}
          cy={node.y}
          r={nodeRadius}
          fill="none"
          stroke={WIRE_NODE_COLOR}
          strokeWidth={strokeWidth}
        />
      ))}
      {AXES.map((axis) => {
        const labelPoint = axis.kind === 'row' ? rowLabelPoint : colLabelPoint
        return wiresFor(layout, axis.kind).map((wire) =>
          wire.labels.map((label, i) => {
            const point = labelPoint(label, layout, gutter)
            return (
              <text
                key={`${axis.kind}-${wire.index}-${i}`}
                x={point.x}
                y={point.y}
                fontSize={gutter.fontSize}
                fontFamily="sans-serif"
                fill={axis.color}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {wire.index}
              </text>
            )
          }),
        )
      })}
    </g>
  )
}

export const MatrixWiresOverlay = memo(MatrixWiresOverlayInner)
