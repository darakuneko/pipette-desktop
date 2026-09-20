// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, type RefObject } from 'react'
import { KeyboardPane } from './KeyboardPane'
import { KeymapPackTabs, KeymapPackApplyButton, type KeymapPackTab } from './KeymapPackTabs'
import type { KleKey } from '../../../shared/kle/types'
import type { KeyFlashState } from '../keyboard/key-flash'
import type { UseViewMatrixModeReturn } from './useViewMatrixMode'

/** The two middle-click undo handlers, bundled so call sites thread a
 *  single field — see `KeyboardWidget`'s `onKeyAuxClick`/`onEncoderAuxClick`
 *  for what each one receives. */
export interface KeymapAuxUndoHandlers {
  onKeyAuxClick: (pos: { row: number; col: number }) => void
  onEncoderAuxClick: (pos: { idx: number; dir: number }) => void
}

/** Whether `pos` is the single currently selected key — the extra gate
 *  middle-click undo applies on top of the history-stack-top match
 *  `auxUndoHandlers` already does. Hovering an unselected key and
 *  middle-clicking it must never touch that key's history. */
function isSelectedKeyPos(selectedKey: { row: number; col: number } | null, pos: { row: number; col: number }): boolean {
  return selectedKey != null && selectedKey.row === pos.row && selectedKey.col === pos.col
}

/** Encoder analogue of `isSelectedKeyPos`. */
function isSelectedEncoderPos(selectedEncoder: { idx: number; dir: 0 | 1 } | null, pos: { idx: number; dir: number }): boolean {
  return selectedEncoder != null && selectedEncoder.idx === pos.idx && selectedEncoder.dir === pos.dir
}

export interface KeymapPrimaryPaneProps {
  showPackTabs: boolean
  packTab: KeymapPackTab
  keys: KleKey[]
  layerKeycodes: Map<string, string>
  layerEncoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  layerEncoderRemapped: Set<string>
  matrixMode: boolean
  pressedKeys: Set<string>
  everPressedKeys: Set<string>
  layoutOptions: Map<number, number>
  scale: number
  remapLabel?: (qmkId: string) => string
  /** `layerLabel(currentLayer)` computed once by the caller — the same
   *  value both branches below need (the pack-tab branch always shows it;
   *  the no-tabs/Base branch only while View Matrix mode is off). */
  currentLayerLabel: string
  /** Raw inputs for the simulation tab's own Apply button (`footerExtra`
   *  below) — built here, where its only consumer lives, rather than
   *  constructed unconditionally by the caller and discarded whenever
   *  this pane isn't even on the pack tab. */
  onRequestKeymapApply?: () => void
  keymapApplyBusy?: boolean
  keymapApplyError?: string | null
  contentRef?: RefObject<HTMLDivElement | null>
  primaryKeycodes: Map<string, string>
  primaryEncoderKeycodes: Map<string, [string, string]>
  selectedKey: { row: number; col: number } | null
  selectedEncoder: { idx: number; dir: 0 | 1 } | null
  selectedMaskPart: boolean
  selectedKeycode: string | null
  primaryRemappedKeys: Set<string>
  primaryRemappedEncoders: Set<string>
  flash?: KeyFlashState
  viewMatrixMode: UseViewMatrixModeReturn
  multiSelectedKeys: Set<string>
  viewMatrixLabelOverrides?: Map<string, { outer: string; inner: string; masked: boolean }>
  viewMatrixDuplicateKeyColors?: Map<string, string>
  primaryRemapLabel?: (qmkId: string) => string
  /** View Matrix wiring overlay — see `KeyboardWidget`'s `matrixWires`.
   *  Only reaches the normal/Base `KeyboardPane` branch below; the pack
   *  simulation preview branch never receives it. */
  matrixWires?: ReadonlyMap<string, { row: number; col: number }>
  /** Middle-click undo handlers. Reaches the normal/Base `KeyboardPane`
   *  branch only, never the pack simulation preview branch (which is
   *  `readOnly` and takes no selection props at all). The caller omits
   *  this entirely while View Matrix mode is active. Wrapped below with
   *  `isSelectedKeyPos`/`isSelectedEncoderPos` before being handed to
   *  `KeyboardPane` — middle-click only fires these for the currently
   *  selected key/encoder, never for a merely hovered one. */
  auxUndoHandlers?: KeymapAuxUndoHandlers
  handleViewMatrixKeyClick: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  handleKeyClick: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  handleKeyDoubleClick: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  handleEncoderClick: (key: KleKey, dir: number, maskClicked: boolean) => void
  handleEncoderDoubleClick: (key: KleKey, dir: number, rect: DOMRect, maskClicked: boolean) => void
  handleDeselect: () => void
  handlePackTabChange: (tab: KeymapPackTab) => void
  keymapPackName?: string
}

/** The dual `KeyboardPane` branches (simulation-tab preview vs. the real,
 *  fully editable pane — JIS/QWERTY/typing-test-adjacent states, and the
 *  Base tab reusing the exact same branch with swapped-in raw data) plus
 *  the vertical `KeymapPackTabs` strip attached flush to the pane's edge.
 *  Lives inside `KeymapEditor`'s `keymap-surface` container — only one of
 *  the two `<KeyboardPane>`s below ever renders at a time. */
