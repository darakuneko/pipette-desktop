// SPDX-License-Identifier: GPL-2.0-or-later

import { memo } from 'react'
import type { MatrixWiresLayout } from './matrix-wires'

interface Props {
  layout: MatrixWiresLayout
  scale: number
  fontSize: number
}

/** Renders the View Matrix wiring overlay: row wires, then col wires,
 *  then a hollow dot for every key's own node, then the row/col gutter
 *  numbers on top. Purely presentational — `buildMatrixWires` already
 *  did all the geometry, this just turns that layout into SVG. The
 *  whole group is `pointer-events-none` so it never intercepts clicks
 *  meant for the keys underneath, and `opacity-60` keeps the lines from
 *  fully obscuring the key legends they cross. */
function MatrixWiresOverlayInner({ layout, scale, fontSize }: Props) {
  const strokeWidth = 1 * scale
  const nodeRadius = 2.5 * scale

  return (
    <g className="pointer-events-none opacity-60" data-testid="matrix-wires">
      {layout.rows.map((wire) =>
        wire.points.length >= 2 ? (
          <polyline
            key={`row-${wire.index}`}
            points={wire.points.map((p) => `${p.x},${p.y}`).join(' ')}
            stroke="var(--wire-row)"
            strokeWidth={strokeWidth}
            fill="none"
            strokeLinejoin="round"
          />
        ) : null,
      )}
      {layout.cols.map((wire) =>
        wire.points.length >= 2 ? (
          <polyline
            key={`col-${wire.index}`}
            points={wire.points.map((p) => `${p.x},${p.y}`).join(' ')}
            stroke="var(--wire-col)"
            strokeWidth={strokeWidth}
            fill="none"
            strokeLinejoin="round"
          />
        ) : null,
      )}
      {layout.nodes.map((node) => (
        <circle
          key={node.posKey}
          cx={node.x}
          cy={node.y}
          r={nodeRadius}
          fill="none"
          stroke="var(--content-secondary)"
          strokeWidth={strokeWidth}
        />
      ))}
      {layout.rows.map((wire) => (
        <text
          key={`row-${wire.index}`}
          x={wire.label.x}
          y={wire.label.y}
          fontSize={fontSize}
          fontFamily="sans-serif"
          fill="var(--wire-row)"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {wire.index}
        </text>
      ))}
      {layout.cols.map((wire) => (
        <text
          key={`col-${wire.index}`}
          x={wire.label.x}
          y={wire.label.y}
          fontSize={fontSize}
          fontFamily="sans-serif"
          fill="var(--wire-col)"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {wire.index}
        </text>
      ))}
    </g>
  )
}

export const MatrixWiresOverlay = memo(MatrixWiresOverlayInner)
