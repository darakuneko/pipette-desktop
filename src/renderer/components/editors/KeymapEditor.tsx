// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import { KEY_UNIT, KEY_SPACING, KEYBOARD_PADDING } from '../keyboard/constants'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import type { KleKey, KeyboardLayout } from '../../../shared/kle/types'
import { serialize, deserialize, isMask, isTapDanceKeycode, getTapDanceIndex, isMacroKeycode, getMacroIndex, isLMKeycode, resolve, extractBasicKey, buildModMaskKeycode } from '../../../shared/keycodes/keycodes'
import type { BulkKeyEntry } from '../../hooks/useKeyboard'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { deserializeAllMacros } from '../../../preload/macro'
import {
  parseLayoutLabels,
  unpackLayoutOptions,
  packLayoutOptions,
} from '../../../shared/layout-options'
import { filterVisibleKeys, repositionLayoutKeys } from '../../../shared/kle/filter-keys'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { useInlineRename } from '../../hooks/useInlineRename'
import { TapDanceModal } from './TapDanceModal'
import { MacroModal } from './MacroModal'
import { QmkSettings } from './QmkSettings'
import { ModalCloseButton } from './ModalCloseButton'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import type { LayoutOption } from '../../../shared/layout-options'
import { parseMatrixState, POLL_INTERVAL } from './matrix-utils'
import type { PanelSide } from '../../hooks/useDevicePrefs'
import { PanelLeftOpen, PanelRightOpen, Columns2, ZoomIn, ZoomOut, Keyboard, LayoutList, Globe, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { TypingTestView } from '../../typing-test/TypingTestView'
import { useTypingTest } from '../../typing-test/useTypingTest'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import { buildTypingTestResult, isPbForConfig } from '../../typing-test/result-builder'
import type { TypingTestConfig } from '../../typing-test/types'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE } from '../../typing-test/types'
import { TypingTestHistory } from '../../typing-test/TypingTestHistory'
import { LanguageSelectorModal } from '../../typing-test/LanguageSelectorModal'

const MIN_SCALE = 0.3
const MAX_SCALE = 2.0

/** Maps KeyboardEvent.code to a resolved key when e.key is 'Process' (IME active). */
const PROCESS_CODE_TO_KEY = new Map<string, string>([
  ['Space', ' '],
  ['Enter', 'Enter'],
  ['NumpadEnter', 'Enter'],
  ['Backspace', 'Backspace'],
])

const EMPTY_KEYCODES = new Map<string, string>()
const EMPTY_REMAPPED = new Set<string>()
const EMPTY_ENCODER_KEYCODES = new Map<string, [string, string]>()

const TOOLTIP_STYLE = 'pointer-events-none absolute z-50 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg text-xs font-medium text-content whitespace-nowrap opacity-0 transition-opacity delay-300'

function IconTooltip({ label, side = 'right', children }: {
  label: string
  side?: 'right' | 'top-end'
  children: React.ReactNode
}) {
  const posClass = side === 'right'
    ? 'left-full top-1/2 -translate-y-1/2 ml-2'
    : 'bottom-full right-0 mb-2'
  return (
    <div className="group/tip relative">
      {children}
      <div className={`${TOOLTIP_STYLE} ${posClass} group-hover/tip:opacity-100`}>
        {label}
      </div>
    </div>
  )
}

const CONTROL_BASE = 'rounded-md border px-3 py-1.5 text-[13px]'

function toggleButtonClass(active: boolean): string {
  const base = `${CONTROL_BASE} transition-colors`
  if (active) return `${base} border-accent bg-accent/10 text-accent`
  return `${base} border-edge text-content-secondary hover:text-content`
}

const PAGER_PAGE_SIZE = 5
const PAGER_CENTER = Math.floor(PAGER_PAGE_SIZE / 2)
const PAGER_CELL_REM = 1.75
const PAGER_GAP_REM = 0.125
const PAGER_STRIDE = PAGER_CELL_REM + PAGER_GAP_REM
const PAGER_VIEWPORT_REM = PAGER_PAGE_SIZE * PAGER_STRIDE - PAGER_GAP_REM

const PAGER_CELL = 'h-7 w-7 shrink-0'
const PAGER_BTN_BASE = `flex ${PAGER_CELL} items-center justify-center rounded-full text-[13px] leading-none transition-colors`

function layerButtonClass(active: boolean): string {
  if (active) return `${PAGER_BTN_BASE} font-semibold text-tab-text-active`
  return `${PAGER_BTN_BASE} text-tab-text hover:text-content`
}


function PagerSpacers({ count, prefix }: { count: number; prefix: string }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={`${prefix}-${i}`} className={PAGER_CELL} />
  ))
}

const LAYER_NUM_BASE = 'w-8 shrink-0 rounded-md border flex items-center justify-center py-1.5 cursor-pointer text-[12px] font-semibold tabular-nums transition-colors'
const LAYER_NAME_BASE = 'flex-1 min-w-0 rounded-md border px-3 py-1.5 transition-colors'

function layerNumClass(active: boolean): string {
  if (active) return `${LAYER_NUM_BASE} border-accent bg-accent text-content-inverse`
  return `${LAYER_NUM_BASE} border-edge bg-surface/20 text-content-muted hover:bg-surface-dim`
}

function layerNameClass(active: boolean, editable: boolean): string {
  const base = editable ? `${LAYER_NAME_BASE} cursor-pointer` : LAYER_NAME_BASE
  if (active) return `${base} border-accent/50 bg-accent/5`
  return `${base} border-edge bg-surface/20 hover:border-content-muted/30`
}

const LAYER_TOGGLE_BTN = 'flex items-center justify-center rounded-md p-0.5 text-content-muted hover:text-content hover:bg-surface-dim transition-colors'

