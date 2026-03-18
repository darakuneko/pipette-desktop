// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import type { KleKey } from '../../../shared/kle/types'

const COPY_BTN_BASE = 'rounded border px-1.5 py-0.5 text-xs leading-none disabled:opacity-50'

const PANE_BASE = 'relative inline-block min-w-[280px] rounded-xl bg-surface-alt px-5 pt-3 pb-2'

function paneContainerClass(isActive: boolean, isSplitEdit: boolean): string {
  if (!isSplitEdit) return `${PANE_BASE} border-2 border-edge-subtle`
  if (isActive) return `${PANE_BASE} border-2 border-accent`
  return `${PANE_BASE} border-2 border-edge-subtle cursor-pointer`
}

/** Returns true when any selection-modifier key (Ctrl/Meta/Shift) is held. */
export function hasModifierKey(e: React.MouseEvent): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey
}

export interface KeyboardPaneProps {
  paneId: 'primary' | 'secondary'
  isActive: boolean
  isSplitEdit: boolean
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
  scale: number
  layerLabel: string
  layerLabelTestId: string
  onKeyClick?: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  onKeyDoubleClick?: (key: KleKey, rect: DOMRect, maskClicked: boolean) => void
  onEncoderClick?: (key: KleKey, dir: number) => void
  onEncoderDoubleClick?: (key: KleKey, dir: number, rect: DOMRect) => void
  onCopyLayer?: () => void
  copyLayerPending?: string
  isCopying?: boolean
  pasteHint?: string
  onDeselect?: () => void
  onActivate?: () => void
  contentRef?: React.RefObject<HTMLDivElement | null>
}

export function KeyboardPane({
  paneId,
  isActive,
  isSplitEdit,
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
  scale,
  layerLabel,
  layerLabelTestId,
  onKeyClick,
  onKeyDoubleClick,
  onEncoderClick,
  onEncoderDoubleClick,
  onCopyLayer,
  copyLayerPending,
  isCopying,
  pasteHint,
  onDeselect,
  onActivate,
  contentRef,
}: KeyboardPaneProps) {
  const { t } = useTranslation()
  return (
    <div
      ref={contentRef}
      data-testid={`${paneId}-pane`}
      className={paneContainerClass(isActive, isSplitEdit)}
      onClick={(e) => {
        e.stopPropagation()
        if (isSplitEdit && !isActive) onActivate?.()
        else if (isActive && !hasModifierKey(e)) onDeselect?.()
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
          scale={scale}
          onKeyClick={isActive ? onKeyClick : undefined}
          onKeyDoubleClick={isActive ? onKeyDoubleClick : undefined}
          onEncoderClick={isActive ? onEncoderClick : undefined}
          onEncoderDoubleClick={isActive ? onEncoderDoubleClick : undefined}
          readOnly={isSplitEdit ? !isActive : false}
        />
      </div>
      {isActive && !onCopyLayer && pasteHint && (
        <div data-testid="paste-hint" className="flex items-center justify-center py-1 text-xs text-content-muted">
          {pasteHint}
        </div>
      )}
      <div className="flex items-center justify-between px-[5px] text-xs leading-none text-content-muted">
        <span data-testid={layerLabelTestId} className="text-content-muted">
          {layerLabel}
        </span>
        {isActive && isSplitEdit && onCopyLayer && (
          <button
            type="button"
            data-testid="copy-layer-button"
            disabled={isCopying}
            className={copyLayerPending
              ? `${COPY_BTN_BASE} border-danger text-danger hover:bg-danger/10`
              : `${COPY_BTN_BASE} border-edge text-content-secondary hover:text-content`}
            onClick={(e) => { e.stopPropagation(); onCopyLayer() }}
          >
            {copyLayerPending || t('editor.keymap.copyLayer')}
          </button>
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
