// SPDX-License-Identifier: GPL-2.0-or-later

import type { RefObject } from 'react'
import { KeyboardPane } from './KeyboardPane'
import { KeymapPackTabs, KeymapPackApplyButton, type KeymapPackTab } from './KeymapPackTabs'
import type { KleKey } from '../../../shared/kle/types'
import type { KeyFlashState } from '../keyboard/key-flash'
import type { UseViewMatrixModeReturn } from './useViewMatrixMode'

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
  viewMatrixLabelOverrides, viewMatrixDuplicateKeyColors, primaryRemapLabel,
  handleViewMatrixKeyClick, handleKeyClick, handleKeyDoubleClick, handleEncoderClick, handleEncoderDoubleClick,
  handleDeselect, handlePackTabChange, keymapPackName,
}: KeymapPrimaryPaneProps): JSX.Element {
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