export function KeymapPrimaryPane({
  showPackTabs, packTab, keys, layerKeycodes, layerEncoderKeycodes, remappedKeys, layerEncoderRemapped,
  matrixMode, pressedKeys, everPressedKeys, layoutOptions, scale, remapLabel, currentLayerLabel,
  onRequestKeymapApply, keymapApplyBusy, keymapApplyError, contentRef, primaryKeycodes, primaryEncoderKeycodes,
  selectedKey, selectedEncoder, selectedMaskPart, selectedKeycode,
  primaryRemappedKeys, primaryRemappedEncoders, flash, viewMatrixMode, multiSelectedKeys,
  viewMatrixLabelOverrides, viewMatrixDuplicateKeyColors, primaryRemapLabel, matrixWires, auxUndoHandlers,
  handleViewMatrixKeyClick, handleKeyClick, handleKeyDoubleClick, handleEncoderClick, handleEncoderDoubleClick,
  handleDeselect, handlePackTabChange, keymapPackName,
}: KeymapPrimaryPaneProps): JSX.Element {
  // Middle-click only undoes the key/encoder the user has actually
  // selected — a stray middle click while merely hovering an unselected
  // key must never change it. `auxUndoHandlers` itself still does the
  // history-stack-top match; this gate runs first and simply drops the
  // call through when the clicked position isn't the current selection.
  const onKeyAuxClick = useCallback((pos: { row: number; col: number }) => {
    if (isSelectedKeyPos(selectedKey, pos)) auxUndoHandlers?.onKeyAuxClick(pos)
  }, [auxUndoHandlers, selectedKey])
  const onEncoderAuxClick = useCallback((pos: { idx: number; dir: number }) => {
    if (isSelectedEncoderPos(selectedEncoder, pos)) auxUndoHandlers?.onEncoderAuxClick(pos)
  }, [auxUndoHandlers, selectedEncoder])
  return (
    <div className="flex items-stretch">
      {showPackTabs && packTab === 'pack' ? (
        // Simulation pane: display data only — no selection props,
        // no click/double-click/deselect handlers at all. `readOnly`
        // (always `true` here, not a ternary) already makes
        // `KeyboardWidget` null out every handler it's given
        // regardless, and `KeyboardPane`'s own deselect-on-
        // background-click checks `!readOnly` too — omitting the
        // handlers here as well means read-only holds by
        // construction, not by three separate `packTab === 'pack'`
        // checks that could drift out of sync.
        <KeyboardPane
          paneId="primary" isActive={true}
          keys={keys} keycodes={layerKeycodes} encoderKeycodes={layerEncoderKeycodes}
          selectedKey={null} selectedEncoder={null} selectedMaskPart={false} selectedKeycode={null}
          pressedKeys={matrixMode ? pressedKeys : undefined} everPressedKeys={matrixMode ? everPressedKeys : undefined}
          remappedKeys={remappedKeys} remappedEncoders={layerEncoderRemapped}
          layoutOptions={layoutOptions} scale={scale}
          remapLabel={remapLabel}
          layerLabel={currentLayerLabel} layerLabelTestId="layer-label"
          preview
          footerExtra={
            <KeymapPackApplyButton
              onRequestKeymapApply={onRequestKeymapApply}
              keymapApplyBusy={keymapApplyBusy}
              keymapApplyError={keymapApplyError}
            />
          }
          readOnly
          contentRef={contentRef}
        />
      ) : (
        // Also the "no tabs" pane (JIS/QWERTY/typing-test-adjacent
        // states) — the `showPackTabs && packTab === 'base'`
        // case reuses this exact block rather than a second copy,
        // swapping only the keycode/remap source variables below
        // (`primaryKeycodes` etc.) for the Base tab's raw data.
        <KeyboardPane
          paneId="primary" isActive={true} keys={keys} keycodes={primaryKeycodes} encoderKeycodes={primaryEncoderKeycodes}
          selectedKey={selectedKey} selectedEncoder={selectedEncoder} selectedMaskPart={selectedMaskPart} selectedKeycode={selectedKeycode}
          pressedKeys={matrixMode ? pressedKeys : undefined} everPressedKeys={matrixMode ? everPressedKeys : undefined}
          remappedKeys={primaryRemappedKeys} remappedEncoders={primaryRemappedEncoders} flash={flash} multiSelectedKeys={viewMatrixMode.active ? viewMatrixMode.selectedKeys : multiSelectedKeys}
          layoutOptions={layoutOptions} scale={scale}
          labelOverrides={viewMatrixLabelOverrides} keyColors={viewMatrixDuplicateKeyColors} remapLabel={primaryRemapLabel}
          matrixWires={matrixWires}
          onKeyAuxClick={auxUndoHandlers ? onKeyAuxClick : undefined} onEncoderAuxClick={auxUndoHandlers ? onEncoderAuxClick : undefined}
          layerLabel={viewMatrixMode.active ? undefined : currentLayerLabel} layerLabelTestId="layer-label"
          onKeyClick={viewMatrixMode.active ? handleViewMatrixKeyClick : handleKeyClick}
          onKeyDoubleClick={viewMatrixMode.active ? undefined : handleKeyDoubleClick}
          onEncoderClick={viewMatrixMode.active ? undefined : handleEncoderClick}
          onEncoderDoubleClick={viewMatrixMode.active ? undefined : handleEncoderDoubleClick}
          onDeselect={viewMatrixMode.active ? viewMatrixMode.clearSelection : handleDeselect} contentRef={contentRef}
        />
      )}
      {showPackTabs && (
        <KeymapPackTabs activeTab={packTab} onTabChange={handlePackTabChange} packName={keymapPackName ?? ''} />
      )}
    </div>
  )
}
