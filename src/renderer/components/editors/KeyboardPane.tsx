// SPDX-License-Identifier: GPL-2.0-or-later

import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'

const PANE_CLASS = 'relative inline-block min-w-[280px] rounded-xl bg-surface-alt px-5 pt-3 pb-2 border-2 border-edge-subtle'

/** Returns true when any selection-modifier key (Ctrl/Meta/Shift) is held. */
export function hasModifierKey(e: React.MouseEvent): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey
}

export interface KeyboardPaneProps {
  paneId: 'primary' | 'secondary'
  isActive: boolean
  keys: KleKey[]
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  selectedKey: { row: number; col: number } | null
  selectedEncoder: { idx: number; dir: number } | null
  selectedMaskPart: boolean
  selectedKeycode: string | null
  pressedKeys?: Set<string>
  everPressedKeys?: Set<string>
  remappedKeys: Set<string>
  multiSelectedKeys?: Set<string>
  layoutOptions: Map<number, number>
  heatmapCells?: Map<string, TypingHeatmapCell> | null
  heatmapMaxTotal?: number
  heatmapMaxTap?: number
  heatmapMaxHold?: number
  scale: number
  layerLabel: string
  layerLabelTestId: string
  onKeyClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onKeyDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  onEncoderClick?: (key: KleKey, dir: number, maskClicked: boolean) => void
  onEncoderDoubleClick?: (key: KleKey, dir: number, rect: DOMRect, maskClicked: boolean) => void
  onKeyHover?: (key: KleKey, keycode: string, rect: DOMRect) => void
  onKeyHoverEnd?: () => void
  onDeselect?: () => void
  contentRef?: React.RefObject<HTMLDivElement | null>
}

export function KeyboardPane({
  paneId,
  isActive,
  keys,
  keycodes,
  encoderKeycodes,
  selectedKey,
  selectedEncoder,
  selectedMaskPart,
  selectedKeycode,
  pressedKeys,
  everPressedKeys,
  remappedKeys,
  multiSelectedKeys,
  layoutOptions,
  heatmapCells,
  heatmapMaxTotal,
  heatmapMaxTap,
  heatmapMaxHold,
  scale,
  layerLabel,
  layerLabelTestId,
  onKeyClick,
  onKeyDoubleClick,
  onEncoderClick,
  onEncoderDoubleClick,
  onKeyHover,
  onKeyHoverEnd,
  onDeselect,
  contentRef,
}: KeyboardPaneProps) {
  return (
    <div
      ref={contentRef}
      data-testid={`${paneId}-pane`}
      className={PANE_CLASS}
      onClick={(e) => {
        e.stopPropagation()
        if (isActive && !hasModifierKey(e)) onDeselect?.()
      }}
    >
      <div className="flex justify-center">
        <KeyboardWidget
          keys={keys}
          keycodes={keycodes}
          encoderKeycodes={encoderKeycodes}
          selectedKey={isActive ? selectedKey : null}
          selectedEncoder={isActive ? selectedEncoder : null}
          selectedMaskPart={isActive ? selectedMaskPart : false}
          pressedKeys={pressedKeys}
          everPressedKeys={everPressedKeys}
          remappedKeys={remappedKeys}
          multiSelectedKeys={multiSelectedKeys}
          layoutOptions={layoutOptions}
          heatmapCells={heatmapCells}
          heatmapMaxTotal={heatmapMaxTotal}
          heatmapMaxTap={heatmapMaxTap}
          heatmapMaxHold={heatmapMaxHold}
          scale={scale}
          onKeyClick={isActive ? onKeyClick : undefined}
          onKeyDoubleClick={isActive ? onKeyDoubleClick : undefined}
          onEncoderClick={isActive ? onEncoderClick : undefined}
          onEncoderDoubleClick={isActive ? onEncoderDoubleClick : undefined}
          onKeyHover={onKeyHover}
          onKeyHoverEnd={onKeyHoverEnd}
        />
      </div>
      <div className="flex items-center justify-between px-[5px] text-xs leading-none text-content-muted">
        <span data-testid={layerLabelTestId} className="text-content-muted">
          {layerLabel}
        </span>
        <span className="flex items-center gap-1.5">
          {isActive && selectedKeycode && (
            <>
              <span>
                {selectedKey
                  ? `[${selectedKey.row},${selectedKey.col}]`
                  : `Enc ${selectedEncoder?.idx} ${selectedEncoder?.dir === 0 ? 'CW' : 'CCW'}`}
              </span>
              <span className="font-mono">{selectedKeycode}</span>
            </>
          )}
        </span>
      </div>
    </div>
  )
}
