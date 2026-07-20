// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
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
  /** Encoder analogue of `remappedKeys` — see `KeyboardWidget`'s
   *  `remappedEncoders`. */
  remappedEncoders?: Set<string>
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
   *  the mode's duration). Always the plain label (e.g. "Layer 0") — the
   *  "Preview - " prefix is composed internally from `preview`, not baked
   *  in by the caller, so every call site keeps computing the same raw
   *  string regardless of which pane it feeds. */
  layerLabel?: string
  layerLabelTestId: string
  /** True only for the simulation tab's pane: the keymap shown is a
   *  read-only preview of the selected Key Label pack's arrangement, not
   *  the real keymap (see `readOnly`, which this is deliberately kept
   *  separate from — `readOnly` also covers View Matrix and other
   *  non-editable states that are NOT a pack preview and must not get
   *  this label). Prefixes `layerLabel` with a localized "Preview - "
   *  via `editor.keymap.layerPreview` so the footer makes the distinction
   *  obvious without the user having to notice which tab is active. */
  preview?: boolean
  /** Extra content rendered next to `layerLabel` in the footer row — the
   *  simulation tab's Apply button (Plan-qwerty-select-no-rewrite v7). */
  footerExtra?: React.ReactNode
  /** Blocks every edit path into this pane: no key/encoder click or
   *  double-click handlers reach `KeyboardWidget` regardless of what's
   *  passed in `onKeyClick`/etc below (see `KeyboardWidget`'s own
   *  `readOnly`). Used by the simulation tab, which must stay completely
   *  view-only — clicks, the popover, and multi-select all route through
   *  those same handlers, so gating them here is the single choke point. */
  readOnly?: boolean
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
  remappedEncoders,
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
  preview = false,
  footerExtra,
  readOnly = false,
  onKeyClick,
  onKeyDoubleClick,
  onEncoderClick,
  onEncoderDoubleClick,
  onKeyHover,
  onKeyHoverEnd,
  onDeselect,
  contentRef,
}: KeyboardPaneProps) {
  const { t } = useTranslation()
  return (
    <div
      ref={contentRef}
      data-testid={`${paneId}-pane`}
      className={PANE_CLASS}
      onClick={(e) => {
        e.stopPropagation()
        if (isActive && !readOnly && !hasModifierKey(e)) onDeselect?.()
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
          remappedEncoders={remappedEncoders}
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
          readOnly={readOnly}
          onKeyClick={isActive ? onKeyClick : undefined}
          onKeyDoubleClick={isActive ? onKeyDoubleClick : undefined}
          onEncoderClick={isActive ? onEncoderClick : undefined}
          onEncoderDoubleClick={isActive ? onEncoderDoubleClick : undefined}
          onKeyHover={onKeyHover}
          onKeyHoverEnd={onKeyHoverEnd}
        />
      </div>
      {/* Two cells, not three: `footerExtra` (the simulation tab's Apply
          button) and the selected-keycode info never render at the same
          time — the pack-tab `KeyboardPane` that passes `footerExtra`
          always passes `selectedKeycode={null}` (no selection props at
          all on that read-only pane), and the normal/base-tab pane that
          has a live selection never passes `footerExtra`. So they share
          the right-hand cell rather than each owning a separate grid
          column; whichever is present renders flush against the right
          edge, matching the empty space that cell has whenever the other
          isn't there. `justify-between` reproduces the old left/right
          grid edges with plain flex, and the row's height still grows to
          fully contain the button — no overflow past the panel's border
          (Plan-qwerty-select-no-rewrite v7 UI refinement). */}
      <div className="flex items-center justify-between px-keyboard-px text-xs leading-none text-content-muted">
        <span className="flex items-center gap-2">
          {layerLabel !== undefined && (
            <span data-testid={layerLabelTestId} className="text-content-muted">
              {preview ? t('editor.keymap.layerPreview', { label: layerLabel }) : layerLabel}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {footerExtra}
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
