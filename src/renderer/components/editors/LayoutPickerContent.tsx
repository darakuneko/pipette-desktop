// SPDX-License-Identifier: GPL-2.0-or-later

// Presentational body of the picker panel's "Keyboard" tab — device/file
// browse views plus the keyboard-as-keycode-picker itself. Pure props in,
// JSX out; all state and handlers live in `useLayoutPicker`.

import type { KleKey } from '../../../shared/kle/types'
import type { DeviceInfo } from '../../../shared/types/protocol'
import type { StoredKeyboardInfo } from '../../../shared/types/sync'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'
import { KeyboardPane } from './KeyboardPane'
import { Tooltip } from '../ui/Tooltip'
import { ScaleInput, ghostZoomButtonClass } from './keymap-editor-toolbar'
import { MIN_SCALE, MAX_SCALE } from './keymap-editor-types'
import { ZoomIn, ZoomOut } from 'lucide-react'
import { ICON_SM } from '../../constants/ui-tokens'
import type { PickerData, PickerFileData } from './keymap-editor-types'
import { useTranslation } from 'react-i18next'

const layerBtnClass = (active: boolean) =>
  `min-w-7 max-w-20 shrink-0 truncate rounded-md border px-1.5 py-1 text-center text-xs font-semibold tabular-nums transition-colors ${
    active ? 'border-accent bg-accent text-content-inverse' : 'border-edge bg-surface/20 text-content-muted hover:bg-surface-dim'
  }`
const sourceBtnClass = (active: boolean) =>
  `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
    active ? 'bg-surface-dim text-content' : 'text-content-muted hover:text-content hover:bg-surface-dim/50'
  }`

export interface LayoutPickerContentProps {
  pickerSource: 'file' | 'device'
  deviceBrowsing: boolean
  probeStatus: 'idle' | 'probing' | 'error'
  devices?: DeviceInfo[]
  isConnectedDevice: (d: DeviceInfo) => boolean
  handleDeviceSelect: (d: DeviceInfo) => void
  pickerLoadError: string | null
  fileBrowseView: 'list' | 'entries'
  setFileBrowseView: (view: 'list' | 'entries') => void
  setSelectedFileUid: (uid: string | null) => void
  setPickerLoadError: (error: string | null) => void
  storedKeyboards: StoredKeyboardInfo[]
  selectedFileUid: string | null
  storedEntries: SnapshotMeta[]
  handleLoadSnapshotEntry: (uid: string, entryId: string) => void
  handleLoadPickerFile: () => void
  pickerContainerRef: React.RefObject<HTMLDivElement | null>
  pickerData: PickerData
  activPickerKeycodes: Map<string, string>
  pickerHighlightPositions: Set<string> | undefined
  pickerEffectiveScale: number
  pickerLayer: number
  pickerFileData: PickerFileData
  handlePickerKeyClick: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  handlePickerHover: (key: KleKey, keycode: string, rect: DOMRect) => void
  handlePickerHoverEnd: () => void
  pickerTooltip: { keycode: string; top: number; left: number } | null
  setPickerSource: (source: 'file' | 'device') => void
  setPickerLayer: (layer: number) => void
  setPickerFileData: (data: PickerFileData) => void
  setPickerScale: (scale: number | undefined) => void
  setDeviceBrowsing: (browsing: boolean) => void
  setProbeStatus: (status: 'idle' | 'probing' | 'error') => void
  pickerBrowseMode: boolean
  onScaleChange?: (delta: number) => void
  clearPickerSelection: () => void
}

