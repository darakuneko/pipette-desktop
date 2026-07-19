// SPDX-License-Identifier: GPL-2.0-or-later

import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import type { KeyFlashState } from '../keyboard/key-flash'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingHeatmapCell } from '../../../shared/types/typing-analytics'

const PANE_CLASS = 'relative inline-block min-w-keyboard-pane rounded-xl bg-surface-alt px-5 pt-3 pb-2 border-2 border-edge-subtle'

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
  selectedEncoder: { idx: number; dir: 0 | 1 } | null
  selectedMaskPart: boolean
  selectedKeycode: string | null
  pressedKeys?: Set<string>
  everPressedKeys?: Set<string>
  remappedKeys: Set<string>
  /** Flash state after a bulk keymap rewrite or a successful undo/redo —
   *  see `KeyboardWidget`'s `flash`. */
  flash?: KeyFlashState
  multiSelectedKeys?: Set<string>
  layoutOptions: Map<number, number>
  /** Optional per-key label override keyed by `"row,col"` — used by View
   *  Matrix mode to blank out keycode legends and show each key's
   *  effective (row, col) instead. See `KeyboardWidget`'s `labelOverrides`. */
  labelOverrides?: Map<string, { outer: string; inner: string; masked: boolean }>
  /** Optional per-key background fill keyed by `"row,col"`. See
   *  `KeyboardWidget`'s `keyColors` — used by View Matrix mode to flag
   *  keys whose effective position collides with another key's. */
  keyColors?: Map<string, string>
  /** Active Key Label pack's per-key legend override — see
   *  `KeyboardWidget`'s `remapLabel`. */
  remapLabel?: (qmkId: string) => string
  heatmapCells?: Map<string, TypingHeatmapCell> | null
  heatmapMaxTotal?: number
  heatmapMaxTap?: number
  heatmapMaxHold?: number
  scale: number
  /** Current-layer label shown below the keymap. Omitted in View Matrix
   *  mode, which has no layer concept (layer switching is disabled for
   *  the mode's duration). */
  layerLabel?: string
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
  flash,
  multiSelectedKeys,
  layoutOptions,
  labelOverrides,
  keyColors,
  remapLabel,
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
          flash={flash}
          multiSelectedKeys={multiSelectedKeys}
          layoutOptions={layoutOptions}
          labelOverrides={labelOverrides}
          keyColors={keyColors}
          remapLabel={remapLabel}
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
      <div className="flex items-center justify-between px-keyboard-px text-xs leading-none text-content-muted">
        {layerLabel !== undefined && (
          <span data-testid={layerLabelTestId} className="text-content-muted">
            {layerLabel}
          </span>
        )}
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
