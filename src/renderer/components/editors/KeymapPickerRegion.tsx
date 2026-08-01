// SPDX-License-Identifier: GPL-2.0-or-later

import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeycodesOverlayPanel } from './KeycodesOverlayPanel'
import { LayerListPanel } from './LayerListPanel'
import { Tooltip } from '../ui/Tooltip'
import { ICON_MD } from '../../constants/ui-tokens'
import type { KeymapEditorProps } from './keymap-editor-types'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { parseLayoutLabels } from '../../../shared/layout-options'

/** `KeymapEditorProps` covers every plain pass-through field below
 *  (layers/currentLayer/onLayerChange/layerNames/onSetLayerName for
 *  `LayerListPanel`; basicViewType/splitKeyMode/quickSelect/autoAdvance/
 *  unlocked/isDummy/toolsExtra/dataPanel/keyEditorZoom/onExportLayoutPdf*
 *  for `KeycodesOverlayPanel`; pickerRemapLabel for both); these additions
 *  are values `KeymapEditor` only has at render time from its own hooks
 *  (selection state, the layout-options panel, View Matrix mode, the
 *  layer/tab footer builders, ...). */
export interface KeymapPickerRegionProps extends KeymapEditorProps {
  layerPanelCollapsed: boolean
  toggleLayerPanel: () => void
  layoutPickerContent: React.ReactNode
  packTabReadOnly: boolean
  gatedHandleKeycodeSelect: (kc: Keycode) => void
  handlePickerMultiSelect: (
    index: number,
    keycode: number,
    event: { ctrlKey: boolean; shiftKey: boolean },
    tabKeycodeNumbers: number[],
  ) => void
  pickerSelectedIndices: Set<number>
  selectedKey: { row: number; col: number } | null
  selectedEncoder: { idx: number; dir: 0 | 1 } | null
  handleDeselect: () => void
  clearPickerSelection: () => void
  configuredKeycodes?: Set<string>
  isMaskKey: boolean
  isLMMask: boolean
  tabFooterContent: Record<string, React.ReactNode>
  tabContentOverride: Record<string, React.ReactNode> | undefined
  layoutButtonRef: RefObject<HTMLButtonElement | null>
  layoutPanelOpen: boolean
  setLayoutPanelOpen: (updater: (prev: boolean) => boolean) => void
  layoutPanelRef: RefObject<HTMLDivElement | null>
  viewMatrixActive: boolean
  onToggleViewMatrixMode: () => void
  matrixMode: boolean
  hasMatrixTester: boolean
  handleMatrixToggle: () => void
  hasLayoutOptions: boolean
  parsedLayoutOptions: ReturnType<typeof parseLayoutLabels>
  layoutValues: Map<number, number>
  handleLayoutOptionChange: (index: number, value: number) => Promise<void>
  /** Overrides `KeymapEditorProps.autoAdvance` (optional there) —
   *  `KeymapEditor` always passes its own already-defaulted local, same
   *  reasoning as `KeymapTypingTestPane`'s `scale` override. */
  autoAdvance: boolean
}

/** The entire keycode picker area — layer list, tabs/tiles, and the overlay
 *  settings panel (incl. its own View Matrix Edit/Done button) — rendered as
 *  a SIBLING of `keymap-surface`, never inside it (the picker's "actual"
 *  tint must never inherit the simulation tab's `remap-simulated` CSS
 *  override). Hidden entirely by the caller while View Matrix mode is
 *  active or typing-test mode is on — this component doesn't gate on
 *  either itself. */
