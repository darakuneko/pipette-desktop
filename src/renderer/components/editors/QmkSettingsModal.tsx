// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { QmkSettings } from './QmkSettings'
import { ModalCloseButton } from './ModalCloseButton'

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
  useEscapeClose(onClose)
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

interface QmkSettingsModalDef {
  key: string
  testidPrefix: string
  titleKey: string
  tabName: string
}

const SETTINGS_MODAL_DEFS: QmkSettingsModalDef[] = [
  { key: 'tapHold', testidPrefix: 'tap-hold-settings', titleKey: 'editor.keymap.tapHoldSettings', tabName: 'Tap-Hold' },
  { key: 'mouseKeys', testidPrefix: 'mouse-keys-settings', titleKey: 'editor.keymap.mouseKeysSettings', tabName: 'Mouse keys' },
  { key: 'magic', testidPrefix: 'magic-settings', titleKey: 'editor.keymap.magicSettings', tabName: 'Magic' },
  { key: 'graveEscape', testidPrefix: 'grave-escape-settings', titleKey: 'editor.keymap.graveEscapeSettings', tabName: 'Grave Escape' },
  { key: 'autoShift', testidPrefix: 'auto-shift-settings', titleKey: 'editor.keymap.autoShiftSettings', tabName: 'Auto Shift' },
  { key: 'oneShotKeys', testidPrefix: 'one-shot-keys-settings', titleKey: 'editor.keymap.oneShotKeysSettings', tabName: 'One Shot Keys' },
  { key: 'combo', testidPrefix: 'combo-settings', titleKey: 'editor.keymap.comboSettings', tabName: 'Combo' },
]

export interface QmkSettingsModalsProps {
  supportedQsids: Set<number>
  qmkSettingsGet: (qsid: number) => Promise<number[]>
  qmkSettingsSet: (qsid: number, data: number[]) => Promise<void>
  qmkSettingsReset: () => Promise<void>
  onSettingsUpdate?: (qsid: number, data: number[]) => void
  visibleModals: Record<string, boolean>
  onCloseModal: (key: string) => void
}

export function QmkSettingsModals({
  supportedQsids,
  qmkSettingsGet,
  qmkSettingsSet,
  qmkSettingsReset,
  onSettingsUpdate,
  visibleModals,
  onCloseModal,
}: QmkSettingsModalsProps) {
  const { t } = useTranslation()
  return (
    <>
      {SETTINGS_MODAL_DEFS.map((def) =>
        visibleModals[def.key] ? (
          <SettingsModal
            key={def.key}
            title={t(def.titleKey)}
            testidPrefix={def.testidPrefix}
            tabName={def.tabName}
            supportedQsids={supportedQsids}
            qmkSettingsGet={qmkSettingsGet}
            qmkSettingsSet={qmkSettingsSet}
            qmkSettingsReset={qmkSettingsReset}
            onSettingsUpdate={onSettingsUpdate}
            onClose={() => onCloseModal(def.key)}
          />
        ) : null,
      )}
    </>
  )
}