export function LayoutPickerContent({
  pickerSource, deviceBrowsing, probeStatus, devices, isConnectedDevice, handleDeviceSelect,
  pickerLoadError, fileBrowseView, setFileBrowseView, setSelectedFileUid, setPickerLoadError,
  storedKeyboards, selectedFileUid, storedEntries, handleLoadSnapshotEntry, handleLoadPickerFile,
  pickerContainerRef, pickerData, activPickerKeycodes, pickerHighlightPositions, pickerEffectiveScale,
  pickerLayer, pickerFileData, handlePickerKeyClick, handlePickerHover, handlePickerHoverEnd, pickerTooltip,
  setPickerSource, setPickerLayer, setPickerFileData, setPickerScale, setDeviceBrowsing, setProbeStatus,
  pickerBrowseMode, onScaleChange, clearPickerSelection,
}: LayoutPickerContentProps) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {pickerSource === 'device' && deviceBrowsing ? (
          /* --- Device browse view --- */
          <div className="mx-auto flex w-full max-w-md flex-col px-3 py-3">
            <div className="flex min-h-device-list max-h-device-list flex-col gap-1.5 overflow-y-auto pb-2 pr-1">
              <span className="mb-1 text-xs text-content-secondary">{t('editor.keymap.pickerCurrentState')}</span>
              {probeStatus === 'probing' ? (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerProbing')}</p>
              ) : probeStatus === 'error' ? (
                <p className="py-4 text-center text-xs text-danger">{t('editor.keymap.pickerProbeError')}</p>
              ) : devices?.length ? devices.map((d) => (
                <button key={`${d.vendorId}:${d.productId}:${d.serialNumber}`} type="button"
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-surface-dim ${isConnectedDevice(d) ? 'border-accent/40 bg-accent/5' : 'border-edge'}`}
                  onClick={() => handleDeviceSelect(d)}>
                  <span className="font-medium text-content">{d.productName || `${d.vendorId.toString(16)}:${d.productId.toString(16)}`}</span>
                  <span className="text-xs text-content-muted">›</span>
                </button>
              )) : (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerNoDevices')}</p>
              )}
            </div>
            <div className="mt-2 rounded-lg border border-dashed border-transparent px-3 py-2 text-center text-xs invisible">&#8203;</div>
          </div>
        ) : pickerSource === 'file' && !pickerFileData ? (
          /* --- File browse view --- */
          <div className="mx-auto flex w-full max-w-md flex-col px-3 py-3">
            <div className="flex min-h-device-list max-h-device-list flex-col gap-1.5 overflow-y-auto pb-2 pr-1">
            {pickerLoadError && (
              <div className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
                {pickerLoadError}
              </div>
            )}
            {fileBrowseView === 'list' && (
              <span className="mb-1 text-xs text-content-secondary">{t('editor.keymap.pickerSavedFiles')}</span>
            )}
            {fileBrowseView === 'entries' && (
              <button type="button" className="mb-2 self-start text-xs text-content-secondary hover:text-content"
                onClick={() => { setFileBrowseView('list'); setSelectedFileUid(null); setPickerLoadError(null) }}>
                ← {t('common.back')}
              </button>
            )}
            {fileBrowseView === 'list' ? (
              storedKeyboards.length > 0 ? storedKeyboards.map((kb) => (
                <button key={kb.uid} type="button"
                  className="flex items-center justify-between rounded-lg border border-edge px-3 py-2 text-left text-sm transition-colors hover:bg-surface-dim"
                  onClick={() => { setSelectedFileUid(kb.uid); setFileBrowseView('entries'); setPickerLoadError(null) }}>
                  <span className="font-medium text-content">{kb.name}</span>
                  <span className="text-xs text-content-muted">›</span>
                </button>
              )) : (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerNoSavedFiles')}</p>
              )
            ) : (
              storedEntries.length > 0 ? storedEntries.map((entry) => (
                <button key={entry.id} type="button"
                  className="flex flex-col rounded-lg border border-edge px-3 py-2 text-left text-sm transition-colors hover:bg-surface-dim"
                  onClick={() => handleLoadSnapshotEntry(selectedFileUid!, entry.id)}>
                  <span className="font-medium text-content">{entry.label || entry.filename}</span>
                  <span className="text-xs text-content-muted">{new Date(entry.savedAt).toLocaleString()}</span>
                </button>
              )) : (
                <p className="py-4 text-center text-xs text-content-muted">{t('editor.keymap.pickerNoEntries')}</p>
              )
            )}
            </div>
            <button type="button"
              className="mt-2 rounded-lg border border-dashed border-edge px-3 py-2 text-center text-xs text-content-muted transition-colors hover:border-edge hover:bg-surface-dim hover:text-content"
              onClick={handleLoadPickerFile}>
              {t('editor.keymap.pickerLoadFile')}
            </button>
          </div>
        ) : (
          /* --- Keyboard view (current / loaded file / probed device) --- */
          <div ref={pickerContainerRef} className="picker-hover-keys relative flex h-full min-h-0 items-center justify-center">
            <KeyboardPane
              paneId="secondary" isActive={true}              keys={pickerData.keys} keycodes={activPickerKeycodes} encoderKeycodes={pickerData.encoderKeycodes}
              selectedKey={null} selectedEncoder={null} selectedMaskPart={false} selectedKeycode={null}
              remappedKeys={pickerData.remapped} multiSelectedKeys={pickerHighlightPositions}
              layoutOptions={pickerData.layoutOpts} scale={pickerEffectiveScale}
              layerLabel={(pickerData.names?.[pickerLayer] || t('editor.keymap.layerN', { n: pickerLayer })) + (pickerFileData ? ` — ${pickerFileData.name}` : '')}
              layerLabelTestId="picker-layer-label"
              onKeyClick={handlePickerKeyClick}
              onKeyHover={handlePickerHover}
              onKeyHoverEnd={handlePickerHoverEnd}
            />
            {pickerTooltip && (
              <div
                className="pointer-events-none absolute z-50 rounded-md border border-edge bg-surface-alt px-2.5 py-1.5 shadow-lg"
                style={{ top: pickerTooltip.top - 4, left: pickerTooltip.left, transform: 'translate(-50%, -100%)' }}
              >
                <div className="text-2xs leading-snug text-content-muted whitespace-nowrap">{pickerTooltip.keycode}</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between px-2 pb-1">
        <div className="flex items-center gap-1">
          <button type="button" className={sourceBtnClass(pickerSource === 'device')}
            onClick={() => {
              setPickerSource('device'); setPickerLayer(0); setPickerFileData(null); setPickerScale(undefined); setDeviceBrowsing(true); setProbeStatus('idle'); setPickerLoadError(null)
            }}>
            {pickerSource === 'device' && !deviceBrowsing
              ? t('editor.keymap.pickerBackToDevices')
              : t('editor.keymap.pickerSourceDevice')}
          </button>
          <button type="button" className={sourceBtnClass(pickerSource === 'file')}
            onClick={() => { setPickerSource('file'); setPickerLayer(0); setPickerFileData(null); setPickerScale(undefined); setFileBrowseView('list'); setDeviceBrowsing(false); setPickerLoadError(null) }}>
            {pickerSource === 'file' && pickerFileData ? t('editor.keymap.pickerBackToFiles') : t('editor.keymap.pickerSourceFile')}
          </button>
        </div>
        <div className={`flex items-center gap-1 ${pickerBrowseMode ? 'invisible' : ''}`}>
          <Tooltip content={t('editor.keymap.zoomOut')}>
            <button type="button" aria-label={t('editor.keymap.zoomOut')}
              className={ghostZoomButtonClass}
              disabled={pickerEffectiveScale <= MIN_SCALE}
              onClick={() => { if (pickerFileData) setPickerScale(Math.max(MIN_SCALE, +(pickerEffectiveScale - 0.1).toFixed(1))); else onScaleChange?.(-0.1) }}>
              <ZoomOut size={ICON_SM} aria-hidden="true" />
            </button>
          </Tooltip>
          <ScaleInput scale={pickerEffectiveScale} onScaleChange={(delta) => {
            if (pickerFileData) setPickerScale(Math.max(MIN_SCALE, Math.min(MAX_SCALE, +(pickerEffectiveScale + delta).toFixed(1))))
            else onScaleChange?.(delta)
          }} />
          <Tooltip content={t('editor.keymap.zoomIn')}>
            <button type="button" aria-label={t('editor.keymap.zoomIn')}
              className={ghostZoomButtonClass}
              disabled={pickerEffectiveScale >= MAX_SCALE}
              onClick={() => { if (pickerFileData) setPickerScale(Math.min(MAX_SCALE, +(pickerEffectiveScale + 0.1).toFixed(1))); else onScaleChange?.(0.1) }}>
              <ZoomIn size={ICON_SM} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        <div className={`flex min-w-0 items-center gap-1 overflow-x-auto ${pickerBrowseMode ? 'invisible' : ''}`}>
          {Array.from({ length: pickerData.totalLayers }, (_, i) => {
            const label = pickerData.names?.[i]?.trim()
            return (
              <Tooltip key={i} content={label} disabled={!label}>
                <button type="button" className={layerBtnClass(pickerLayer === i)}
                  onClick={() => { setPickerLayer(i); clearPickerSelection() }}>
                  {label || i}
                </button>
              </Tooltip>
            )
          })}
        </div>
      </div>
    </div>
  )
}