export function KeymapPickerRegion(props: KeymapPickerRegionProps): JSX.Element {
  const {
    layers, currentLayer, onLayerChange, layerNames, onSetLayerName, layerPanelCollapsed, toggleLayerPanel,
    layoutPickerContent, packTabReadOnly, gatedHandleKeycodeSelect, handlePickerMultiSelect,
    pickerSelectedIndices, selectedKey, selectedEncoder, handleDeselect, clearPickerSelection,
    configuredKeycodes, isMaskKey, isLMMask, tabFooterContent, tabContentOverride,
    basicViewType, onBasicViewTypeChange, splitKeyMode, onSplitKeyModeChange, pickerRemapLabel,
    layoutButtonRef, layoutPanelOpen, setLayoutPanelOpen, layoutPanelRef, onOverlayOpen,
    hasLayoutOptions, parsedLayoutOptions, layoutValues, handleLayoutOptionChange,
    autoAdvance, onAutoAdvanceChange, viewMatrixActive, onToggleViewMatrixMode,
    quickSelect, onQuickSelectChange, matrixMode, hasMatrixTester, handleMatrixToggle,
    unlocked, onLock, isDummy, toolsExtra, dataPanel, keyEditorZoom, onKeyEditorZoomChange,
    onExportLayoutPdfAll, onExportLayoutPdfCurrent,
  } = props
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 flex-1 gap-2">
      {onLayerChange && layers > 1 && (
        <LayerListPanel layers={layers} currentLayer={currentLayer} onLayerChange={onLayerChange}
          layerNames={layerNames} onSetLayerName={onSetLayerName} collapsed={layerPanelCollapsed} onToggleCollapse={toggleLayerPanel} />
      )}
      <TabbedKeycodes
        keyboardPickerContent={layoutPickerContent}
        // Simulation tab is completely read-only (Plan-qwerty-select-
        // no-rewrite v7): no picker click can paste into the shared
        // selection state, and no picker multi-select can accumulate a
        // selection that would still be sitting there — pasteable —
        // once the user switches back to Base.
        onKeycodeSelect={packTabReadOnly ? undefined : gatedHandleKeycodeSelect}
        onKeycodeMultiSelect={packTabReadOnly ? undefined : handlePickerMultiSelect}
        pickerSelectedIndices={pickerSelectedIndices}
        pickerMultiSelectEnabled={!packTabReadOnly && !selectedKey && !selectedEncoder}
        onBackgroundClick={handleDeselect}
        onTabChange={() => { clearPickerSelection() }}
        highlightedKeycodes={configuredKeycodes} maskOnly={isMaskKey} lmMode={isLMMask} showHint={!isMaskKey}
        tabFooterContent={tabFooterContent} tabContentOverride={tabContentOverride}
        basicViewType={basicViewType} onBasicViewTypeChange={onBasicViewTypeChange} splitKeyMode={splitKeyMode} remapLabel={pickerRemapLabel}
        tabBarRight={
          <Tooltip content={t('editorSettings.title')}>
            <button ref={layoutButtonRef} type="button" aria-label={t('editorSettings.title')}
              aria-expanded={layoutPanelOpen} aria-controls="keycodes-overlay-panel"
              className={`rounded p-1 transition-colors ${layoutPanelOpen ? 'bg-surface-dim text-accent' : 'text-content-secondary hover:bg-surface-dim hover:text-content'}`}
              onClick={() => { setLayoutPanelOpen((prev) => { if (!prev) onOverlayOpen?.(); return !prev }) }}
            >
              <SlidersHorizontal size={ICON_MD} aria-hidden="true" />
            </button>
          </Tooltip>
        }
        panelOverlay={
          <div id="keycodes-overlay-panel" ref={layoutPanelRef}
            className={`absolute inset-y-0 right-0 z-10 w-fit min-w-keycode-panel max-w-keycode-panel rounded-l-lg rounded-r-panel-connector border-l border-edge-subtle bg-surface-alt shadow-lg transition-transform duration-200 ease-out ${layoutPanelOpen ? 'translate-x-0' : 'translate-x-full'}`}
            inert={!layoutPanelOpen || undefined}
          >
            <KeycodesOverlayPanel
              hasLayoutOptions={hasLayoutOptions} layoutOptions={parsedLayoutOptions} layoutValues={layoutValues}
              onLayoutOptionChange={handleLayoutOptionChange} autoAdvance={autoAdvance} onAutoAdvanceChange={onAutoAdvanceChange}
              viewMatrixActive={viewMatrixActive} onToggleViewMatrixMode={onToggleViewMatrixMode}
              splitKeyMode={splitKeyMode} onSplitKeyModeChange={onSplitKeyModeChange}
              quickSelect={quickSelect} onQuickSelectChange={onQuickSelectChange}
              matrixMode={matrixMode} hasMatrixTester={hasMatrixTester} onToggleMatrix={viewMatrixActive ? undefined : handleMatrixToggle}
              unlocked={unlocked ?? false} onLock={onLock} isDummy={isDummy}
              toolsExtra={toolsExtra} dataPanel={dataPanel}
              keyEditorZoom={keyEditorZoom} onKeyEditorZoomChange={onKeyEditorZoomChange}
              onExportLayoutPdfAll={onExportLayoutPdfAll} onExportLayoutPdfCurrent={onExportLayoutPdfCurrent}
            />
          </div>
        }
      />
    </div>
  )
}