interface LayerListPanelProps {
  layers: number
  currentLayer: number
  onLayerChange: (layer: number) => void
  layerNames?: string[]
  onSetLayerName?: (layer: number, name: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

function LayerNumButton({ index, active, onLayerChange }: {
  index: number
  active: boolean
  onLayerChange: (layer: number) => void
}) {
  return (
    <div
      className={layerNumClass(active)}
      data-testid={`layer-panel-layer-num-${index}`}
      onClick={() => onLayerChange(index)}
    >
      {index}
    </div>
  )
}

function LayerListPanel({ layers, currentLayer, onLayerChange, layerNames, onSetLayerName, collapsed, onToggleCollapse }: LayerListPanelProps) {
  const { t } = useTranslation()
  const layerRename = useInlineRename<number>()

  function handleLayerRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>, layerIndex: number): void {
    if (e.key === 'Enter') {
      const trimmed = layerRename.editLabel.trim()
      const changed = trimmed !== (layerNames?.[layerIndex] ?? '')
      layerRename.cancelRename()
      if (changed && onSetLayerName) {
        onSetLayerName(layerIndex, trimmed)
        layerRename.scheduleFlash(layerIndex)
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      layerRename.cancelRename()
    }
  }

  if (collapsed) {
    return (
      <div
        className="flex shrink-0 flex-col items-center rounded-[10px] border border-edge bg-picker-bg p-1"
        data-testid="layer-list-panel-collapsed"
      >
        <button
          type="button"
          className={LAYER_TOGGLE_BTN}
          onClick={onToggleCollapse}
          aria-label={t('editor.keymap.expandLayers')}
          data-testid="layer-panel-expand-btn"
        >
          <ChevronsRight size={14} aria-hidden="true" />
        </button>
        {Array.from({ length: layers }, (_, i) => (
          <LayerNumButton key={i} index={i} active={i === currentLayer} onLayerChange={onLayerChange} />
        ))}
      </div>
    )
  }

  return (
    <div
      className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto rounded-[10px] border border-edge bg-picker-bg p-2"
      data-testid="layer-list-panel"
    >
      <div className="flex justify-end">
        <button
          type="button"
          className={LAYER_TOGGLE_BTN}
          onClick={onToggleCollapse}
          aria-label={t('editor.keymap.collapseLayers')}
          data-testid="layer-panel-collapse-btn"
        >
          <ChevronsLeft size={14} aria-hidden="true" />
        </button>
      </div>
      {Array.from({ length: layers }, (_, i) => {
        const name = layerNames?.[i] ?? ''
        const defaultLabel = t('editor.keymap.layerN', { n: i })
        const isActive = i === currentLayer
        const isEditing = layerRename.editingId === i

        return (
          <div
            key={i}
            className="flex items-center gap-1.5"
            data-testid={`layer-panel-layer-${i}`}
          >
            <LayerNumButton index={i} active={isActive} onLayerChange={onLayerChange} />
            <div
              className={`${layerNameClass(isActive, !!onSetLayerName)}${layerRename.confirmedId === i ? ' confirm-flash' : ''}`}
              data-testid={`layer-panel-layer-name-box-${i}`}
              onClick={onSetLayerName ? () => { if (!isEditing) layerRename.startRename(i, name) } : undefined}
              onMouseDown={(e) => layerRename.handleCardMouseDown(e, i)}
            >
              {isEditing && onSetLayerName ? (
                <input
                  data-testid={`layer-panel-layer-name-input-${i}`}
                  className="w-full border-b border-edge bg-transparent text-[12px] text-content outline-none focus:border-accent"
                  value={layerRename.editLabel}
                  onChange={(e) => layerRename.setEditLabel(e.target.value)}
                  placeholder={defaultLabel}
                  autoFocus
                  maxLength={32}
                  onBlur={layerRename.cancelRename}
                  onKeyDown={(e) => handleLayerRenameKeyDown(e, i)}
                />
              ) : (
                <span
                  className={`block truncate text-[12px] ${isActive ? 'text-content' : 'text-content-secondary'}`}
                  data-testid={`layer-panel-layer-name-${i}`}
                >
                  {name || defaultLabel}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const COPY_BTN_BASE = 'rounded-md border px-3 py-1 text-xs disabled:opacity-50'

const PANE_BASE = 'relative inline-block min-w-[280px] rounded-xl bg-surface-alt px-5 pt-3 pb-2'

function paneContainerClass(isActive: boolean, isDualMode: boolean): string {
  if (!isDualMode) return `${PANE_BASE} border border-edge-subtle`
  if (isActive) return `${PANE_BASE} border-2 border-accent`
  return `${PANE_BASE} border-2 border-edge-subtle cursor-pointer`
}

/** Returns true when any selection-modifier key (Ctrl/Meta/Shift) is held. */
function hasModifierKey(e: React.MouseEvent): boolean {
  return e.ctrlKey || e.metaKey || e.shiftKey
}

interface KeyboardPaneProps {
  paneId: 'primary' | 'secondary'
  isActive: boolean
  isDualMode: boolean
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
  onCopyAll?: () => void
  copyAllPending?: string
  isCopying?: boolean
  pasteHint?: string
  onDeselect?: () => void
  onActivate?: () => void
  contentRef?: React.RefObject<HTMLDivElement | null>
}

function KeyboardPane({
  paneId,
  isActive,
  isDualMode,
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
  onCopyAll,
  copyAllPending,
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
      className={paneContainerClass(isActive, isDualMode)}
      onClick={(e) => {
        e.stopPropagation()
        if (isDualMode && !isActive) onActivate?.()
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
          readOnly={isDualMode ? !isActive : false}
        />
      </div>
      {isActive && isDualMode && onCopyAll && (
        <div className="flex items-center justify-center gap-2 py-1">
          <button
            type="button"
            data-testid="copy-all-button"
            disabled={isCopying}
            className={copyAllPending
              ? `${COPY_BTN_BASE} border-danger text-danger hover:bg-danger/10`
              : `${COPY_BTN_BASE} border-edge text-content-secondary hover:text-content`}
            onClick={(e) => { e.stopPropagation(); onCopyAll() }}
          >
            {copyAllPending || t('editor.keymap.copyAll')}
          </button>
        </div>
      )}
      {isActive && !onCopyAll && pasteHint && (
        <div data-testid="paste-hint" className="flex items-center justify-center py-1 text-xs text-content-muted">
          {pasteHint}
        </div>
      )}
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

interface SettingsModalProps {
  title: string
  testidPrefix: string
  tabName: string
  supportedQsids: Set<number>
  qmkSettingsGet: (qsid: number) => Promise<number[]>
  qmkSettingsSet: (qsid: number, data: number[]) => Promise<void>
  qmkSettingsReset: () => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
  onClose: () => void
}

function SettingsModal({
  title,
  testidPrefix,
  tabName,
  supportedQsids,
  qmkSettingsGet,
  qmkSettingsSet,
  qmkSettingsReset,
  onSettingsUpdate,
  onClose,
}: SettingsModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid={`${testidPrefix}-backdrop`}
      onClick={onClose}
    >
      <div
        className="w-[600px] max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-lg bg-surface-alt p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <ModalCloseButton testid={`${testidPrefix}-close`} onClick={onClose} />
        </div>
        <QmkSettings
          tabName={tabName}
          supportedQsids={supportedQsids}
          qmkSettingsGet={qmkSettingsGet}
          qmkSettingsSet={qmkSettingsSet}
          qmkSettingsReset={qmkSettingsReset}
          onSettingsUpdate={onSettingsUpdate}
        />
      </div>
    </div>
  )
}

interface LayoutOptionsPanelProps {
  options: LayoutOption[]
  values: Map<number, number>
  onChange: (index: number, value: number) => void
}

function LayoutOptionsPanel({ options, values, onChange }: LayoutOptionsPanelProps) {
  // Compute the widest select option label to align all selects
  const hasSelect = options.some((opt) => opt.labels.length > 2)
  const selectRef = useRef<HTMLSelectElement>(null)
  const [selectWidth, setSelectWidth] = useState<number | undefined>(undefined)

  useEffect(() => {
    if (!hasSelect || !selectRef.current) return
    // Measure the natural width of the hidden sizer select
    setSelectWidth(selectRef.current.offsetWidth)
  }, [hasSelect, options])

  // All choice labels across all selects (for the sizer)
  const allChoiceLabels = useMemo(
    () => options.filter((o) => o.labels.length > 2).flatMap((o) => o.labels.slice(1)),
    [options],
  )

  return (
    <div className="px-4 py-3 space-y-2">
      {/* Hidden sizer select to measure the widest option */}
      {hasSelect && (
        <select
          ref={selectRef}
          className="invisible absolute rounded-md border border-edge px-3 py-1 text-xs"
          tabIndex={-1}
          aria-hidden="true"
        >
          {allChoiceLabels.map((label, i) => (
            <option key={i}>{label}</option>
          ))}
        </select>
      )}
      {options.map((opt) => {
        const val = values.get(opt.index) ?? 0
        const isBoolean = opt.labels.length <= 2
        return (
          <label key={opt.index} className="flex items-center justify-between gap-4 cursor-pointer">
            <span className="text-xs text-content-secondary">{opt.labels[0]}</span>
            {isBoolean ? (
              <input
                type="checkbox"
                checked={val === 1}
                onChange={() => onChange(opt.index, val === 1 ? 0 : 1)}
              />
            ) : (
              <select
                value={val}
                onChange={(e) => onChange(opt.index, Number(e.target.value))}
                className="rounded-md border border-edge bg-surface-alt px-3 py-1 text-xs text-content-secondary"
                style={selectWidth ? { width: selectWidth } : undefined}
              >
                {opt.labels.slice(1).map((label, i) => (
                  <option key={i} value={i}>{label}</option>
                ))}
              </select>
            )}
          </label>
        )
      })}
    </div>
  )
}

interface PopoverForStateProps {
  popoverState: NonNullable<
    | { anchorRect: DOMRect; kind: 'key'; row: number; col: number; maskClicked: boolean }
    | { anchorRect: DOMRect; kind: 'encoder'; idx: number; dir: number }
  >
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  currentLayer: number
  layers: number
  onKeycodeSelect: (kc: Keycode) => void
  onRawKeycodeSelect: (code: number) => void
  onModMaskChange?: (newMask: number) => void
  onClose: () => void
}

function PopoverForState({
  popoverState,
  keymap,
  encoderLayout,
  currentLayer,
  layers,
  onKeycodeSelect,
  onRawKeycodeSelect,
  onModMaskChange,
  onClose,
}: PopoverForStateProps) {
  const currentKeycode = popoverState.kind === 'key'
    ? keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
    : encoderLayout.get(`${currentLayer},${popoverState.idx},${popoverState.dir}`) ?? 0
  const maskOnly = popoverState.kind === 'key'
    && popoverState.maskClicked
    && isMask(serialize(currentKeycode))

  return (
    <KeyPopover
      anchorRect={popoverState.anchorRect}
      currentKeycode={currentKeycode}
      maskOnly={maskOnly}
      layers={layers}
      onKeycodeSelect={onKeycodeSelect}
      onRawKeycodeSelect={onRawKeycodeSelect}
      onModMaskChange={onModMaskChange}
      onClose={onClose}
    />
  )
}

export interface KeymapEditorHandle {
  toggleMatrix: () => void
  matrixMode: boolean
  hasMatrixTester: boolean
}

interface Props {
  layout: KeyboardLayout | null
  layers: number
  currentLayer: number
  onLayerChange?: (layer: number) => void
  keymap: Map<string, number> // "layer,row,col" -> keycode
  encoderLayout: Map<string, number> // "layer,idx,dir" -> keycode
  encoderCount: number
  layoutOptions: Map<number, number>
  layoutLabels?: (string | string[])[]
  packedLayoutOptions?: number
  onSetLayoutOptions?: (options: number) => Promise<void>
  remapLabel?: (qmkId: string) => string
  isRemapped?: (qmkId: string) => boolean
  onSetKey: (layer: number, row: number, col: number, keycode: number) => Promise<void>
  onSetKeysBulk: (entries: BulkKeyEntry[]) => Promise<void>
  onSetEncoder: (layer: number, idx: number, dir: number, keycode: number) => Promise<void>
  rows?: number
  cols?: number
  getMatrixState?: () => Promise<number[]>
  unlocked?: boolean
  onUnlock?: (options?: { macroWarning?: boolean }) => void
  tapDanceEntries?: TapDanceEntry[]
  onSetTapDanceEntry?: (index: number, entry: TapDanceEntry) => Promise<void>
  macroCount?: number
  macroBufferSize?: number
  macroBuffer?: number[]
  vialProtocol?: number
  onSaveMacros?: (buffer: number[]) => Promise<void>
  tapHoldSupported?: boolean
  mouseKeysSupported?: boolean
  magicSupported?: boolean
  graveEscapeSupported?: boolean
  autoShiftSupported?: boolean
  oneShotKeysSupported?: boolean
  supportedQsids?: Set<number>
  qmkSettingsGet?: (qsid: number) => Promise<number[]>
  qmkSettingsSet?: (qsid: number, data: number[]) => Promise<void>
  qmkSettingsReset?: () => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
  autoAdvance?: boolean
  onMatrixModeChange?: (matrixMode: boolean, hasMatrixTester: boolean) => void
  onOpenLighting?: () => void
  onOpenCombo?: () => void
  onOpenAltRepeatKey?: () => void
  onOpenKeyOverride?: () => void
  onOpenEditorSettings?: () => void
  panelSide?: PanelSide
  layerNames?: string[]
  onSetLayerName?: (layer: number, name: string) => void
  layerPanelOpen?: boolean
  onLayerPanelOpenChange?: (open: boolean) => void
  scale?: number
  onScaleChange?: (delta: number) => void
  dualMode?: boolean
  onDualModeChange?: (enabled: boolean) => void
  activePane?: 'primary' | 'secondary'
  onActivePaneChange?: (pane: 'primary' | 'secondary') => void
  primaryLayer?: number
  secondaryLayer?: number
  typingTestMode?: boolean
  onTypingTestModeChange?: (enabled: boolean) => void
  onSaveTypingTestResult?: (result: TypingTestResult) => void
  typingTestHistory?: TypingTestResult[]
  typingTestConfig?: TypingTestConfig
  typingTestLanguage?: string
  onTypingTestConfigChange?: (config: TypingTestConfig) => void
  onTypingTestLanguageChange?: (lang: string) => void
  deviceName?: string
  isDummy?: boolean
}

export const KeymapEditor = forwardRef<KeymapEditorHandle, Props>(function KeymapEditor({
  layout,
  layers,
  currentLayer,
  onLayerChange,
  keymap,
  encoderLayout,
  encoderCount,
  layoutOptions,
  layoutLabels,
  packedLayoutOptions,
  onSetLayoutOptions,
  remapLabel,
  isRemapped,
  onSetKey,
  onSetKeysBulk,
  onSetEncoder,
  rows,
  cols,
  getMatrixState,
  unlocked,
  onUnlock,
  tapDanceEntries,
  onSetTapDanceEntry,
  macroCount,
  macroBufferSize,
  macroBuffer,
  vialProtocol,
  onSaveMacros,
  tapHoldSupported,
  mouseKeysSupported,
  magicSupported,
  graveEscapeSupported,
  autoShiftSupported,
  oneShotKeysSupported,
  supportedQsids,
  qmkSettingsGet,
  qmkSettingsSet,
  qmkSettingsReset,
  onSettingsUpdate,
  autoAdvance = true,
  onMatrixModeChange,
  onOpenLighting,
  onOpenCombo,
  onOpenAltRepeatKey,
  onOpenKeyOverride,
  onOpenEditorSettings,
  panelSide = 'left',
  layerNames,
  onSetLayerName,
  layerPanelOpen: layerPanelOpenProp,
  onLayerPanelOpenChange,
  scale: scaleProp = 1,
  onScaleChange,
  dualMode,
  onDualModeChange,
  activePane = 'primary',
  onActivePaneChange,
  primaryLayer: primaryLayerProp,
  secondaryLayer: secondaryLayerProp,
  typingTestMode,
  onTypingTestModeChange,
  onSaveTypingTestResult,
  typingTestHistory,
  typingTestConfig: savedTypingTestConfig,
  typingTestLanguage: savedTypingTestLanguage,
  onTypingTestConfigChange,
  onTypingTestLanguageChange,
  deviceName,
  isDummy,
}, ref) {
  const { t } = useTranslation()
  const [selectedKey, setSelectedKey] = useState<{ row: number; col: number } | null>(null)
  const [selectedEncoder, setSelectedEncoder] = useState<{ idx: number; dir: number } | null>(null)
  const [selectedMaskPart, setSelectedMaskPart] = useState(false)
  const [showTapHoldSettings, setShowTapHoldSettings] = useState(false)
  const [showMouseKeysSettings, setShowMouseKeysSettings] = useState(false)
  const [showMagicSettings, setShowMagicSettings] = useState(false)
  const [showGraveEscapeSettings, setShowGraveEscapeSettings] = useState(false)
  const [showAutoShiftSettings, setShowAutoShiftSettings] = useState(false)
  const [showOneShotKeysSettings, setShowOneShotKeysSettings] = useState(false)
  const [showLanguageModal, setShowLanguageModal] = useState(false)
  const layerPanelCollapsed = layerPanelOpenProp === false
  const toggleLayerPanel = useCallback(() => {
    onLayerPanelOpenChange?.(!layerPanelOpenProp)
  }, [onLayerPanelOpenChange, layerPanelOpenProp])
  const [matrixMode, setMatrixMode] = useState(false)
  const [pressedKeys, setPressedKeys] = useState<Set<string>>(new Set())
  const [everPressedKeys, setEverPressedKeys] = useState<Set<string>>(new Set())
  const pollingRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const keyboardContentRef = useRef<HTMLDivElement>(null)

  const [layoutPanelOpen, setLayoutPanelOpen] = useState(false)
  const layoutPanelRef = useRef<HTMLDivElement>(null)
  const layoutButtonRef = useRef<HTMLButtonElement>(null)

  const [multiSelectedKeys, setMultiSelectedKeys] = useState<Set<string>>(new Set())
  const [selectionAnchor, setSelectionAnchor] = useState<{ row: number; col: number } | null>(null)
  const [selectionSourcePane, setSelectionSourcePane] = useState<'primary' | 'secondary' | null>(null)
  const [selectionMode, setSelectionMode] = useState<'ctrl' | 'shift'>('ctrl')
  const [isCopying, setIsCopying] = useState(false)
  const isCopyingRef = useRef(false)
  const [copyAllPending, setCopyAllPending] = useState(false)

  const [pickerSelectedKeycodes, setPickerSelectedKeycodes] = useState<Keycode[]>([])
  const [pickerAnchor, setPickerAnchor] = useState<string | null>(null)

  const pickerSelectedSet = useMemo(
    () => new Set(pickerSelectedKeycodes.map((kc) => kc.qmkId)),
    [pickerSelectedKeycodes],
  )

  /** Clear multi-selection only if non-empty (avoids unnecessary re-renders). */
  const clearMultiSelection = useCallback(() => {
    setMultiSelectedKeys((prev) => prev.size === 0 ? prev : new Set())
    setSelectionAnchor(null)
    setSelectionSourcePane(null)
  }, [])

  const clearPickerSelection = useCallback(() => {
    setPickerSelectedKeycodes((prev) => prev.length === 0 ? prev : [])
    setPickerAnchor(null)
  }, [])

  /** Clear the single-key/encoder selection and popover. */
  function clearSingleSelection(): void {
    setSelectedKey(null)
    setSelectedEncoder(null)
    setSelectedMaskPart(false)
    setPopoverState(null)
  }

  const [popoverState, setPopoverState] = useState<
    | { anchorRect: DOMRect; kind: 'key'; row: number; col: number; maskClicked: boolean }
    | { anchorRect: DOMRect; kind: 'encoder'; idx: number; dir: number }
    | null
  >(null)

  const [tdModalIndex, setTdModalIndex] = useState<number | null>(null)
  const [macroModalIndex, setMacroModalIndex] = useState<number | null>(null)

  // Close TD modal if entries shrink below the open index
  useEffect(() => {
    if (tdModalIndex !== null && (!tapDanceEntries || tdModalIndex >= tapDanceEntries.length)) {
      setTdModalIndex(null)
    }
  }, [tdModalIndex, tapDanceEntries])

  // Close macro modal if macroCount shrinks below the open index
  useEffect(() => {
    if (macroModalIndex !== null && (macroCount == null || macroModalIndex >= macroCount)) {
      setMacroModalIndex(null)
    }
  }, [macroModalIndex, macroCount])

  // Build a set of TD/Macro qmkIds that have at least one action configured
  const configuredKeycodes = useMemo(() => {
    const set = new Set<string>()
    if (tapDanceEntries) {
      for (let i = 0; i < tapDanceEntries.length; i++) {
        const e = tapDanceEntries[i]
        if (e.onTap || e.onHold || e.onDoubleTap || e.onTapHold) {
          set.add(`TD(${i})`)
        }
      }
    }
    if (macroBuffer && macroCount) {
      const macros = deserializeAllMacros(macroBuffer, vialProtocol ?? 0, macroCount)
      for (let i = 0; i < macros.length; i++) {
        if (macros[i].length > 0) {
          set.add(`M${i}`)
        }
      }
    }
    return set.size > 0 ? set : undefined
  }, [tapDanceEntries, macroBuffer, macroCount, vialProtocol])

  const remap = remapLabel ?? ((id: string) => id)

  // Layout options management (merged from LayoutEditor)
  const parsedOptions = useMemo(() => parseLayoutLabels(layoutLabels), [layoutLabels])
  const hasLayoutOptions = parsedOptions.length > 0
  const hasMatrixTester = (getMatrixState != null && rows != null && cols != null) || matrixMode

  useEffect(() => {
    onMatrixModeChange?.(matrixMode, hasMatrixTester)
  }, [matrixMode, hasMatrixTester, onMatrixModeChange])

  const [layoutValues, setLayoutValues] = useState<Map<number, number>>(() =>
    packedLayoutOptions != null && packedLayoutOptions >= 0
      ? unpackLayoutOptions(packedLayoutOptions, parsedOptions)
      : new Map(),
  )

  useEffect(() => {
    if (packedLayoutOptions != null && packedLayoutOptions >= 0) {
      setLayoutValues(unpackLayoutOptions(packedLayoutOptions, parsedOptions))
    }
  }, [packedLayoutOptions, parsedOptions])

  // Use local layout values for immediate feedback when available
  const effectiveLayoutOptions = hasLayoutOptions ? layoutValues : layoutOptions

  // Pre-compute the scaled min-height for the keyboard area container.
  // Uses only visible+repositioned keys so the container fits the actual content
  // instead of reserving space for hidden layout alternatives.
  const keyboardAreaMinHeight = useMemo(() => {
    if (!layout || layout.keys.length === 0) return 0
    const visible = filterVisibleKeys(
      repositionLayoutKeys(layout.keys, effectiveLayoutOptions),
      effectiveLayoutOptions,
    )
    if (visible.length === 0) return 0
    let minY = Infinity
    let maxY = -Infinity
    for (const key of visible) {
      const ky0 = KEY_UNIT * key.y
      const ky1 = KEY_UNIT * (key.y + key.height) - KEY_SPACING
      if (ky0 < minY) minY = ky0
      if (ky1 > maxY) maxY = ky1
    }
    const keySpan = (maxY - minY) * scaleProp
    const fixedChrome = KEYBOARD_PADDING * 2 + 20 + 16 // SVG padding + pt-3+pb-2 (20px) + info row (~16px)
    return keySpan + fixedChrome
  }, [layout, effectiveLayoutOptions, scaleProp])

  // Visible non-encoder, non-decal keys for Shift+click range selection
  const selectableKeys = useMemo(() => {
    if (!layout) return []
    const opts = effectiveLayoutOptions
    return layout.keys.filter((key) => {
      if (key.encoderIdx >= 0 || key.decal) return false
      if (key.layoutIndex >= 0) {
        const sel = opts.get(key.layoutIndex)
        return sel === undefined ? key.layoutOption === 0 : key.layoutOption === sel
      }
      return true
    })
  }, [layout, effectiveLayoutOptions])

  const handleLayoutOptionChange = useCallback(
    async (index: number, value: number) => {
      const newValues = new Map(layoutValues)
      newValues.set(index, value)
      setLayoutValues(newValues)
      if (onSetLayoutOptions) {
        const packed = packLayoutOptions(newValues, parsedOptions)
        await onSetLayoutOptions(packed)
      }
    },
    [layoutValues, parsedOptions, onSetLayoutOptions],
  )

  // Close layout panel on click-outside or Escape
  useEffect(() => {
    if (!layoutPanelOpen) return
    function onMouseDown(e: MouseEvent) {
      if (
        layoutPanelRef.current?.contains(e.target as Node) ||
        layoutButtonRef.current?.contains(e.target as Node)
      ) return
      setLayoutPanelOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setLayoutPanelOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [layoutPanelOpen])

  // --- Matrix tester polling ---
  const poll = useCallback(async () => {
    if (!pollingRef.current || !getMatrixState || rows == null || cols == null) return
    try {
      const data = await getMatrixState()
      if (!pollingRef.current) return
      const pressed = parseMatrixState(data, rows, cols)
      setPressedKeys(pressed)
      setEverPressedKeys((prev) => {
        const next = new Set(prev)
        for (const key of pressed) next.add(key)
        return next
      })
    } catch {
      // device may disconnect
    }
    if (pollingRef.current) {
      timerRef.current = setTimeout(poll, POLL_INTERVAL)
    }
  }, [getMatrixState, rows, cols])

  useEffect(() => {
    if (!matrixMode || !unlocked) return
    pollingRef.current = true
    poll()
    return () => {
      pollingRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [poll, matrixMode, unlocked])

  // Deferred matrix mode entry: when the keyboard is locked, we request
  // unlock first and enter matrix mode once `unlocked` becomes true.
  const [pendingMatrix, setPendingMatrix] = useState(false)

  const enterMatrixMode = useCallback(() => {
    setMatrixMode(true)
  }, [])

  useEffect(() => {
    if (pendingMatrix && unlocked) {
      setPendingMatrix(false)
      enterMatrixMode()
    }
  }, [pendingMatrix, unlocked, enterMatrixMode])

  const resetMatrixState = useCallback(() => {
    setPressedKeys(new Set())
    setEverPressedKeys(new Set())
    setMatrixMode(false)
  }, [])

  // Exit key tester when the keyboard is locked
  useEffect(() => {
    if (!unlocked && matrixMode) resetMatrixState()
  }, [unlocked, matrixMode, resetMatrixState])

  // --- Typing test ---
  const typingTest = useTypingTest(savedTypingTestConfig, savedTypingTestLanguage)
  const {
    restart: restartTypingTest,
    restartWithCountdown,
    processMatrixFrame,
    processKeyEvent,
    setWindowFocused,
  } = typingTest
  const [pendingTypingTest, setPendingTypingTest] = useState(false)

  useEffect(() => {
    if (pendingTypingTest && unlocked) {
      setPendingTypingTest(false)
      enterMatrixMode()
      restartWithCountdown()
      onTypingTestModeChange?.(true)
    }
  }, [pendingTypingTest, unlocked, enterMatrixMode, restartWithCountdown, onTypingTestModeChange])

  // Exit typing test when the keyboard is locked
  useEffect(() => {
    if (!unlocked && typingTestMode) {
      resetMatrixState()
      onTypingTestModeChange?.(false)
    }
  }, [unlocked, typingTestMode, resetMatrixState, onTypingTestModeChange])

  const handleTypingTestToggle = useCallback(() => {
    if (typingTestMode) {
      resetMatrixState()
      onTypingTestModeChange?.(false)
    } else if (unlocked) {
      enterMatrixMode()
      restartTypingTest()
      onTypingTestModeChange?.(true)
    } else {
      setPendingTypingTest(true)
      onUnlock?.()
    }
  }, [typingTestMode, unlocked, resetMatrixState, enterMatrixMode, restartTypingTest, onTypingTestModeChange, onUnlock])

  // Feed matrix frames to typing test.
  // Only re-run when pressedKeys changes (the primary trigger for new input).
  // processMatrixFrame and keymap are stable references.
  useEffect(() => {
    if (!typingTestMode) return
    processMatrixFrame(pressedKeys, keymap)
  }, [pressedKeys, typingTestMode, processMatrixFrame, keymap])

  // Capture-phase keydown listener: routes DOM key events to the typing test
  // and prevents default browser actions (e.g. Tab focus changes).
  // Let Ctrl-only and Meta combos through so app shortcuts (Ctrl+C, etc.) still work.
  // AltGr (Ctrl+Alt) on international keyboards must be forwarded to processKeyEvent.
  // Skip when a dialog is open so its inputs receive key events normally.
  useEffect(() => {
    if (!typingTestMode) return
    function handler(e: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return
      if (e.isComposing) return
      // When IME is active but not composing, e.key is 'Process' for all keys.
      // Use e.code to resolve submit/control keys; let other keys through so
      // the IME can start a new composition via the hidden textarea.
      let key = e.key
      if (key === 'Process') {
        const resolved = PROCESS_CODE_TO_KEY.get(e.code)
        if (!resolved) return
        key = resolved
      }
      if (e.metaKey) return
      if (e.ctrlKey && !e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      processKeyEvent(key, e.ctrlKey, e.altKey, e.metaKey)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [typingTestMode, processKeyEvent])

  // Auto-save typing test result when test finishes
  const savedResultRef = useRef(false)
  useEffect(() => {
    if (typingTest.state.status === 'finished' && !savedResultRef.current && onSaveTypingTestResult) {
      savedResultRef.current = true
      const elapsed = typingTest.state.startTime && typingTest.state.endTime
        ? typingTest.state.endTime - typingTest.state.startTime
        : 0
      const result = buildTypingTestResult({
        correctChars: typingTest.state.correctChars,
        incorrectChars: typingTest.state.incorrectChars,
        wordCount: typingTest.state.currentWordIndex,
        wpm: typingTest.wpm,
        accuracy: typingTest.accuracy,
        elapsedMs: elapsed,
        config: typingTest.config,
        language: typingTest.language,
        wpmHistory: typingTest.state.wpmHistory,
      })
      result.isPb = isPbForConfig(result, typingTestHistory ?? [])
      onSaveTypingTestResult(result)
    }
    if (typingTest.state.status !== 'finished') {
      savedResultRef.current = false
    }
  }, [typingTest.state.status, typingTest.state.startTime, typingTest.state.endTime,
    typingTest.state.correctChars, typingTest.state.incorrectChars,
    typingTest.state.currentWordIndex, typingTest.state.wpmHistory,
    typingTest.wpm, typingTest.accuracy,
    typingTest.config, typingTest.language,
    typingTestHistory, onSaveTypingTestResult])

  // Sync saved config/language from device prefs into useTypingTest.
  // Uses JSON comparison to avoid loops: persist callbacks also update the ref.
  const lastSyncedConfigRef = useRef('')
  useEffect(() => {
    const target = savedTypingTestConfig
    const json = target ? JSON.stringify(target) : ''
    if (json === lastSyncedConfigRef.current) return
    lastSyncedConfigRef.current = json
    typingTest.setConfig(target ?? DEFAULT_CONFIG)
  }, [savedTypingTestConfig, typingTest.setConfig])

  const lastSyncedLanguageRef = useRef('')
  useEffect(() => {
    const target = savedTypingTestLanguage
    if ((target ?? '') === lastSyncedLanguageRef.current) return
    lastSyncedLanguageRef.current = target ?? ''
    typingTest.setLanguage(target ?? DEFAULT_LANGUAGE)
  }, [savedTypingTestLanguage, typingTest.setLanguage])

  // Wrapped setters that persist user-initiated changes to device prefs
  const handleTypingTestConfigChange = useCallback((newConfig: TypingTestConfig) => {
    typingTest.setConfig(newConfig)
    lastSyncedConfigRef.current = JSON.stringify(newConfig)
    onTypingTestConfigChange?.(newConfig)
  }, [typingTest.setConfig, onTypingTestConfigChange])

  const handleTypingTestLanguageChange = useCallback(async (newLanguage: string) => {
    const resolved = await typingTest.setLanguage(newLanguage)
    lastSyncedLanguageRef.current = resolved
    onTypingTestLanguageChange?.(resolved)
  }, [typingTest.setLanguage, onTypingTestLanguageChange])

  // Window focus/blur listeners: pause the typing test when the window loses focus.
  // Sync initial state on mode enter so stale windowFocused=false doesn't block input.
  useEffect(() => {
    if (!typingTestMode) return
    setWindowFocused(document.hasFocus() && document.visibilityState === 'visible')
    function onBlur() { setWindowFocused(false) }
    function onFocus() { setWindowFocused(true) }
    function onVisibility() { setWindowFocused(document.visibilityState === 'visible') }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [typingTestMode, setWindowFocused])

  const { guard, clearPending } = useUnlockGate({ unlocked, onUnlock })

  const handleMatrixToggle = useCallback(() => {
    if (matrixMode) {
      resetMatrixState()
    } else if (unlocked) {
      enterMatrixMode()
    } else {
      setPendingMatrix(true)
      onUnlock?.()
    }
  }, [matrixMode, unlocked, resetMatrixState, enterMatrixMode, onUnlock])

  useImperativeHandle(ref, () => ({
    toggleMatrix: handleMatrixToggle,
    matrixMode,
    hasMatrixTester,
  }), [handleMatrixToggle, matrixMode, hasMatrixTester])

  // Build keycodes map for a given layer: "row,col" -> serialized QMK ID
  // Also build a set of position keys whose keycode is remapped in the current layout
  const buildKeycodesForLayer = useCallback((layer: number) => {
    const keycodes = new Map<string, string>()
    const remapped = new Set<string>()
    const checkRemapped = isRemapped ?? (() => false)
    for (const [key, code] of keymap) {
      const [l, r, c] = key.split(',')
      if (Number(l) === layer) {
        const posKey = `${r},${c}`
        const qmkId = serialize(code)
        keycodes.set(posKey, remap(qmkId))
        if (!isMask(qmkId) && checkRemapped(qmkId)) {
          remapped.add(posKey)
        }
      }
    }
    return { keycodes, remapped }
  }, [keymap, remap, isRemapped])

  // Build encoder keycodes for a given layer: "idx" -> [CW, CCW]
  const buildEncoderKeycodesForLayer = useCallback((layer: number) => {
    const map = new Map<string, [string, string]>()
    for (let i = 0; i < encoderCount; i++) {
      const cw = encoderLayout.get(`${layer},${i},0`) ?? 0
      const ccw = encoderLayout.get(`${layer},${i},1`) ?? 0
      map.set(String(i), [remap(serialize(cw)), remap(serialize(ccw))])
    }
    return map
  }, [encoderLayout, encoderCount, remap])

  const { keycodes: layerKeycodes, remapped: remappedKeys } = useMemo(
    () => buildKeycodesForLayer(currentLayer),
    [buildKeycodesForLayer, currentLayer],
  )

  const layerEncoderKeycodes = useMemo(
    () => buildEncoderKeycodesForLayer(currentLayer),
    [buildEncoderKeycodesForLayer, currentLayer],
  )

  // Resolve per-pane layer numbers: fall back to currentLayer when not provided.
  const effectivePrimaryLayer = primaryLayerProp ?? currentLayer
  const effectiveSecondaryLayer = secondaryLayerProp ?? currentLayer

  // Inactive pane shows the opposite pane's layer; undefined when not in dual mode.
  const inactivePaneLayer = dualMode
    ? (activePane === 'primary' ? effectiveSecondaryLayer : effectivePrimaryLayer)
    : undefined

  const { keycodes: inactiveLayerKeycodes, remapped: inactiveRemappedKeys } = useMemo(
    () => inactivePaneLayer != null
      ? buildKeycodesForLayer(inactivePaneLayer)
      : { keycodes: EMPTY_KEYCODES, remapped: EMPTY_REMAPPED },
    [buildKeycodesForLayer, inactivePaneLayer],
  )

  const inactiveEncoderKeycodes = useMemo(
    () => inactivePaneLayer != null
      ? buildEncoderKeycodesForLayer(inactivePaneLayer)
      : EMPTY_ENCODER_KEYCODES,
    [buildEncoderKeycodesForLayer, inactivePaneLayer],
  )

  // Keycodes for the typing test keyboard pane: follows the effective layer
  const { keycodes: typingTestKeycodes, remapped: typingTestRemapped } = useMemo(
    () => typingTestMode
      ? buildKeycodesForLayer(typingTest.effectiveLayer)
      : { keycodes: EMPTY_KEYCODES, remapped: EMPTY_REMAPPED },
    [buildKeycodesForLayer, typingTest.effectiveLayer, typingTestMode],
  )

  const typingTestEncoderKeycodes = useMemo(
    () => typingTestMode
      ? buildEncoderKeycodesForLayer(typingTest.effectiveLayer)
      : EMPTY_ENCODER_KEYCODES,
    [buildEncoderKeycodesForLayer, typingTest.effectiveLayer, typingTestMode],
  )

  // Get selected key's current QMK ID string
  const selectedKeycode = useMemo(() => {
    if (selectedKey) {
      const code = keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0
      return serialize(code)
    }
    if (selectedEncoder) {
      const code = encoderLayout.get(`${currentLayer},${selectedEncoder.idx},${selectedEncoder.dir}`) ?? 0
      return serialize(code)
    }
    return null
  }, [selectedKey, selectedEncoder, keymap, encoderLayout, currentLayer])

  const isMaskKey = selectedKeycode != null && isMask(selectedKeycode) && selectedMaskPart

  // Detect LM mask mode for the bottom keycode palette
  const isLMMask = useMemo(() => {
    if (!isMaskKey || !selectedKey) return false
    const code = keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0
    return isLMKeycode(code)
  }, [isMaskKey, selectedKey, keymap, currentLayer])

  // Resolve the final keycode to set, merging inner byte for mask keys
  function resolveKeycode(currentCode: number, newCode: number, maskMode: boolean): number {
    if (maskMode) {
      // LM uses non-standard bit layout: layer in bits 5-8, mod in bits 0-4 (v6)
      if (isLMKeycode(currentCode)) {
        const modMask = resolve('QMK_LM_MASK')
        return (currentCode & ~modMask) | (newCode & modMask)
      }
      return (currentCode & 0xff00) | (newCode & 0x00ff)
    }
    return newCode
  }

  // Visible non-decal, non-encoder keys for auto-advance
  const advancableKeys = useMemo(() => {
    if (!layout) return []
    return layout.keys.filter((k) => !k.decal && k.encoderIdx < 0)
  }, [layout])

  // Open the tap-dance modal for a given raw keycode if it is a valid TD index
  const openTdModal = useCallback(
    (rawCode: number) => {
      if (!tapDanceEntries || !onSetTapDanceEntry) return
      if (!isTapDanceKeycode(rawCode)) return
      const idx = getTapDanceIndex(rawCode)
      if (idx >= tapDanceEntries.length) return
      setTdModalIndex(idx)
    },
    [tapDanceEntries, onSetTapDanceEntry],
  )

  // Open the macro modal for a given raw keycode if it is a valid macro index.
  // When the keyboard is locked, trigger the unlock flow with a macro warning
  // instead of opening the modal. The user can click the macro key again after
  // unlocking to open the editor.
  const openMacroModal = useCallback(
    (rawCode: number) => {
      if (macroCount == null || macroCount === 0 || !onSaveMacros || !macroBuffer || !macroBufferSize) return
      if (!isMacroKeycode(rawCode)) return
      const idx = getMacroIndex(rawCode)
      if (idx >= macroCount) return
      if (unlocked === false) {
        onUnlock?.({ macroWarning: true })
        return
      }
      setMacroModalIndex(idx)
    },
    [macroCount, macroBuffer, macroBufferSize, onSaveMacros, unlocked, onUnlock],
  )

  // Track whether the layer change is from a pane switch (not a manual layer change)
  const prevLayerRef = useRef(currentLayer)
  const prevActivePaneRef = useRef(activePane)

  useEffect(() => {
    const layerChanged = prevLayerRef.current !== currentLayer
    const paneChanged = prevActivePaneRef.current !== activePane
    prevLayerRef.current = currentLayer
    prevActivePaneRef.current = activePane

    setPopoverState(null)
    // Only clear multi-selection if the layer changed independently (not due to a pane switch)
    if (layerChanged && !paneChanged) {
      clearMultiSelection()
      clearPickerSelection()
    }
    setCopyAllPending(false)
  }, [currentLayer, activePane, clearMultiSelection, clearPickerSelection])

  // Clear single selection when active pane changes; keep multi-selection for click-to-paste
  useEffect(() => {
    clearSingleSelection()
  }, [activePane])

  // Clear multi-selection when dual mode is turned off
  useEffect(() => {
    if (!dualMode) {
      clearMultiSelection()
      setCopyAllPending(false)
    }
  }, [dualMode, clearMultiSelection])

  /** Run an async copy operation with a re-entrancy guard. */
  const runCopy = useCallback(async (fn: () => Promise<void>) => {
    if (isCopyingRef.current) return
    isCopyingRef.current = true
    setIsCopying(true)
    try {
      await fn()
    } finally {
      isCopyingRef.current = false
      setIsCopying(false)
    }
  }, [])

  const handleClickToPaste = useCallback(async (targetKey: KleKey) => {
    if (effectivePrimaryLayer === effectiveSecondaryLayer) return
    const srcLayer = selectionSourcePane === 'primary' ? effectivePrimaryLayer : effectiveSecondaryLayer
    const tgtLayer = currentLayer

    // Source key order: Shift=layout order, Ctrl=selection (click) order
    let orderedSourceKeys: string[]
    if (selectionMode === 'shift') {
      orderedSourceKeys = selectableKeys
        .filter((k) => multiSelectedKeys.has(`${k.row},${k.col}`))
        .map((k) => `${k.row},${k.col}`)
    } else {
      orderedSourceKeys = [...multiSelectedKeys]
    }

    // Target: consecutive from click position in layout order
    const targetIdx = selectableKeys.findIndex(
      (k) => k.row === targetKey.row && k.col === targetKey.col,
    )
    if (targetIdx < 0) return
    const targetPositions = selectableKeys.slice(targetIdx, targetIdx + orderedSourceKeys.length)

    await runCopy(async () => {
      const entries: BulkKeyEntry[] = []
      for (let i = 0; i < targetPositions.length; i++) {
        const [srcR, srcC] = orderedSourceKeys[i].split(',').map(Number)
        const code = keymap.get(`${srcLayer},${srcR},${srcC}`)
        if (code !== undefined) {
          entries.push({ layer: tgtLayer, row: targetPositions[i].row, col: targetPositions[i].col, keycode: code })
        }
      }
      await onSetKeysBulk(entries)
    })

    clearMultiSelection()
  }, [effectivePrimaryLayer, effectiveSecondaryLayer, selectionSourcePane, selectionMode,
    selectableKeys, multiSelectedKeys, currentLayer, keymap, onSetKeysBulk, runCopy, clearMultiSelection])

  // Mirror pickerAnchor into a ref so handlePickerMultiSelect can read
  // the latest value without listing it as a dependency (avoids stale closure).
  const pickerAnchorRef = useRef<string | null>(null)
  pickerAnchorRef.current = pickerAnchor

  const handlePickerMultiSelect = useCallback(
    (kc: Keycode, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodes: Keycode[]) => {
      if (selectedKey || selectedEncoder) return

      clearMultiSelection()

      if (event.ctrlKey) {
        setPickerSelectedKeycodes((prev) => {
          const exists = prev.some((k) => k.qmkId === kc.qmkId)
          return exists ? prev.filter((k) => k.qmkId !== kc.qmkId) : [...prev, kc]
        })
        setPickerAnchor(kc.qmkId)
      } else if (event.shiftKey) {
        const anchor = pickerAnchorRef.current
        if (!anchor) {
          // No anchor yet: select just the clicked keycode and set anchor
          setPickerSelectedKeycodes([kc])
          setPickerAnchor(kc.qmkId)
          return
        }
        const anchorIdx = tabKeycodes.findIndex((k) => k.qmkId === anchor)
        const currentIdx = tabKeycodes.findIndex((k) => k.qmkId === kc.qmkId)
        if (anchorIdx >= 0 && currentIdx >= 0) {
          const start = Math.min(anchorIdx, currentIdx)
          const end = Math.max(anchorIdx, currentIdx)
          // Replace entire selection with the range in tab (display) order
          setPickerSelectedKeycodes(tabKeycodes.slice(start, end + 1))
        }
      }
    },
    [selectedKey, selectedEncoder, clearMultiSelection],
  )

  const handlePickerPaste = useCallback(async (targetKey: KleKey) => {
    const targetIdx = selectableKeys.findIndex(
      (k) => k.row === targetKey.row && k.col === targetKey.col,
    )
    if (targetIdx < 0) return
    const targetPositions = selectableKeys.slice(targetIdx, targetIdx + pickerSelectedKeycodes.length)

    await runCopy(async () => {
      const entries: BulkKeyEntry[] = []
      for (let i = 0; i < targetPositions.length; i++) {
        const code = deserialize(pickerSelectedKeycodes[i].qmkId)
        entries.push({ layer: currentLayer, row: targetPositions[i].row, col: targetPositions[i].col, keycode: code })
      }
      await onSetKeysBulk(entries)
    })

    clearPickerSelection()
  }, [pickerSelectedKeycodes, selectableKeys, currentLayer, onSetKeysBulk, runCopy, clearPickerSelection])

  const handleKeyClick = useCallback(
    (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => {
      const posKey = `${key.row},${key.col}`

      // Picker paste: paste selected keycodes from picker to keymap
      if (pickerSelectedKeycodes.length > 0 && !event?.ctrlKey && !event?.shiftKey) {
        handlePickerPaste(key)
        return
      }

      if (event?.ctrlKey && !selectedKey) {
        // Ctrl+click: toggle key in multi-selection (only when no key is single-selected)
        clearPickerSelection()
        setMultiSelectedKeys((prev) => {
          const next = new Set(prev)
          if (next.has(posKey)) next.delete(posKey)
          else next.add(posKey)
          return next
        })
        setSelectionAnchor({ row: key.row, col: key.col })
        setSelectionSourcePane(activePane)
        setSelectionMode('ctrl')
        return
      }

      if (event?.shiftKey && !selectedKey && selectionAnchor) {
        // Shift+click: range select from anchor to current (only when no key is single-selected)
        clearPickerSelection()
        const anchorIdx = selectableKeys.findIndex(
          (k) => k.row === selectionAnchor.row && k.col === selectionAnchor.col,
        )
        const currentIdx = selectableKeys.findIndex(
          (k) => k.row === key.row && k.col === key.col,
        )
        if (anchorIdx >= 0 && currentIdx >= 0) {
          const start = Math.min(anchorIdx, currentIdx)
          const end = Math.max(anchorIdx, currentIdx)
          const next = new Set(multiSelectedKeys)
          for (let i = start; i <= end; i++) {
            next.add(`${selectableKeys[i].row},${selectableKeys[i].col}`)
          }
          setMultiSelectedKeys(next)
        }
        setSelectionSourcePane(activePane)
        setSelectionMode('shift')
        return
      }

      // Normal click with selection from another pane: click-to-paste
      const hasSelectionFromOtherPane = selectionSourcePane != null
        && selectionSourcePane !== activePane
        && multiSelectedKeys.size > 0
        && effectivePrimaryLayer !== effectiveSecondaryLayer
      if (dualMode && hasSelectionFromOtherPane) {
        handleClickToPaste(key)
        return
      }

      // Normal click: existing behavior + clear multi-selection
      setMultiSelectedKeys(new Set())
      setSelectionAnchor({ row: key.row, col: key.col })
      setSelectionSourcePane(null)
      setPopoverState((prev) => {
        if (!prev) return null
        if (prev.kind !== 'key' || prev.row !== key.row || prev.col !== key.col) return null
        return { ...prev, maskClicked }
      })
      setSelectedKey({ row: key.row, col: key.col })
      setSelectedMaskPart(maskClicked)
      setSelectedEncoder(null)
    },
    [dualMode, activePane, selectedKey, selectionAnchor, selectableKeys, multiSelectedKeys, selectionSourcePane, effectivePrimaryLayer, effectiveSecondaryLayer, handleClickToPaste, pickerSelectedKeycodes, handlePickerPaste, clearPickerSelection],
  )

  const handleEncoderClick = useCallback((_key: KleKey, dir: number) => {
    setSelectedEncoder({ idx: _key.encoderIdx, dir })
    setSelectedKey(null)
    setSelectedMaskPart(false)
    setPopoverState(null)
  }, [])

  const handleKeyDoubleClick = useCallback((key: KleKey, rect: DOMRect, maskClicked: boolean) => {
    setSelectedKey({ row: key.row, col: key.col })
    setSelectedMaskPart(maskClicked)
    setSelectedEncoder(null)
    setPopoverState({ anchorRect: rect, kind: 'key', row: key.row, col: key.col, maskClicked })
  }, [])

  const handleEncoderDoubleClick = useCallback((_key: KleKey, dir: number, rect: DOMRect) => {
    setSelectedEncoder({ idx: _key.encoderIdx, dir })
    setSelectedKey(null)
    setPopoverState({ anchorRect: rect, kind: 'encoder', idx: _key.encoderIdx, dir })
  }, [])

  const handleTdModalSave = useCallback(
    async (idx: number, entry: TapDanceEntry) => {
      const codes = [entry.onTap, entry.onHold, entry.onDoubleTap, entry.onTapHold]
      await guard(codes, async () => {
        await onSetTapDanceEntry?.(idx, entry)
        setTdModalIndex(null)
      })
    },
    [onSetTapDanceEntry, guard],
  )

  const handleTdModalClose = useCallback(() => {
    clearPending()
    setTdModalIndex(null)
  }, [clearPending])

  const handleMacroModalClose = useCallback(() => {
    setMacroModalIndex(null)
  }, [])

  const handleDeselect = useCallback(() => {
    clearSingleSelection()
    clearMultiSelection()
    clearPickerSelection()
    setCopyAllPending(false)
  }, [clearMultiSelection, clearPickerSelection])

  const handleDeselectClick = useCallback((e: React.MouseEvent) => {
    if (!hasModifierKey(e)) handleDeselect()
  }, [handleDeselect])

  // Advance to next key in the layout
  const advanceToNextKey = useCallback(() => {
    if (!autoAdvance || !selectedKey || advancableKeys.length === 0) return
    const currentIdx = advancableKeys.findIndex(
      (k) => k.row === selectedKey.row && k.col === selectedKey.col,
    )
    if (currentIdx >= 0 && currentIdx < advancableKeys.length - 1) {
      const next = advancableKeys[currentIdx + 1]
      setSelectedKey({ row: next.row, col: next.col })
      setSelectedMaskPart(false)
    }
  }, [autoAdvance, advancableKeys, selectedKey])

  const handleKeycodeSelect = useCallback(
    async (kc: Keycode) => {
      clearPickerSelection()
      clearPending()
      const code = deserialize(kc.qmkId)
      if (selectedKey) {
        await guard([code], async () => {
          const currentCode = keymap.get(`${currentLayer},${selectedKey.row},${selectedKey.col}`) ?? 0
          const finalCode = resolveKeycode(currentCode, code, isMaskKey)
          await onSetKey(currentLayer, selectedKey.row, selectedKey.col, finalCode)
          if (!isMaskKey && isMask(kc.qmkId) && autoAdvance) {
            // Masked keycode (e.g. LT, MT): advance to inner byte editing
            setSelectedMaskPart(true)
          } else {
            advanceToNextKey()
          }
        })
      } else if (selectedEncoder) {
        await guard([code], async () => {
          await onSetEncoder(currentLayer, selectedEncoder.idx, selectedEncoder.dir, code)
        })
      } else {
        // No key/encoder selected: open TD/Macro modal if applicable
        openTdModal(code)
        openMacroModal(code)
      }
    },
    [selectedKey, selectedEncoder, currentLayer, keymap, isMaskKey, autoAdvance, onSetKey, onSetEncoder, advanceToNextKey, openTdModal, openMacroModal, guard, clearPending, clearPickerSelection],
  )

  const handlePopoverKeycodeSelect = useCallback(
    async (kc: Keycode) => {
      clearPending()
      if (!popoverState) return
      const code = deserialize(kc.qmkId)
      if (popoverState.kind === 'key') {
        const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
        const popoverMask = popoverState.maskClicked && isMask(serialize(currentCode))
        await guard([code], async () => {
          const finalCode = resolveKeycode(currentCode, code, popoverMask)
          await onSetKey(currentLayer, popoverState.row, popoverState.col, finalCode)
        })
      } else {
        await guard([code], async () => {
          await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, code)
        })
      }
    },
    [popoverState, currentLayer, keymap, onSetKey, onSetEncoder, guard, clearPending],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    async (code: number) => {
      clearPending()
      if (!popoverState) return
      if (popoverState.kind === 'key') {
        await guard([code], async () => {
          await onSetKey(currentLayer, popoverState.row, popoverState.col, code)
        })
      } else {
        await guard([code], async () => {
          await onSetEncoder(currentLayer, popoverState.idx, popoverState.dir, code)
        })
      }
    },
    [popoverState, currentLayer, onSetKey, onSetEncoder, guard, clearPending],
  )

  const handlePopoverModMaskChange = useCallback(
    async (newMask: number) => {
      if (!popoverState || popoverState.kind !== 'key') return
      const currentCode = keymap.get(`${currentLayer},${popoverState.row},${popoverState.col}`) ?? 0
      const basicKey = extractBasicKey(currentCode)
      const newCode = buildModMaskKeycode(newMask, basicKey)
      await guard([newCode], async () => {
        await onSetKey(currentLayer, popoverState.row, popoverState.col, newCode)
      })
    },
    [popoverState, currentLayer, keymap, onSetKey, guard],
  )

  const handleCopyAllClick = useCallback(async () => {
    if (!copyAllPending) {
      // First click -- show confirmation (stays until second click or deselect)
      setCopyAllPending(true)
      return
    }
    // Second click -- execute copy
    setCopyAllPending(false)
    if (inactivePaneLayer == null) return
    const src = currentLayer
    const tgt = inactivePaneLayer
    await runCopy(async () => {
      const entries: BulkKeyEntry[] = []
      for (const [key, code] of keymap) {
        const [l, r, c] = key.split(',').map(Number)
        if (l === src) entries.push({ layer: tgt, row: r, col: c, keycode: code })
      }
      await onSetKeysBulk(entries)
      for (let i = 0; i < encoderCount; i++) {
        for (let dir = 0; dir < 2; dir++) {
          const code = encoderLayout.get(`${src},${i},${dir}`) ?? 0
          await onSetEncoder(tgt, i, dir, code)
        }
      }
    })
  }, [copyAllPending, currentLayer, inactivePaneLayer, keymap, onSetKeysBulk, encoderLayout, encoderCount, onSetEncoder, runCopy])

  const tabFooterContent = useMemo(() => {
    const btnClass = 'rounded border border-edge px-3 py-1 text-xs text-content-secondary hover:text-content hover:bg-surface-dim'

    const buttonDefs = [
      { tab: 'tapDance', key: 'tapHold', label: t('editor.keymap.tapHoldLabel'), onClick: () => setShowTapHoldSettings(true), testId: 'tap-hold-settings-btn', enabled: tapHoldSupported },
      { tab: 'media', key: 'mouseKeys', label: t('editor.keymap.mouseKeysLabel'), onClick: () => setShowMouseKeysSettings(true), testId: 'mouse-keys-settings-btn', enabled: mouseKeysSupported },
      { tab: 'modifiers', key: 'graveEscape', label: t('editor.keymap.graveEscapeLabel'), onClick: () => setShowGraveEscapeSettings(true), testId: 'grave-escape-settings-btn', enabled: graveEscapeSupported },
      { tab: 'modifiers', key: 'oneShotKeys', label: t('editor.keymap.oneShotKeysLabel'), onClick: () => setShowOneShotKeysSettings(true), testId: 'one-shot-keys-settings-btn', enabled: oneShotKeysSupported },
      { tab: 'quantum', key: 'magic', label: t('editor.keymap.magicLabel'), onClick: () => setShowMagicSettings(true), testId: 'magic-settings-btn', enabled: magicSupported },
      { tab: 'quantum', key: 'autoshift', label: t('editor.keymap.autoShiftLabel'), onClick: () => setShowAutoShiftSettings(true), testId: 'auto-shift-settings-btn', enabled: autoShiftSupported },
      { tab: 'quantum', key: 'combo', label: t('editor.combo.title'), onClick: onOpenCombo, testId: 'combo-settings-btn', enabled: !!onOpenCombo },
      { tab: 'quantum', key: 'altRepeatKey', label: t('editor.altRepeatKey.title'), onClick: onOpenAltRepeatKey, testId: 'alt-repeat-key-settings-btn', enabled: !!onOpenAltRepeatKey },
      { tab: 'quantum', key: 'keyOverride', label: t('editor.keyOverride.title'), onClick: onOpenKeyOverride, testId: 'key-override-settings-btn', enabled: !!onOpenKeyOverride },
      { tab: 'backlight', key: 'lighting', label: t('editor.lighting.title'), onClick: onOpenLighting, testId: 'lighting-settings-btn', enabled: !!onOpenLighting },
    ]

    const content: Record<string, React.ReactNode> = {}
    const grouped = new Map<string, typeof buttonDefs>()

    for (const def of buttonDefs) {
      if (!def.enabled) continue
      const existing = grouped.get(def.tab)
      if (existing) {
        existing.push(def)
      } else {
        grouped.set(def.tab, [def])
      }
    }

    for (const [tab, defs] of grouped) {
      content[tab] = (
        <div className="flex items-center gap-2">
          <span className="text-xs text-content-secondary/70">{t('common.settingsLabel')}</span>
          {defs.map((d) => (
            <button key={d.key} type="button" className={btnClass} onClick={d.onClick} data-testid={d.testId}>
              {d.label}
            </button>
          ))}
        </div>
      )
    }

    return content
  }, [tapHoldSupported, mouseKeysSupported, magicSupported, autoShiftSupported, graveEscapeSupported, oneShotKeysSupported, onOpenLighting, onOpenCombo, onOpenAltRepeatKey, onOpenKeyOverride, t])

  if (!layout) {
    return <div className="p-4 text-content-muted">{t('common.loading')}</div>
  }

  function layerLabel(layer: number): string {
    return layerNames?.[layer] || t('editor.keymap.layerN', { n: layer })
  }

  // Map active/inactive data to primary/secondary panes.
  // The active pane always uses the current-layer keycodes; the inactive pane
  // uses the precomputed inactive-layer keycodes.
  const primaryIsCurrent = !dualMode || activePane === 'primary'
  const primaryKeycodes = primaryIsCurrent ? layerKeycodes : inactiveLayerKeycodes
  const primaryEncoderKeycodes = primaryIsCurrent ? layerEncoderKeycodes : inactiveEncoderKeycodes
  const primaryRemapped = primaryIsCurrent ? remappedKeys : inactiveRemappedKeys
  const secondaryKeycodes = primaryIsCurrent ? inactiveLayerKeycodes : layerKeycodes
  const secondaryEncoderKeycodes = primaryIsCurrent ? inactiveEncoderKeycodes : layerEncoderKeycodes
  const secondaryRemapped = primaryIsCurrent ? inactiveRemappedKeys : remappedKeys

  // Paste readiness: either from picker multi-select or from pane-to-pane selection
  const canCopy = !!dualMode && effectivePrimaryLayer !== effectiveSecondaryLayer
  const pickerPasteReady = pickerSelectedKeycodes.length > 0
  const panePasteReady = canCopy
    && selectionSourcePane != null
    && selectionSourcePane !== activePane
    && multiSelectedKeys.size > 0
  const pasteReady = panePasteReady || pickerPasteReady
  const showCopyAll = canCopy && !panePasteReady
  const pasteHintText = pasteReady ? t('editor.keymap.clickToPaste') : undefined
  const copyAllConfirmText = inactivePaneLayer != null
    ? t('editor.keymap.copyAllConfirm', { source: layerLabel(currentLayer), target: layerLabel(inactivePaneLayer) })
    : undefined

  const zoomButtonClass = `${toggleButtonClass(false)} disabled:opacity-30 disabled:pointer-events-none`

  const toolbar = (
    <div className="flex shrink-0 flex-col gap-1 self-start">
      {!typingTestMode && onOpenEditorSettings && (
        <IconTooltip label={t('editorSettings.title')}>
          <button
            type="button"
            data-testid="editor-settings-button"
            aria-label={t('editorSettings.title')}
            className={toggleButtonClass(false)}
            onClick={onOpenEditorSettings}
          >
            {panelSide === 'left' ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelRightOpen size={16} aria-hidden="true" />}
          </button>
        </IconTooltip>
      )}
      {!typingTestMode && onDualModeChange && (
        <IconTooltip label={t('editor.keymap.dualMode')}>
          <button
            type="button"
            data-testid="dual-mode-button"
            aria-label={t('editor.keymap.dualMode')}
            className={toggleButtonClass(dualMode ?? false)}
            onClick={() => onDualModeChange(!dualMode)}
          >
            <Columns2 size={16} aria-hidden="true" />
          </button>
        </IconTooltip>
      )}
      {onTypingTestModeChange && hasMatrixTester && (
        <IconTooltip label={t('editor.typingTest.title')}>
          <button
            type="button"
            data-testid="typing-test-button"
            aria-label={t('editor.typingTest.title')}
            className={toggleButtonClass(typingTestMode ?? false)}
            onClick={handleTypingTestToggle}
          >
            <Keyboard size={16} aria-hidden="true" />
          </button>
        </IconTooltip>
      )}
      {!typingTestMode && onScaleChange && (
        <>
          <IconTooltip label={t('editor.keymap.zoomIn')}>
            <button
              type="button"
              data-testid="zoom-in-button"
              aria-label={t('editor.keymap.zoomIn')}
              className={zoomButtonClass}
              disabled={scaleProp >= MAX_SCALE}
              onClick={() => onScaleChange(0.1)}
            >
              <ZoomIn size={16} aria-hidden="true" />
            </button>
          </IconTooltip>
          <IconTooltip label={t('editor.keymap.zoomOut')}>
            <button
              type="button"
              data-testid="zoom-out-button"
              aria-label={t('editor.keymap.zoomOut')}
              className={zoomButtonClass}
              disabled={scaleProp <= MIN_SCALE}
              onClick={() => onScaleChange(-0.1)}
            >
              <ZoomOut size={16} aria-hidden="true" />
            </button>
          </IconTooltip>
        </>
      )}
      {!typingTestMode && onLayerChange && layers > 1 && (
        <div className="flex flex-col items-center" role="group" aria-label={t('editor.keymap.layerLabel')}>
          <div
            className="relative overflow-hidden"
            style={{
              width: `${PAGER_CELL_REM}rem`,
              height: `${PAGER_VIEWPORT_REM}rem`,
            }}
          >
            <div
              className={`pointer-events-none absolute left-0 rounded-full bg-tab-bg-active ${PAGER_CELL}`}
              style={{ top: `${PAGER_CENTER * PAGER_STRIDE}rem` }}
            />
            <div
              className="absolute left-0 flex flex-col transition-transform duration-200 ease-out"
              style={{
                gap: `${PAGER_GAP_REM}rem`,
                transform: `translateY(${-currentLayer * PAGER_STRIDE}rem)`,
              }}
            >
              <PagerSpacers count={PAGER_CENTER} prefix="pre" />
              {Array.from({ length: layers }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className={layerButtonClass(i === currentLayer)}
                  aria-current={i === currentLayer ? 'true' : undefined}
                  onClick={() => { if (i !== currentLayer) onLayerChange(i) }}
                  aria-label={t('editor.keymap.layerN', { n: i })}
                >
                  {i}
                </button>
              ))}
              <PagerSpacers count={PAGER_CENTER} prefix="post" />
            </div>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Keyboard area with toolbar */}
      <div
        className="flex items-start gap-2 overflow-auto"
        style={!typingTestMode && keyboardAreaMinHeight ? { minHeight: keyboardAreaMinHeight } : undefined}
        onClick={!typingTestMode ? handleDeselectClick : undefined}
      >
        {panelSide === 'left' && toolbar}
        <div className={typingTestMode
          ? 'flex min-w-0 flex-1 flex-col gap-3'
          : 'flex min-w-0 flex-1 items-center justify-center gap-4 overflow-auto'
        }>
          {typingTestMode && (
            <TypingTestView
              state={typingTest.state}
              wpm={typingTest.wpm}
              accuracy={typingTest.accuracy}
              elapsedSeconds={typingTest.elapsedSeconds}
              remainingSeconds={typingTest.remainingSeconds}
              config={typingTest.config}
              paused={typingTest.state.status === 'running' && !typingTest.windowFocused}
              onRestart={restartTypingTest}
              onConfigChange={handleTypingTestConfigChange}
              onCompositionStart={typingTest.processCompositionStart}
              onCompositionUpdate={typingTest.processCompositionUpdate}
              onCompositionEnd={typingTest.processCompositionEnd}
              onImeSpaceKey={() => typingTest.processKeyEvent(' ', false, false, false)}
            />
          )}
          {typingTestMode ? (
            <>
              <div className="flex items-start justify-center overflow-auto">
                <div>
                  <div className="mb-3 flex items-center justify-between px-5">
                    <div className="flex items-center gap-4">
                      {layers > 1 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm text-content-muted">{t('editor.typingTest.baseLayer')}:</span>
                          <select
                            data-testid="base-layer-select"
                            aria-label={t('editor.typingTest.baseLayer')}
                            value={typingTest.baseLayer}
                            onChange={(e) => typingTest.setBaseLayer(Number(e.target.value))}
                            className="rounded-md border border-edge bg-surface-alt px-2 py-1 text-sm text-content-secondary"
                          >
                            {Array.from({ length: layers }, (_, i) => (
                              <option key={i} value={i}>
                                {layerNames?.[i] || i}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {typingTest.config.mode !== 'quote' && (
                        <button
                          type="button"
                          data-testid="language-selector"
                          className="flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-sm text-content-secondary transition-colors hover:text-content"
                          onClick={() => setShowLanguageModal(true)}
                          disabled={typingTest.isLanguageLoading}
                        >
                          {typingTest.isLanguageLoading ? (
                            <span>{t('editor.typingTest.language.loadingLanguage')}</span>
                          ) : (
                            <>
                              <Globe size={14} aria-hidden="true" />
                              <span>{typingTest.language.replace(/_/g, ' ')}</span>
                            </>
                          )}
                        </button>
                      )}
                      {showLanguageModal && (
                        <LanguageSelectorModal
                          currentLanguage={typingTest.language}
                          onSelectLanguage={handleTypingTestLanguageChange}
                          onClose={() => setShowLanguageModal(false)}
                        />
                      )}
                    </div>
                    {typingTestHistory && typingTestHistory.length > 0 && (
                      <HistoryToggle results={typingTestHistory} deviceName={deviceName} />
                    )}
                  </div>
                  <KeyboardPane
                    paneId="primary"
                    isActive={false}
                    isDualMode={false}
                    keys={layout.keys}
                    keycodes={typingTestKeycodes}
                    encoderKeycodes={typingTestEncoderKeycodes}
                    selectedKey={null}
                    selectedEncoder={null}
                    selectedMaskPart={false}
                    selectedKeycode={null}
                    pressedKeys={pressedKeys}
                    everPressedKeys={undefined}
                    remappedKeys={typingTestRemapped}
                    layoutOptions={effectiveLayoutOptions}
                    scale={scaleProp}
                    layerLabel={layerLabel(typingTest.effectiveLayer)}
                    layerLabelTestId="layer-label"
                    contentRef={keyboardContentRef}
                  />
                </div>
              </div>
              <p data-testid="typing-test-layer-note" className="text-center text-xs text-content-muted">
                {t('editor.typingTest.layerNote')}
              </p>
            </>
          ) : (
            <>
              <KeyboardPane
                paneId="primary"
                isActive={activePane === 'primary'}
                isDualMode={dualMode ?? false}
                keys={layout.keys}
                keycodes={primaryKeycodes}
                encoderKeycodes={primaryEncoderKeycodes}
                selectedKey={selectedKey}
                selectedEncoder={selectedEncoder}
                selectedMaskPart={selectedMaskPart}
                selectedKeycode={selectedKeycode}
                pressedKeys={matrixMode ? pressedKeys : undefined}
                everPressedKeys={matrixMode ? everPressedKeys : undefined}
                remappedKeys={primaryRemapped}
                multiSelectedKeys={selectionSourcePane === 'primary' ? multiSelectedKeys : undefined}
                layoutOptions={effectiveLayoutOptions}
                scale={scaleProp}
                layerLabel={layerLabel(effectivePrimaryLayer)}
                layerLabelTestId="layer-label"
                onKeyClick={handleKeyClick}
                onKeyDoubleClick={handleKeyDoubleClick}
                onEncoderClick={handleEncoderClick}
                onEncoderDoubleClick={handleEncoderDoubleClick}
                onCopyAll={showCopyAll && activePane === 'primary' ? handleCopyAllClick : undefined}
                copyAllPending={activePane === 'primary' && dualMode && copyAllPending ? copyAllConfirmText : undefined}
                isCopying={isCopying}
                pasteHint={activePane === 'primary' ? pasteHintText : undefined}
                onDeselect={handleDeselect}
                onActivate={() => onActivePaneChange?.('primary')}
                contentRef={keyboardContentRef}
              />

              {dualMode && (
                <KeyboardPane
                  paneId="secondary"
                  isActive={activePane === 'secondary'}
                  isDualMode={true}
                  keys={layout.keys}
                  keycodes={secondaryKeycodes}
                  encoderKeycodes={secondaryEncoderKeycodes}
                  selectedKey={selectedKey}
                  selectedEncoder={selectedEncoder}
                  selectedMaskPart={selectedMaskPart}
                  selectedKeycode={selectedKeycode}
                  pressedKeys={matrixMode ? pressedKeys : undefined}
                  everPressedKeys={matrixMode ? everPressedKeys : undefined}
                  remappedKeys={secondaryRemapped}
                  multiSelectedKeys={selectionSourcePane === 'secondary' ? multiSelectedKeys : undefined}
                  layoutOptions={effectiveLayoutOptions}
                  scale={scaleProp}
                  layerLabel={layerLabel(effectiveSecondaryLayer)}
                  layerLabelTestId="secondary-layer-label"
                  onKeyClick={handleKeyClick}
                  onKeyDoubleClick={handleKeyDoubleClick}
                  onEncoderClick={handleEncoderClick}
                  onEncoderDoubleClick={handleEncoderDoubleClick}
                  onCopyAll={showCopyAll && activePane === 'secondary' ? handleCopyAllClick : undefined}
                  copyAllPending={activePane === 'secondary' && dualMode && copyAllPending ? copyAllConfirmText : undefined}
                  isCopying={isCopying}
                  pasteHint={activePane === 'secondary' ? pasteHintText : undefined}
                  onDeselect={handleDeselect}
                  onActivate={() => onActivePaneChange?.('secondary')}
                />
              )}
            </>
          )}
        </div>
        {panelSide === 'right' && toolbar}
      </div>

      {!typingTestMode && popoverState && (
        <PopoverForState
          popoverState={popoverState}
          keymap={keymap}
          encoderLayout={encoderLayout}
          currentLayer={currentLayer}
          layers={layers}
          onKeycodeSelect={handlePopoverKeycodeSelect}
          onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
          onModMaskChange={popoverState.kind === 'key' ? handlePopoverModMaskChange : undefined}
          onClose={() => setPopoverState(null)}
        />
      )}

      {/* Keycode palette */}
      {!typingTestMode && (
        <div className="flex min-h-0 flex-1 gap-2">
          {!isDummy && onLayerChange && layers > 1 && (
            <LayerListPanel
              layers={layers}
              currentLayer={currentLayer}
              onLayerChange={onLayerChange}
              layerNames={layerNames}
              onSetLayerName={onSetLayerName}
              collapsed={layerPanelCollapsed}
              onToggleCollapse={toggleLayerPanel}
            />
          )}
          <TabbedKeycodes
            onKeycodeSelect={handleKeycodeSelect}
            onKeycodeMultiSelect={handlePickerMultiSelect}
            pickerSelectedKeycodes={pickerSelectedSet}
            onBackgroundClick={handleDeselect}
            highlightedKeycodes={configuredKeycodes}
            maskOnly={isMaskKey}
            lmMode={isLMMask}
            showHint={!isMaskKey}
            tabFooterContent={tabFooterContent}
            tabBarRight={hasLayoutOptions ? (
              <IconTooltip label={t('editor.layout.options')} side="top-end">
                <button
                  ref={layoutButtonRef}
                  type="button"
                  aria-label={t('editor.layout.options')}
                  aria-expanded={layoutPanelOpen}
                  aria-controls="layout-options-panel"
                  className={`rounded p-1 transition-colors ${
                    layoutPanelOpen
                      ? 'bg-surface-dim text-accent'
                      : 'text-content-secondary hover:bg-surface-dim hover:text-content'
                  }`}
                  onClick={() => setLayoutPanelOpen((prev) => !prev)}
                >
                  <LayoutList size={16} aria-hidden="true" />
                </button>
              </IconTooltip>
            ) : undefined}
            panelOverlay={hasLayoutOptions ? (
              <div
                id="layout-options-panel"
                ref={layoutPanelRef}
                className={`absolute inset-y-0 right-0 z-10 w-fit overflow-y-auto rounded-l-lg rounded-r-[10px] border-l border-edge-subtle bg-surface-alt shadow-lg transition-transform duration-200 ease-out ${
                  layoutPanelOpen ? 'translate-x-0' : 'translate-x-full'
                }`}
                inert={!layoutPanelOpen || undefined}
              >
                <LayoutOptionsPanel
                  options={parsedOptions}
                  values={layoutValues}
                  onChange={handleLayoutOptionChange}
                />
              </div>
            ) : undefined}
          />
        </div>
      )}

      {tdModalIndex !== null && tapDanceEntries && onSetTapDanceEntry && (
        <TapDanceModal
          index={tdModalIndex}
          entry={tapDanceEntries[tdModalIndex]}
          onSave={handleTdModalSave}
          onClose={handleTdModalClose}
          isDummy={isDummy}
        />
      )}

      {macroModalIndex !== null && macroBuffer && macroCount != null && onSaveMacros && (
        <MacroModal
          index={macroModalIndex}
          macroCount={macroCount}
          macroBufferSize={macroBufferSize ?? 0}
          macroBuffer={macroBuffer}
          vialProtocol={vialProtocol ?? 0}
          onSaveMacros={onSaveMacros}
          onClose={handleMacroModalClose}
          unlocked={unlocked}
          onUnlock={onUnlock}
          isDummy={isDummy}
        />
      )}

      {supportedQsids && qmkSettingsGet && qmkSettingsSet && qmkSettingsReset && (
        <>
          {showTapHoldSettings && tapHoldSupported && (
            <SettingsModal
              title={t('editor.keymap.tapHoldSettings')}
              testidPrefix="tap-hold-settings"
              tabName="Tap-Hold"
              supportedQsids={supportedQsids}
              qmkSettingsGet={qmkSettingsGet}
              qmkSettingsSet={qmkSettingsSet}
              qmkSettingsReset={qmkSettingsReset}
              onSettingsUpdate={onSettingsUpdate}
              onClose={() => setShowTapHoldSettings(false)}
            />
          )}

          {showMouseKeysSettings && mouseKeysSupported && (
            <SettingsModal
              title={t('editor.keymap.mouseKeysSettings')}
              testidPrefix="mouse-keys-settings"
              tabName="Mouse keys"
              supportedQsids={supportedQsids}
              qmkSettingsGet={qmkSettingsGet}
              qmkSettingsSet={qmkSettingsSet}
              qmkSettingsReset={qmkSettingsReset}
              onSettingsUpdate={onSettingsUpdate}
              onClose={() => setShowMouseKeysSettings(false)}
            />
          )}

          {showMagicSettings && magicSupported && (
            <SettingsModal
              title={t('editor.keymap.magicSettings')}
              testidPrefix="magic-settings"
              tabName="Magic"
              supportedQsids={supportedQsids}
              qmkSettingsGet={qmkSettingsGet}
              qmkSettingsSet={qmkSettingsSet}
              qmkSettingsReset={qmkSettingsReset}
              onSettingsUpdate={onSettingsUpdate}
              onClose={() => setShowMagicSettings(false)}
            />
          )}

          {showGraveEscapeSettings && graveEscapeSupported && (
            <SettingsModal
              title={t('editor.keymap.graveEscapeSettings')}
              testidPrefix="grave-escape-settings"
              tabName="Grave Escape"
              supportedQsids={supportedQsids}
              qmkSettingsGet={qmkSettingsGet}
              qmkSettingsSet={qmkSettingsSet}
              qmkSettingsReset={qmkSettingsReset}
              onSettingsUpdate={onSettingsUpdate}
              onClose={() => setShowGraveEscapeSettings(false)}
            />
          )}

          {showAutoShiftSettings && autoShiftSupported && (
            <SettingsModal
              title={t('editor.keymap.autoShiftSettings')}
              testidPrefix="auto-shift-settings"
              tabName="Auto Shift"
              supportedQsids={supportedQsids}
              qmkSettingsGet={qmkSettingsGet}
              qmkSettingsSet={qmkSettingsSet}
              qmkSettingsReset={qmkSettingsReset}
              onSettingsUpdate={onSettingsUpdate}
              onClose={() => setShowAutoShiftSettings(false)}
            />
          )}

          {showOneShotKeysSettings && oneShotKeysSupported && (
            <SettingsModal
              title={t('editor.keymap.oneShotKeysSettings')}
              testidPrefix="one-shot-keys-settings"
              tabName="One Shot Keys"
              supportedQsids={supportedQsids}
              qmkSettingsGet={qmkSettingsGet}
              qmkSettingsSet={qmkSettingsSet}
              qmkSettingsReset={qmkSettingsReset}
              onSettingsUpdate={onSettingsUpdate}
              onClose={() => setShowOneShotKeysSettings(false)}
            />
          )}
        </>
      )}
    </div>
  )
})

function historyToggleClass(active: boolean): string {
  const base = 'rounded-md border px-3 py-1 text-sm transition-colors'
  if (active) return `${base} border-accent bg-accent/10 text-accent`
  return `${base} border-edge text-content-secondary hover:text-content`
}

interface HistoryToggleProps {
  results: TypingTestResult[]
  deviceName?: string
}

function HistoryToggle({ results, deviceName }: HistoryToggleProps) {
  const { t } = useTranslation()
  const [showHistory, setShowHistory] = useState(false)

  const handleExportCsv = useCallback((csv: string) => {
    const prefix = deviceName ? `${deviceName}_typing-test-history` : undefined
    window.vialAPI.exportCsv(csv, prefix)
  }, [deviceName])

  return (
    <>
      <button
        type="button"
        data-testid="typing-test-history-toggle"
        className={historyToggleClass(showHistory)}
        onClick={() => setShowHistory((v) => !v)}
        aria-label={t('editor.typingTest.history.title')}
        aria-pressed={showHistory}
        title={t('editor.typingTest.history.title')}
      >
        {t('editor.typingTest.history.title')}
      </button>
      {showHistory && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          data-testid="history-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="history-modal-title"
          onClick={() => setShowHistory(false)}
        >
          <div
            className="flex h-[80vh] w-[900px] max-w-[90vw] flex-col rounded-lg bg-surface-alt p-6 shadow-xl"
            data-testid="history-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 id="history-modal-title" className="text-lg font-semibold">{t('editor.typingTest.history.title')}</h3>
              <ModalCloseButton testid="history-modal-close" onClick={() => setShowHistory(false)} />
            </div>
            <TypingTestHistory results={results} onExportCsv={handleExportCsv} />
          </div>
        </div>
      )}
    </>
  )
}
